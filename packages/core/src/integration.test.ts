// Cross-module seams through the real app (startApp): real projects (temp git repos, real worktrees), real sessions,
// ingest, metrics, settings, library, launch, artifacts and sync, with a scripted fake harness (some tests
// report usage the way the Claude driver does: cumulative per model, including history copied by a resume or a
// fork) and the in-memory fake GitHub. No network, temp dirs only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactDetail, LibraryAsset, Session, SessionDetail } from "@odin/shared/api";
import type { ServerEvent } from "@odin/shared/events";
import { fakeHarness, type FakeScript } from "./harness/fake.ts";
import { FakeGitHub } from "./sync/fake-github.ts";
import { collectEvents, startApp, type TestApp } from "./test-helpers.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function tempRepo(): { path: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "odin-it-"));
  const path = join(root, "demo");
  mkdirSync(path);
  git(path, "init", "-q", "-b", "main");
  writeFileSync(join(path, "README.md"), "# demo\n");
  git(path, "add", ".");
  git(path, "commit", "-qm", "init");
  return { path, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function until(cond: () => Promise<boolean>, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const session = (app: TestApp, id: string) => app.json<SessionDetail>(`/api/sessions/${id}`);
const stateIs = (app: TestApp, id: string, state: Session["state"]) => async () => (await session(app, id)).state === state;
const post = (app: TestApp, path: string, body?: unknown) => app.api(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

/**
 * Like the Claude driver: `result.modelUsage` is cumulative for the session, including turns from before a resume
 * and the history a fork copied. `totals` is the harness's own per-session counter.
 */
function cumulativeScript(totals: Map<string, { input: number; output: number; cost: number }>): FakeScript {
  return (message, _turn, options) => {
    const id = options.fork || !options.resume ? options.sessionId! : options.resume;
    const start = totals.get(id) ?? (options.fork && options.resume ? { ...totals.get(options.resume)! } : { input: 0, output: 0, cost: 0 });
    const next = { input: start.input + 100, output: start.output + 10, cost: +(start.cost + 0.01).toFixed(4) };
    totals.set(id, next);
    const steps: ReturnType<FakeScript> = [];
    if (message.text.includes("write")) steps.push({ tool: "Write", input: { file_path: "notes.txt", content: "x" }, ask: true });
    steps.push({ text: `reply to ${message.text}` });
    steps.push({ emit: { type: "usage", model: "claude-test-1", usage: { input: next.input, output: next.output, cacheRead: 0, cacheWrite: 0 }, cumulative: true, costUsd: next.cost, contextTokens: next.input } });
    return steps;
  };
}

test("seams: register → discover, start → prompt → answer, resume, fork; metrics are not double-counted", async () => {
  const repo = tempRepo();
  const totals = new Map<string, { input: number; output: number; cost: number }>();
  const harness = fakeHarness({ script: cumulativeScript(totals) });
  // A session made by a terminal `claude` before the project was registered.
  harness.seed({ sessionId: "terminal-1", cwd: repo.path, title: "from a terminal" }, [
    { kind: "user", id: "u-ext", text: "hi", at: null, parentToolUseId: null },
  ]);
  const app = await startApp({ harnesses: { claude: harness } });
  try {
    const created = await post(app, "/api/projects", { path: repo.path });
    assert.equal(created.status, 201);
    await until(async () => (await app.json<Session[]>("/api/sessions?origin=external")).length === 1, "discovery on registration");

    // Start: 201 with the record; a Write prompt; SSE carries session.updated and session.event frames.
    const sse = collectEvents(app.base, (evs) => evs.some((e) => e.type === "session.event" && e.event.type === "permission.request"), 3000);
    await new Promise((r) => setTimeout(r, 50));
    const res = await post(app, "/api/sessions", { project: "demo", harness: "claude", prompt: { text: "please write notes" } });
    assert.equal(res.status, 201);
    const s1 = (await res.json()) as Session;
    const frames: ServerEvent[] = await sse;
    assert.ok(frames.some((e) => e.type === "session.updated" && e.session.id === s1.id));
    await until(stateIs(app, s1.id, "waiting"), "waiting");
    const waiting = await session(app, s1.id);
    assert.equal(waiting.waitingFor, "permission");
    assert.deepEqual(waiting.slashCommands.map((c: { name: string }) => c.name), ["compact", "review"]);
    const answer = await post(app, `/api/sessions/${s1.id}/permissions/${waiting.pending[0]!.id}`, { behavior: "allow", scope: "once" });
    assert.equal(answer.status, 204);
    assert.equal((await post(app, `/api/sessions/${s1.id}/permissions/${waiting.pending[0]!.id}`, { behavior: "allow", scope: "once" })).status, 409);
    await until(stateIs(app, s1.id, "idle"), "idle after the answer");

    // Follow-up on the live handle, then end and resume by sending: usage stays the harness's cumulative total.
    assert.equal((await post(app, `/api/sessions/${s1.id}/messages`, { text: "again" })).status, 200);
    await until(async () => (await session(app, s1.id)).metrics.turns === 2, "second turn");
    assert.equal((await post(app, `/api/sessions/${s1.id}/end`)).status, 200);
    assert.equal((await session(app, s1.id)).state, "ended");
    assert.equal((await post(app, `/api/sessions/${s1.id}/messages`, { text: "resumed" })).status, 200);
    await until(async () => (await session(app, s1.id)).metrics.turns === 3, "third turn after resume");
    await until(stateIs(app, s1.id, "idle"), "idle after resume");
    const d1 = await session(app, s1.id);
    assert.equal(harness.starts.at(-1)!.resume, s1.id);
    assert.deepEqual(d1.metrics.tokensByModel["claude-test-1"], { input: 300, output: 30, cacheRead: 0, cacheWrite: 0 });
    assert.equal(d1.metrics.toolCalls, 1);
    assert.ok(Math.abs(d1.metrics.costUsd! - 0.03) < 1e-9, "unpriced model: the harness's cumulative cost, not a sum");
    assert.equal(d1.model, "claude-fake-1", "the record keeps the model the harness init reported; usage never rewrites it");
    // Transcript: stored entries plus the live tail, each once.
    const ids = d1.transcript.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, "no duplicated entries");
    assert.deepEqual(d1.transcript.filter((e) => e.kind === "user").map((e) => (e.kind === "user" ? e.text : "")), ["please write notes", "again", "resumed"]);

    // Fork with a prompt: the harness counts the copied history; the fork's metrics are its own turn only.
    const forkRes = await post(app, `/api/sessions/${s1.id}/fork`, { title: "the fork", prompt: { text: "fork turn" } });
    assert.equal(forkRes.status, 201);
    const fork = (await forkRes.json()) as Session;
    assert.equal(fork.parentId, s1.id);
    await until(async () => (await session(app, fork.id)).metrics.turns === 1, "fork turn");
    const fd = await session(app, fork.id);
    assert.deepEqual(fd.metrics.tokensByModel["claude-test-1"], { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 });
    assert.ok(Math.abs(fd.metrics.costUsd! - 0.01) < 1e-9, String(fd.metrics.costUsd));
    // The parent is untouched by the fork.
    assert.deepEqual((await session(app, s1.id)).metrics.tokensByModel["claude-test-1"], { input: 300, output: 30, cacheRead: 0, cacheWrite: 0 });

    // Rename and archive through PATCH; archived sessions leave the default list and metrics.
    const renamed = await app.json<Session>(`/api/sessions/${s1.id}`, { method: "PATCH", body: JSON.stringify({ title: "Renamed", archived: true }) });
    assert.equal(renamed.title, "Renamed");
    assert.equal((await harness.info(s1.id))!.title, "Renamed", "rename reaches the harness");
    assert.ok(!(await app.json<Session[]>("/api/sessions")).some((s) => s.id === s1.id));
    const rows = await app.json<{ n: number; sessionIds: string[] }[]>("/api/metrics?groupBy=model");
    assert.deepEqual(rows.flatMap((r) => r.sessionIds), [fork.id]);

    // Project detail counts come from sessions.
    const project = await app.json<{ sessions: { total: number } }>("/api/projects/demo");
    assert.equal(project.sessions.total, 2, "the fork and the external session (the archived one is not counted)");
  } finally {
    await app.close();
    repo.cleanup();
  }
});

test("seams: a worktree session runs in a real worktree; refreshOutput measures its committed diff after a turn", async () => {
  const repo = tempRepo();
  const app = await startApp({ harnesses: { claude: fakeHarness() } });
  try {
    assert.equal((await post(app, "/api/projects", { path: repo.path })).status, 201);
    const s = (await (await post(app, "/api/sessions", { project: "demo", prompt: { text: "first" }, worktree: true })).json()) as Session;
    assert.equal(s.workspace.kind, "worktree");
    assert.ok(s.cwd.startsWith(realpathSync.native(app.config.worktreesDir)), s.cwd);
    assert.match(s.branch ?? "", /^odin\/first-[0-9a-f]{8}$/);
    assert.equal(git(s.cwd, "rev-parse", "--abbrev-ref", "HEAD").trim(), s.branch);
    await until(stateIs(app, s.id, "idle"), "idle");

    // Work committed on the session's branch shows up after the next turn ends.
    writeFileSync(join(s.cwd, "new.txt"), "a\nb\n");
    git(s.cwd, "add", ".");
    git(s.cwd, "commit", "-qm", "work");
    await post(app, `/api/sessions/${s.id}/messages`, { text: "second" });
    await until(async () => (await session(app, s.id)).metrics.commits === 1, "commits from refreshOutput");
    assert.deepEqual((await session(app, s.id)).metrics.diff, { added: 2, removed: 0, files: 1 });

    // resolveCwd maps the worktree to the project, so hook events from it resolve.
    assert.equal(app.app.services.projects.resolveCwd(join(s.cwd, "sub")), "demo");

    // A worktree fork gets its own branch and folder; the parent's stay.
    const fork = (await (await post(app, `/api/sessions/${s.id}/fork`, { worktree: true })).json()) as Session;
    assert.equal(fork.workspace.kind, "worktree");
    assert.notEqual(fork.cwd, s.cwd);
    assert.notEqual(fork.branch, s.branch);
    assert.equal(fork.state, "idle");
  } finally {
    await app.close();
    repo.cleanup();
  }
});

test("seams: ingest from a terminal session in a registered project creates an external session; Odin's own are skipped", async () => {
  const repo = tempRepo();
  const app = await startApp({ harnesses: { claude: fakeHarness() } });
  try {
    assert.equal((await post(app, "/api/projects", { path: repo.path })).status, 201);
    const mine = (await (await post(app, "/api/sessions", { project: "demo", prompt: { text: "x" } })).json()) as Session;
    await until(stateIs(app, mine.id, "idle"), "idle");
    const at = "2026-11-11T00:00:00.000Z";
    const events = [
      { id: "e1", harness: "claude-code", session: "term-1", cwd: repo.path, ts: at, kind: "session.started", data: { source: "startup", model: "claude-test-1" } },
      { id: "e2", harness: "claude-code", session: "term-1", cwd: repo.path, ts: at, kind: "turn", data: { index: 1, durationMs: 1000 } },
      { id: "e3", harness: "claude-code", session: mine.id, cwd: repo.path, ts: at, kind: "turn", data: { index: 1, durationMs: 1000 } },
    ];
    const res = await app.api("/api/ingest", { method: "POST", body: JSON.stringify(events), headers: { authorization: "Bearer test-ingest-token" } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { accepted: number; duplicates: number; rejected: unknown[] };
    // The start of a session with no message yet is not saved; its first turn creates the session.
    assert.deepEqual([body.accepted, body.duplicates, body.rejected.length], [1, 1, 0]);
    const ext = await session(app, "term-1");
    assert.equal(ext.origin, "external");
    assert.equal(ext.project, "demo");
    assert.equal(ext.metrics.turns, 1);
    assert.equal((await session(app, mine.id)).metrics.turns, 1, "the hook's turn for a Odin session is not counted twice");
  } finally {
    await app.close();
    repo.cleanup();
  }
});

test("seams: global/project instructions and MCP configure the default agent; its artifact round-trips", async () => {
  const repo = tempRepo();
  const harness = fakeHarness({
    script: (message, turn) =>
      turn === 0
        ? [
            { hostTool: "post_artifact", input: { title: "Pick", html: "<button>A</button>", note: "first" } },
            { hostTool: "post_artifact", input: { title: "Pick v2", html: "<button>B</button>", artifact_id: 1 } },
            { text: "posted" },
          ]
        : [{ text: `got ${message.text.length} chars` }],
  });
  const app = await startApp({ harnesses: { claude: harness } });
  const put = (kind: string, id: string, files: Record<string, string>) =>
    app.json<LibraryAsset>(`/api/library/${kind}/${id}`, { method: "PUT", body: JSON.stringify({ files }) });
  try {
    assert.equal((await post(app, "/api/projects", { path: repo.path })).status, 201);
    await put("instruction", "global", { "AGENTS.md": "Global guidance.\n" });
    await put("instruction", "project", { "AGENTS.md": "Project guidance.\n" });
    await put("agent", "helper", { "helper.md": "---\nname: helper\ndescription: Helps.\n---\nYou help.\n" });
    await post(app, "/api/projects/demo/library", { kind: "instruction", id: "project", action: "install" });
    await post(app, "/api/projects/demo/library", { kind: "agent", id: "helper", action: "install" });
    await put("mcp", "docs", { "docs.json": JSON.stringify({ name: "Docs", type: "stdio", command: "docs-mcp", args: ["--x"] }) });
    const res = await post(app, "/api/sessions", { project: "demo", prompt: { text: "Review auth." }, model: "claude-test-1", permissionMode: "plan", mcp: ["docs"] });
    assert.equal(res.status, 201, await res.clone().text());
    const s = (await res.json()) as Session;
    assert.deepEqual([s.agent, s.agentVersion, s.templateId], [null, null, null]);
    const start = harness.starts.at(-1)!;
    assert.equal("agent" in start, false);
    assert.match(start.instructions!, /Global guidance/);
    assert.match(start.instructions!, /Project guidance/);
    assert.equal(start.prompt?.text, "Review auth.");
    assert.deepEqual(start.mcpServers, { docs: { type: "stdio", command: "docs-mcp", args: ["--x"] } });
    assert.ok(start.hostTools?.some(t => t.name === "post_artifact"));
    assert.ok(start.hostTools?.some(t => t.name === "notebook_execute"));
    await until(stateIs(app, s.id, "idle"), "idle");
    assert.equal((await post(app, "/api/sessions", { project: "demo", templateId: "review", prompt: { text: "x" } })).status, 400);
    assert.equal((await post(app, "/api/sessions", { project: "demo", agent: "helper", prompt: { text: "x" } })).status, 400);

    // post_artifact twice: one artifact, two versions, listed in the detail; submit comes back as a user message.
    const detail = await session(app, s.id);
    assert.deepEqual(detail.artifacts.map((a) => [a.id, a.title, a.latestVersion]), [[1, "Pick v2", 2]]);
    const art = await app.json<ArtifactDetail>("/api/artifacts/1");
    assert.deepEqual(art.versions.map((v) => [v.version, v.note]), [[1, "first"], [2, ""]]);
    const page = await app.api("/a/1/2");
    assert.match(page.headers.get("content-security-policy") ?? "", /sandbox allow-scripts allow-forms/);
    assert.match(await page.text(), /<button>B<\/button>/);
    assert.equal((await post(app, "/api/artifacts/1/submit", { version: 2, data: { pick: "B" } })).status, 200);
    await until(async () => (await session(app, s.id)).transcript.some((e) => e.kind === "user" && e.text.includes('"pick": "B"')), "the answer as a user message");
    const answer = (await session(app, s.id)).transcript.find((e) => e.kind === "user" && e.text.includes('"pick"'));
    assert.match(answer && answer.kind === "user" ? answer.text : "", /^Answer from "Pick v2" \(v2\):/);
  } finally {
    await app.close();
    repo.cleanup();
  }
});

test("seams: PR open and merge update the session outcome", async () => {
  const repo = tempRepo();
  const gh = new FakeGitHub();
  const app = await startApp({ harnesses: { claude: fakeHarness() }, githubFetch: gh.fetch, config: { githubToken: gh.token, githubApiUrl: gh.base } });
  try {
    await post(app, "/api/projects", { path: repo.path });
    await app.api("/api/projects/demo/settings", { method: "PATCH", body: JSON.stringify({ repo: gh.repo, githubEnabled: true }) });
    const s = (await (await post(app, "/api/sessions", { project: "demo", prompt: { text: "Fix login" }, worktree: true, branch: "fix-login" })).json()) as Session;
    await until(stateIs(app, s.id, "idle"), "idle");
    const pr = gh.addPull({ number: 10, head: { ref: s.branch! } }, ["src/login.ts"]);
    assert.equal((await post(app, "/api/projects/demo/sync")).status, 204);
    const opened = await session(app, s.id);
    assert.deepEqual(opened.pull, { number: 10, url: pr.html_url, state: "open", merged: false });
    gh.editPull(10, { state: "closed", merged_at: gh.tick() }, ["CHANGES_REQUESTED", "APPROVED"]);
    await post(app, "/api/projects/demo/sync");
    assert.equal((await session(app, s.id)).metrics.prOutcome, "merged-after-changes");
    assert.ok(gh.requests.every((r) => r.method === "GET"));
  } finally { await app.close(); repo.cleanup(); }
});
