// GitHub REST client: plain fetch (deps.githubFetch), no SDK. Ported from Rick's projects/github.ts.
// The token never leaves this module: it is sent only to the configured API base URL, and every error message is
// built here and scrubbed of it. List calls take ETags; rate-limit headers block further calls until the reset.

export const REQUEST_TIMEOUT_MS = 20_000;
export const MAX_PAGES = 10;

export class GitHubError extends Error {
  /** HTTP status from GitHub, or 0 for network errors and local refusals. */
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Replaces every secret in `text` with ***. */
export function scrub(text: string, secrets: (string | null | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join("***");
  return out;
}

// ── raw shapes (only the fields Odin reads) ──

export interface RawLabel {
  name?: string;
  color?: string;
}

export interface RawMilestone {
  number: number;
  title: string;
  description?: string | null;
  state: "open" | "closed";
  due_on?: string | null;
  html_url: string;
  updated_at: string;
  created_at?: string;
  open_issues?: number;
  closed_issues?: number;
}

export interface RawIssue {
  number: number;
  node_id?: string;
  title: string;
  body?: string | null;
  state: "open" | "closed";
  state_reason?: string | null;
  labels?: (RawLabel | string)[];
  milestone?: { number: number; title?: string } | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  pull_request?: unknown;
}

export interface RawPull {
  number: number;
  title: string;
  body?: string | null;
  state: "open" | "closed";
  html_url: string;
  head: { ref: string };
  base?: { ref: string };
  merged_at?: string | null;
  merged?: boolean;
  labels?: (RawLabel | string)[];
  updated_at: string;
  created_at?: string;
}

export interface RawReview {
  state: string;
}

export interface RawFile {
  filename: string;
}

export function labelNames(labels: (RawLabel | string)[] | undefined): string[] {
  return (labels ?? []).map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean);
}

/** A list that may not have changed: `notModified` means the ETag still matched (no items returned). */
export interface ListResult<T> {
  items: T[];
  etag: string | null;
  notModified: boolean;
  /** Pages fetched. An ETag only covers page 1, so it says nothing about later pages of a longer list. */
  pages: number;
}

export interface GitHubClientOptions {
  token: string;
  baseUrl: string;
  fetch: typeof fetch;
  now?: () => number;
}

function repoPath(repo: string): string {
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new GitHubError(0, `invalid repo "${repo}" (expected owner/name)`);
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function nextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part);
    if (m) return m[1]!;
  }
  return null;
}

interface Response1 {
  status: number;
  data: any;
  headers: Headers;
}

export class GitHubClient {
  readonly baseUrl: string;
  #token: string;
  #fetch: typeof fetch;
  #now: () => number;
  /** Epoch ms until which GitHub said we're rate limited. */
  #blockedUntil = 0;

  constructor(o: GitHubClientOptions) {
    this.#token = o.token;
    this.baseUrl = o.baseUrl.replace(/\/+$/, "");
    this.#fetch = o.fetch;
    this.#now = o.now ?? Date.now;
  }

  get hasToken(): boolean {
    return !!this.#token;
  }

