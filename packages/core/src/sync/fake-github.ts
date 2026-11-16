// An in-memory GitHub REST API behind a fetch function, for tests: the endpoints sync uses (issues and milestones,
// read and write; PRs with their files and reviews, read only), ETags (304 on a matching if-none-match), a clock that
// moves on every write, and a request log so tests can check what was sent.
import { createHash } from "node:crypto";
import type { RawIssue, RawMilestone, RawPull } from "./github.ts";

export interface FakeRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: any;
}

export interface FakeGitHubOptions {
  base?: string;
  repo?: string;
  token?: string;
}

export class FakeGitHub {
  readonly base: string;
  readonly repo: string;
  readonly token: string;
  issues: RawIssue[] = [];
  milestones: RawMilestone[] = [];
  pulls: RawPull[] = [];
  files = new Map<number, string[]>();
  reviews = new Map<number, { state: string }[]>();
  requests: FakeRequest[] = [];
  /** Make every request fail with this status (and optional headers) until cleared. */
  failWith: { status: number; message?: string; headers?: Record<string, string> } | null = null;
  /** Fail only requests whose "METHOD path" matches. */
  failOn: { match: RegExp; status: number; message?: string } | null = null;
  #nextNumber = 1;
  #clock = Date.parse("2026-10-01T00:00:00Z");

  constructor(o: FakeGitHubOptions = {}) {
    this.base = o.base ?? "https://gh.test";
    this.repo = o.repo ?? "acme/odin";
    this.token = o.token ?? "ghp_faketoken1234567890";
  }

  /** A strictly later timestamp on every call, like GitHub's updated_at after an edit. */
  tick(): string {
    this.#clock += 60_000;
    return new Date(this.#clock).toISOString().replace(".000Z", "Z");
  }

  addIssue(partial: Partial<RawIssue> & { title: string }): RawIssue {
    const number = partial.number ?? this.#nextNumber;
    this.#nextNumber = Math.max(this.#nextNumber, number + 1);
    const at = partial.updated_at ?? this.tick();
    const issue: RawIssue = {
      number,
      node_id: `I_${number}`,
      state: "open",
      state_reason: null,
      labels: [],
      milestone: null,
      html_url: `https://github.com/${this.repo}/issues/${number}`,
      created_at: at,
      updated_at: at,
      closed_at: null,
      body: "",
      ...partial,
    };
    this.issues.push(issue);
    return issue;
  }

  /** A remote edit: as if someone changed the issue on github.com. */
  editIssue(number: number, patch: Record<string, unknown>): RawIssue {
    const issue = this.issues.find((i) => i.number === number)!;
    this.#applyIssue(issue, patch);
    return issue;
  }

  addMilestone(partial: Partial<RawMilestone> & { title: string }): RawMilestone {
    const number = partial.number ?? this.#nextNumber++;
    this.#nextNumber = Math.max(this.#nextNumber, number + 1);
    const at = partial.updated_at ?? this.tick();
    const m: RawMilestone = {
      number,
      description: "",
      state: "open",
      due_on: null,
      html_url: `https://github.com/${this.repo}/milestone/${number}`,
      created_at: at,
      updated_at: at,
      ...partial,
    };
    this.milestones.push(m);
    return m;
  }

  editMilestone(number: number, patch: Record<string, unknown>): RawMilestone {
    const m = this.milestones.find((x) => x.number === number)!;
    Object.assign(m, patch, { updated_at: this.tick() });
    return m;
  }

  addPull(partial: Partial<RawPull> & { number: number; head: { ref: string } }, files: string[] = [], reviews: string[] = []): RawPull {
    const at = partial.updated_at ?? this.tick();
    const pr: RawPull = {
      title: `PR ${partial.number}`,
      body: "",
      state: "open",
      html_url: `https://github.com/${this.repo}/pull/${partial.number}`,
      merged_at: null,
      labels: [],
      created_at: at,
      updated_at: at,
      ...partial,
    };
    this.pulls.push(pr);
    this.files.set(pr.number, files);
    this.reviews.set(pr.number, reviews.map((state) => ({ state })));
    return pr;
  }

  /** A remote PR change (merged, closed, new reviews): bumps updated_at so the next pull refetches it. */
  editPull(number: number, patch: Partial<RawPull>, reviews?: string[]): RawPull {
    const pr = this.pulls.find((p) => p.number === number)!;
    Object.assign(pr, patch, { updated_at: this.tick() });
    if (reviews) this.reviews.set(number, reviews.map((state) => ({ state })));
    return pr;
  }

  issue(number: number): RawIssue | undefined {
    return this.issues.find((i) => i.number === number);
  }

  get fetch(): typeof fetch {
    return (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = (init.method ?? "GET").toUpperCase();
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      this.requests.push({ method, url, headers, body });
      return this.#handle(method, new URL(url), headers, body);
    }) as typeof fetch;
  }

  /** Requests other than GETs, as "METHOD /path" (for asserting what was pushed). */
  writes(): string[] {
    return this.requests.filter((r) => r.method !== "GET").map((r) => `${r.method} ${new URL(r.url).pathname}`);
  }

  #applyIssue(issue: RawIssue, patch: Record<string, any>): void {
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = patch.body;
    if (patch.labels !== undefined) issue.labels = (patch.labels as string[]).map((name) => ({ name }));
    if (patch.milestone !== undefined) {
      const m = this.milestones.find((x) => x.number === patch.milestone);
      issue.milestone = m ? { number: m.number, title: m.title } : null;
    }
    if (patch.state !== undefined && patch.state !== issue.state) {
      issue.state = patch.state;
      issue.closed_at = patch.state === "closed" ? this.tick() : null;
    }
    if (patch.state_reason !== undefined) issue.state_reason = patch.state_reason;
    issue.updated_at = this.tick();
  }

  #json(status: number, data: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
  }

  /** 200 with an ETag, or 304 when the client's if-none-match matches. */
  #cached(reqHeaders: Record<string, string>, data: unknown, headers: Record<string, string> = {}): Response {
    const etag = `"${createHash("sha1").update(JSON.stringify(data)).digest("hex")}"`;
    if (reqHeaders["if-none-match"] === etag) return new Response(null, { status: 304, headers: { etag } });
    return this.#json(200, data, { etag, ...headers });
  }

  #page<T>(url: URL, reqHeaders: Record<string, string>, items: T[]): Response {
    const per = Number(url.searchParams.get("per_page") ?? 30);
    const page = Number(url.searchParams.get("page") ?? 1);
    const slice = items.slice((page - 1) * per, page * per);
    const headers: Record<string, string> = {};
    if (page * per < items.length) {
      const next = new URL(url);
      next.searchParams.set("page", String(page + 1));
      headers.link = `<${next}>; rel="next"`;
    }
    return this.#cached(reqHeaders, slice, headers);
  }

  #handle(method: string, url: URL, headers: Record<string, string>, body: any): Response {
    if (headers.authorization !== `Bearer ${this.token}`) return this.#json(401, { message: "Bad credentials" });
    if (this.failWith) return this.#json(this.failWith.status, { message: this.failWith.message ?? "boom" }, this.failWith.headers);
    const path = url.pathname;
    if (this.failOn && this.failOn.match.test(`${method} ${path}`)) {
      return this.#json(this.failOn.status, { message: this.failOn.message ?? "boom" });
    }

    if (!path.startsWith(`/repos/${this.repo}/`)) return this.#json(404, { message: "Not Found" });
    const rest = path.slice(`/repos/${this.repo}`.length);
    let m: RegExpExecArray | null;

    if (method === "GET" && rest === "/issues") {
      const state = url.searchParams.get("state") ?? "open";
      const since = url.searchParams.get("since");
      const asc = url.searchParams.get("direction") === "asc";
      const items = this.issues
        .filter((i) => (state === "all" || i.state === state) && (!since || i.updated_at >= since))
        .sort((a, b) => (asc ? a.updated_at.localeCompare(b.updated_at) : b.updated_at.localeCompare(a.updated_at)));
      return this.#page(url, headers, items);
    }
    if (method === "POST" && rest === "/issues") {
      if (body.milestone !== undefined && body.milestone !== null && !this.milestones.some((x) => x.number === body.milestone)) {
        return this.#json(422, { message: "Validation Failed" });
      }
      const issue = this.addIssue({ title: body.title });
      this.#applyIssue(issue, { body: body.body ?? "", labels: body.labels ?? [], milestone: body.milestone ?? null });
      return this.#json(201, issue);
    }
    m = /^\/issues\/(\d+)$/.exec(rest);
    if (m) {
      const issue = this.issue(Number(m[1]));
      if (!issue) return this.#json(404, { message: "Not Found" });
      if (method === "GET") return this.#cached(headers, issue);
      if (method === "PATCH") {
        this.#applyIssue(issue, body);
        return this.#json(200, issue);
      }
    }

    if (method === "GET" && rest === "/milestones") return this.#page(url, headers, this.milestones);
    if (method === "POST" && rest === "/milestones") {
      const ms = this.addMilestone({ title: body.title, description: body.description ?? "", due_on: body.due_on ?? null, state: body.state ?? "open" });
      return this.#json(201, ms);
    }
    m = /^\/milestones\/(\d+)$/.exec(rest);
    if (m) {
      const ms = this.milestones.find((x) => x.number === Number(m![1]));
      if (!ms) return this.#json(404, { message: "Not Found" });
      if (method === "GET") return this.#cached(headers, ms);
      if (method === "PATCH") return this.#json(200, this.editMilestone(ms.number, body));
    }

    if (method === "GET" && rest === "/pulls") {
      const items = [...this.pulls].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      return this.#page(url, headers, items);
    }
    m = /^\/pulls\/(\d+)\/(files|reviews)$/.exec(rest);
    if (method === "GET" && m) {
      const n = Number(m[1]);
      const list: unknown[] = m[2] === "files" ? (this.files.get(n) ?? []).map((filename) => ({ filename })) : (this.reviews.get(n) ?? []);
      return this.#page(url, headers, list);
    }
    return this.#json(404, { message: "Not Found" });
  }
}