  /** Scrubs the token from any text (for errors that didn't come from here). */
  scrub(text: string): string {
    return scrub(text, [this.#token]);
  }

  #fail(status: number, message: string): never {
    throw new GitHubError(status, scrub(message, [this.#token]));
  }

  #rateLimited(): never {
    this.#fail(429, `GitHub rate limit reached; retrying after ${new Date(this.#blockedUntil).toISOString()}`);
  }

  async #request(method: string, url: string, o: { body?: unknown; etag?: string | null } = {}): Promise<Response1> {
    if (!this.#token) this.#fail(0, "no GitHub token (set GITHUB_TOKEN or run gh auth login)");
    // Never send the token anywhere but the API (pagination links come from the response).
    if (!url.startsWith(this.baseUrl + "/")) this.#fail(0, "refusing a GitHub URL outside the API");
    if (this.#now() < this.#blockedUntil) this.#rateLimited();
    let res: Response;
    try {
      res = await this.#fetch(url, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.#token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "odin-core",
          ...(o.etag ? { "if-none-match": o.etag } : {}),
          ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      this.#fail(0, `GitHub request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const path = url.slice(this.baseUrl.length).split("?")[0];
    const remaining = res.headers.get("x-ratelimit-remaining");
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    if (res.status === 304) return { status: 304, data: null, headers: res.headers };
    if (!res.ok) {
      let detail = "";
      try {
        const j = (await res.json()) as { message?: string };
        detail = typeof j.message === "string" ? j.message : "";
      } catch {
        // not JSON
      }
      const retryAfter = Number(res.headers.get("retry-after"));
      if ((res.status === 403 || res.status === 429) && (remaining === "0" || retryAfter > 0)) {
        this.#blockedUntil = retryAfter > 0 ? this.#now() + retryAfter * 1000 : reset > 0 ? reset * 1000 : this.#now() + 60_000;
        this.#rateLimited();
      }
      this.#fail(res.status, `GitHub ${method} ${path} → ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    // The last call of the window succeeded: don't spend the next one on a guaranteed 403.
    if (remaining === "0" && reset > 0) this.#blockedUntil = reset * 1000;
    const data = res.status === 204 ? null : await res.json().catch(() => this.#fail(502, `GitHub ${method} ${path}: invalid JSON`));
    return { status: res.status, data, headers: res.headers };
  }

  #url(path: string): string {
    return this.baseUrl + path;
  }

  /** Pages of a list, following Link headers. The ETag applies to the first page only. */
  async *pages<T>(path: string, etag?: string | null): AsyncGenerator<{ items: T[]; etag: string | null; notModified: boolean }> {
    let url: string | null = this.#url(path);
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const res: Response1 = await this.#request("GET", url, { etag: page === 0 ? etag : null });
      if (res.status === 304) {
        yield { items: [], etag: etag ?? null, notModified: true };
        return;
      }
      if (!Array.isArray(res.data)) this.#fail(502, `GitHub GET ${path.split("?")[0]}: expected a list`);
      yield { items: res.data as T[], etag: page === 0 ? res.headers.get("etag") : null, notModified: false };
      url = nextLink(res.headers.get("link"));
    }
  }

  async list<T>(path: string, etag?: string | null): Promise<ListResult<T>> {
    const out: ListResult<T> = { items: [], etag: null, notModified: false, pages: 0 };
    let first = true;
    for await (const page of this.pages<T>(path, etag)) {
      out.pages++;
      if (first) {
        out.etag = page.etag;
        out.notModified = page.notModified;
        first = false;
      }
      out.items.push(...page.items);
    }
    return out;
  }

  // ── issues ──

  /** Issues (not PRs) updated at or after `since` (all when null), every state. */
  async listIssues(repo: string, since: string | null, etag?: string | null): Promise<ListResult<RawIssue>> {
    const q = `state=all&sort=updated&direction=asc&per_page=100${since ? `&since=${encodeURIComponent(since)}` : ""}`;
    const res = await this.list<RawIssue>(`${repoPath(repo)}/issues?${q}`, etag);
    res.items = res.items.filter((i) => !i.pull_request);
    return res;
  }

  /** One issue, or null when the ETag still matches. */
  async getIssue(repo: string, n: number, etag?: string | null): Promise<{ issue: RawIssue | null; etag: string | null }> {
    const res = await this.#request("GET", this.#url(`${repoPath(repo)}/issues/${n}`), { etag });
    return res.status === 304 ? { issue: null, etag: etag ?? null } : { issue: res.data as RawIssue, etag: res.headers.get("etag") };
  }

  // ── milestones ──

  async listMilestones(repo: string, etag?: string | null): Promise<ListResult<RawMilestone>> {
    return this.list<RawMilestone>(`${repoPath(repo)}/milestones?state=all&per_page=100`, etag);
  }

  async getMilestone(repo: string, n: number, etag?: string | null): Promise<{ milestone: RawMilestone | null; etag: string | null }> {
    const res = await this.#request("GET", this.#url(`${repoPath(repo)}/milestones/${n}`), { etag });
    return res.status === 304 ? { milestone: null, etag: etag ?? null } : { milestone: res.data as RawMilestone, etag: res.headers.get("etag") };
  }

  // ── pull requests ──

  /** PRs, most recently updated first, page by page: callers stop at their cursor. */
  pullPages(repo: string, etag?: string | null) {
    return this.pages<RawPull>(`${repoPath(repo)}/pulls?state=all&sort=updated&direction=desc&per_page=50`, etag);
  }

  async pullFiles(repo: string, n: number): Promise<string[]> {
    return (await this.list<RawFile>(`${repoPath(repo)}/pulls/${n}/files?per_page=100`)).items.map((f) => f.filename);
  }

  async pullReviews(repo: string, n: number): Promise<RawReview[]> {
    return (await this.list<RawReview>(`${repoPath(repo)}/pulls/${n}/reviews?per_page=100`)).items;
  }
}
