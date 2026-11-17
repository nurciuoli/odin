import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PRICING } from "@odin/shared/pricing";
import type { HarnessEvent } from "@odin/shared/harness";
import type { IngestEvent } from "@odin/shared/ingest";
import type { HarnessMeasurement } from "../harness/types.ts";
import { testDeps } from "../test-helpers.ts";
import { fakeSessions, ingestServices, makeSession } from "./fakes.ts";

let n = 0;
const ev = (kind: string, data: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  ({ id: `e${++n}`, ts: "2026-10-17T12:00:00Z", harness: "claude-code", session: "s1", cwd: "/work/demo/src", kind, data, ...over }) as unknown as IngestEvent;
const usage = (data: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  ev("usage", { model: "claude-sonnet-5-5", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...data }, over);

test("native history replacement is idempotent, preserves live deltas, and protects hooks and Odin sessions", () => {
  const s = setup([makeSession(), makeSession({ id: "odin", origin: "odin" })]);
  const facts: HarnessMeasurement[] = [
    { id: "start", at: "2026-11-10T12:00:00Z", kind: "activity", data: {} },
    { id: "usage", at: "2026-11-10T12:01:00Z", kind: "usage", data: { model: "test-model", input: 100, output: 20, cacheRead: 400, cacheWrite: 0, cumulative: false, costUsd: null, contextTokens: 520, contextWindow: 475000 } },
    { id: "turn", at: "2026-11-10T12:01:00Z", kind: "turn", data: { durationMs: 60000, ok: true } },
    { id: "tool", at: "2026-11-10T12:00:30Z", kind: "tool", data: { name: "Bash", ok: true } },
  ];
  s.ingest.replaceHistory("s1", facts);
  s.ingest.replaceHistory("s1", facts);
  let m = s.sessions.get("s1")!.metrics;
  assert.deepEqual([m.tokens.output, m.turns, m.toolCalls, m.activeMs, m.wallMs, m.contextWindow], [20, 1, 1, 60000, 60000, 475000]);
  assert.equal(s.sessions.get("s1")!.model, "test-model");
  assert.equal(m.costUsd, null);
  s.ingest.recordHarnessEvent("s1", { type: "usage", model: "test-model", usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0 }, cumulative: false, costUsd: null, contextTokens: 527 });
  assert.equal(s.sessions.get("s1")!.metrics.tokens.output, 22);
  const updated = facts.map(f => f.kind === "usage" ? { ...f, data: { ...f.data, output: 22 } } : f);
  s.ingest.replaceHistory("s1", updated);
  assert.equal(s.sessions.get("s1")!.metrics.tokens.output, 22);
  s.ingest.replaceHistory("odin", facts);
  assert.equal(s.sessions.get("odin")!.metrics.tokens.output, 0);
  s.ingest.ingest([usage({ output: 10 })]);
  s.ingest.replaceHistory("s1", []);
  assert.equal(s.sessions.get("s1")!.metrics.tokens.output, 32);
});

function setup(initial: Parameters<typeof fakeSessions>[1] = []) {
  const deps = testDeps();
  const sessions = fakeSessions(deps.db, initial);
  const services = ingestServices(deps, sessions);
  return { deps, sessions, services, ingest: services.ingest };
}

test("a bad event in a batch is rejected, the rest land", () => {
  const { ingest, sessions } = setup();
  const res = ingest.ingest([ev("turn", { index: 1, durationMs: 100 }), { id: "bad", kind: "nope" }, "text", ev("tool", { name: "Edit", ok: "yes" })]);
  assert.equal(res.accepted, 1);
  assert.equal(res.rejected.length, 3);
  assert.equal(res.rejected[0]!.id, "bad");
  assert.deepEqual(res.sessionIds, ["s1"]);
  assert.equal(sessions.records.get("s1")!.metrics.turns, 1);
});

test("duplicate ids are counted, not reapplied", () => {
  const { ingest, sessions } = setup();
  const e = ev("turn", { index: 1, durationMs: 100 });
  assert.equal(ingest.ingest([e]).accepted, 1);
  const again = ingest.ingest([e, e]);
  assert.deepEqual([again.accepted, again.duplicates], [0, 2]);
  assert.equal(sessions.records.get("s1")!.metrics.turns, 1);
});

test("resolution: by session, then by project name, then by cwd; unresolvable events are rejected", () => {
  const { ingest, sessions } = setup([makeSession({ id: "known", project: "demo" })]);
  const res = ingest.ingest([
    ev("tool", { name: "Read", ok: true }, { session: "known", cwd: "/elsewhere" }),
    ev("tool", { name: "Read", ok: true }, { session: "byproject", cwd: undefined, project: "demo" }),
    ev("tool", { name: "Read", ok: true }, { session: "bycwd" }),
    ev("tool", { name: "Read", ok: true }, { session: "nowhere", cwd: "/elsewhere" }),
    ev("tool", { name: "Read", ok: true }, { session: "noinfo", cwd: undefined }),
    ev("tool", { name: "Read", ok: true }, { session: "badproject", cwd: undefined, project: "ghost" }),
  ]);
  assert.equal(res.accepted, 3);
  assert.equal(res.rejected.length, 3);
  assert.match(res.rejected.find((r) => r.error.includes("ghost"))!.error, /unknown project/);
  assert.equal(sessions.records.get("bycwd")!.project, "demo");
  assert.equal(sessions.records.get("byproject")!.project, "demo");
});

test("a terminal session with no message is not saved: start and end alone create nothing", () => {
  const { ingest, sessions } = setup();
  const res = ingest.ingest([ev("session.started", { model: "claude-opus-5-5", source: "startup" }), ev("session.ended", { outcome: "completed" })]);
  assert.deepEqual([res.accepted, res.duplicates, res.rejected.length], [0, 0, 0]);
  assert.equal(sessions.records.get("s1"), undefined);
});

test("external creation: the first turn after a reply creates a claude-code session with branch and agent", () => {
  const { ingest, sessions } = setup();
  ingest.ingest([
    ev("session.started", { model: "claude-opus-5-5", source: "startup" }),
    ev("turn", { index: 1, durationMs: 5 }, { branch: "item/3-x", agent: "reviewer" }),
  ]);
  const s = sessions.records.get("s1")!;
  assert.equal(s.harness, "claude");
  assert.equal(s.origin, "external");
  assert.deepEqual([s.branch, s.agent], ["item/3-x", "reviewer"]);
});

test("a started event for a session that already exists is still applied", () => {
  const { ingest, sessions } = setup([makeSession({ id: "s1", state: "ended", endedAt: "2026-10-17T12:00:00Z" })]);
  ingest.ingest([ev("session.started", { source: "resume" }, { ts: "2026-10-17T13:00:00Z" })]);
  assert.equal(sessions.records.get("s1")!.state, "idle");
});

test("a hook event for a linked native id does not create another session", () => {
  const { ingest, sessions, deps } = setup([makeSession({ id: "odin-1", harness: "grok", origin: "odin", title: "Real session" })]);
  deps.db.prepare("INSERT INTO harness_session_links (harness, session_id, native_id) VALUES ('grok', 'odin-1', 'native-1')").run();
  const res = ingest.ingest([ev("tool", { name: "read_file", ok: true }, { session: "native-1" })]);
  assert.deepEqual([res.accepted, res.duplicates, res.rejected.length], [0, 1, 0]);
  assert.equal(sessions.records.get("native-1"), undefined);
  assert.equal(sessions.records.get("odin-1")!.title, "Real session");
  assert.equal((deps.db.prepare("SELECT COUNT(*) AS n FROM session_events").get() as { n: number }).n, 0);
});

test("events for a session Odin runs are acknowledged as duplicates and not stored", () => {
  const { ingest, sessions, deps } = setup([makeSession({ id: "mine", origin: "odin" })]);
  const res = ingest.ingest([ev("turn", { index: 1, durationMs: 5 }, { session: "mine" }), ev("session.ended", { outcome: "failed" }, { session: "mine" })]);
  assert.deepEqual([res.accepted, res.duplicates], [0, 2]);
  assert.equal(sessions.records.get("mine")!.state, "idle");
  assert.equal((deps.db.prepare("SELECT COUNT(*) AS n FROM session_events").get() as { n: number }).n, 0);
});

test("session.ended sets the state; a resumed start brings it back", () => {
  const { ingest, sessions } = setup();
  ingest.ingest([ev("turn", { index: 1, durationMs: 5 }), ev("session.ended", { outcome: "failed", error: "boom" }, { ts: "2026-10-17T12:05:00Z" })]);
  let s = sessions.records.get("s1")!;
  assert.deepEqual([s.state, s.endedAt, s.error], ["failed", "2026-10-17T12:05:00.000Z", "boom"]);
  ingest.ingest([ev("session.started", { source: "resume" }, { ts: "2026-10-17T13:00:00Z" })]);
  s = sessions.records.get("s1")!;
  assert.deepEqual([s.state, s.endedAt, s.error], ["idle", null, null]);
  ingest.ingest([ev("session.ended", { outcome: "completed" }, { ts: "2026-10-17T13:30:00Z" })]);
  assert.equal(sessions.records.get("s1")!.state, "ended");
});

test("metrics: counts, wall and active time, cumulative usage replaces, incremental adds", () => {
  const { ingest, sessions } = setup();
  ingest.ingest([
    ev("session.started", {}, { ts: "2026-10-17T12:00:00Z" }),
    ev("turn", { index: 1, durationMs: 4000 }, { ts: "2026-10-17T12:01:00Z" }),
    ev("turn", { index: 2, durationMs: 6000 }, { ts: "2026-10-17T12:10:00Z" }),
    ev("tool", { name: "Edit", target: "a.ts", ok: true }),
    usage({ input: 100, output: 50, cumulative: true }, { ts: "2026-10-17T12:02:00Z" }),
    usage({ input: 300, output: 150, cacheRead: 10, cumulative: true }, { ts: "2026-10-17T12:10:00Z" }),
    usage({ model: "claude-haiku-5-5", input: 1, output: 2, cumulative: false }),
    usage({ model: "claude-haiku-5-5", input: 1, output: 2 }),
  ]);
  const m = sessions.records.get("s1")!.metrics;
  assert.equal(m.wallMs, 10 * 60_000);
  assert.equal(m.activeMs, 10_000);
  assert.equal(m.turns, 2);
  assert.equal(m.toolCalls, 1);
  assert.deepEqual(m.tokensByModel, {
    "claude-sonnet-5-5": { input: 300, output: 150, cacheRead: 10, cacheWrite: 0 },
    "claude-haiku-5-5": { input: 2, output: 4, cacheRead: 0, cacheWrite: 0 },
  });
});

test("usage does not rewrite a selected model; per-model totals still count every model; batches add up", () => {
  const { ingest, sessions } = setup([makeSession({ model: "claude-haiku-5-5" })]);
  ingest.ingest([usage({ output: 5 })]);
  ingest.ingest([usage({ model: "claude-opus-5-5", output: 500 }), usage({ output: 7 })]);
  const s = sessions.records.get("s1")!;
  assert.equal(s.model, "claude-haiku-5-5");
  assert.equal(s.metrics.tokens.output, 512);
  assert.equal(s.metrics.tokensByModel["claude-opus-5-5"]!.output, 500);
  assert.equal(s.metrics.tokensByModel["claude-sonnet-5-5"]!.output, 12);
});

test("an ingested session with no model takes the top-output model from usage, then keeps it", () => {
  const { ingest, sessions } = setup();
  ingest.ingest([usage({ output: 5 })]);
  assert.equal(sessions.records.get("s1")!.model, "claude-sonnet-5-5");
  ingest.ingest([usage({ model: "claude-opus-5-5", output: 500 })]);
  assert.equal(sessions.records.get("s1")!.model, "claude-sonnet-5-5");
});

test("an Odin-run session's model is not set from usage", () => {
  const { ingest, sessions } = setup([makeSession({ id: "m", origin: "odin" })]);
  ingest.recordHarnessEvent("m", { type: "usage", model: "claude-opus-5-5", usage: { input: 0, output: 50, cacheRead: 0, cacheWrite: 0 }, cumulative: false, costUsd: null, contextTokens: null });
  assert.equal(sessions.records.get("m")!.model, null);
  assert.equal(sessions.records.get("m")!.metrics.tokensByModel["claude-opus-5-5"]!.output, 50);
});

test("cost: priced models use pricing; an unpriced model falls back to the harness's cost, else null", () => {
  const price = DEFAULT_PRICING["claude-sonnet-5-5"]!;
  const a = setup();
  a.ingest.ingest([usage({ input: 1_000_000, output: 1_000_000 })]);
  assert.equal(a.sessions.records.get("s1")!.metrics.costUsd, price.input + price.output);

  const b = setup();
  b.ingest.ingest([usage({ input: 10, output: 10 }), usage({ model: "mystery-1", input: 10, output: 10 })]);
  assert.equal(b.sessions.records.get("s1")!.metrics.costUsd, null);

  // Harness cost: cumulative takes the latest, incremental sums.
  const c = setup([makeSession({ id: "m", origin: "odin" })]);
  const run = (e: HarnessEvent) => c.ingest.recordHarnessEvent("m", e);
  const u = (model: string, cumulative: boolean, out: number, costUsd: number | null): HarnessEvent => ({ type: "usage", model, usage: { input: 0, output: out, cacheRead: 0, cacheWrite: 0 }, cumulative, costUsd, contextTokens: null });
  run(u("mystery-1", true, 10, 0.5));
  run(u("mystery-1", true, 20, 0.75));
  run(u("other-2", false, 5, 0.1));
  run(u("other-2", false, 5, 0.2));
  assert.ok(Math.abs(c.sessions.records.get("m")!.metrics.costUsd! - 1.05) < 1e-9);
  run(u("third-3", false, 1, null));
  assert.equal(c.sessions.records.get("m")!.metrics.costUsd, null);
});

test("pricing.json overrides are used (settings.pricing)", () => {
  const { ingest, sessions, services } = setup();
  services.settings.savePricing({ "claude-sonnet-5-5": { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });
  ingest.ingest([usage({ input: 1_000_000 })]);
  assert.equal(sessions.records.get("s1")!.metrics.costUsd, 1);
});

test("diff, commits and PR outcome are never overwritten by events", () => {
  const base = makeSession({});
  base.metrics = { ...base.metrics, diff: { added: 3, removed: 1, files: 1 }, commits: 2, prOutcome: "merged", reviewRounds: 1 };
  const { ingest, sessions } = setup([base]);
  ingest.ingest([ev("turn", { index: 1, durationMs: 1 })]);
  const m = sessions.records.get("s1")!.metrics;
  assert.deepEqual([m.diff, m.commits, m.prOutcome, m.reviewRounds, m.turns], [{ added: 3, removed: 1, files: 1 }, 2, "merged", 1, 1]);
});

test("SSE goes out after commit: session.updated for a batch, nothing when the batch throws", () => {
  const { ingest, deps, sessions } = setup();
  const seen: string[] = [];
  deps.bus.subscribe((e) => seen.push(e.type));
  const realPatch = sessions.patch;
  sessions.patch = (id, p) => {
    const s = realPatch(id, p);
    deps.bus.emit({ type: "session.updated", session: s } as never);
    return s;
  };
  ingest.ingest([ev("turn", { index: 1, durationMs: 1 })]);
  assert.deepEqual(seen, ["session.updated"]);

  sessions.patch = () => {
    deps.bus.emit({ type: "session.updated", session: makeSession() } as never);
    throw new Error("disk full");
  };
  const before = (deps.db.prepare("SELECT COUNT(*) AS n FROM session_events").get() as { n: number }).n;
  seen.length = 0;
  assert.throws(() => ingest.ingest([ev("turn", { index: 2, durationMs: 1 })]), /disk full/);
  assert.deepEqual(seen, []);
  assert.equal((deps.db.prepare("SELECT COUNT(*) AS n FROM session_events").get() as { n: number }).n, before);
});

test("tool targets are truncated, and message text is not stored beyond 2000 chars", () => {
  const { ingest, deps } = setup();
  ingest.ingest([ev("tool", { name: "Read", target: "x".repeat(500), ok: true }), ev("message", { text: "y".repeat(5000) })]);
  const rows = deps.db.prepare("SELECT kind, data FROM session_events ORDER BY seq").all() as { kind: string; data: string }[];
  assert.equal(JSON.parse(rows[0]!.data).target.length, 200);
  assert.equal(JSON.parse(rows[1]!.data).text.length, 2000);
});

// ── harness facts ──────────────────────────────────────────────────────────

test("recordHarnessEvent: usage, turn.end, tool entries and a failed exit become facts and metrics", () => {
  const { ingest, sessions, deps } = setup([makeSession({ id: "m", origin: "odin", model: "claude-sonnet-5-5" })]);
  const run = (e: HarnessEvent) => ingest.recordHarnessEvent("m", e);
  run({ type: "init", sessionId: "m", model: "claude-sonnet-5-5", permissionMode: null, cwd: "/", tools: [], slashCommands: [], agents: [] });
  const tool = { kind: "tool", id: "t1", name: "Bash", input: { command: "npm run test --silent" }, at: null, parentToolUseId: null } as const;
  run({ type: "entry", entry: tool });
  run({ type: "entry", entry: { ...tool, result: { ok: true, text: "SECRET OUTPUT", truncated: false } } });
  run({ type: "entry", entry: { kind: "assistant", id: "a", text: "hi", model: null, at: null, parentToolUseId: null } });
  run({ type: "usage", model: "claude-sonnet-5-5", usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 }, cumulative: true, costUsd: 0.01, contextTokens: 4321 });
  run({ type: "turn.end", durationMs: 2500, ok: true, error: null });
  run({ type: "exit", outcome: "closed", error: null });
  let m = sessions.records.get("m")!.metrics;
  assert.deepEqual([m.turns, m.toolCalls, m.activeMs, m.contextTokens, m.tokens.output], [1, 1, 2500, 4321, 200]);
  assert.equal(sessions.records.get("m")!.model, "claude-sonnet-5-5");
  run({ type: "exit", outcome: "failed", error: "died" });
  const rows = deps.db.prepare("SELECT kind, source, data FROM session_events ORDER BY seq").all() as { kind: string; source: string; data: string }[];
  assert.deepEqual(rows.map((r) => r.kind), ["tool", "usage", "turn", "error"]);
  assert.ok(rows.every((r) => r.source === "harness"));
  const toolRow = JSON.parse(rows[0]!.data);
  assert.deepEqual(toolRow, { name: "Bash", target: "npm run", ok: true });
  assert.ok(!rows.some((r) => r.data.includes("SECRET")));
  m = sessions.records.get("m")!.metrics;
  assert.equal(m.turns, 1);
});

test("recordHarnessEvent ignores unknown sessions", () => {
  const { ingest, deps } = setup();
  ingest.recordHarnessEvent("ghost", { type: "turn.end", durationMs: 1, ok: true, error: null });
  assert.equal((deps.db.prepare("SELECT COUNT(*) AS n FROM session_events").get() as { n: number }).n, 0);
});

test("recordBaseline: a fork counts only its own usage, tokens and cost", () => {
  const { ingest, sessions } = setup([makeSession({ id: "parent", origin: "odin" }), makeSession({ id: "fork", origin: "odin", parentId: "parent" })]);
  const u = (id: string, out: number, costUsd: number): void =>
    ingest.recordHarnessEvent(id, { type: "usage", model: "mystery-1", usage: { input: 0, output: out, cacheRead: 0, cacheWrite: 0 }, cumulative: true, costUsd, contextTokens: null });
  u("parent", 1000, 1);
  u("parent", 1500, 1.5);
  ingest.recordBaseline("fork", "parent");
  u("fork", 1700, 1.7); // includes the 1500 it copied
  const m = sessions.records.get("fork")!.metrics;
  assert.equal(m.tokens.output, 200);
  assert.equal(m.tokensByModel["mystery-1"]!.output, 200);
  assert.ok(Math.abs(m.costUsd! - 0.2) < 1e-9);
  // The parent is untouched.
  assert.equal(sessions.records.get("parent")!.metrics.tokens.output, 1500);
  // Baseline before any usage: a fork that has reported nothing yet has no tokens.
  const { ingest: i2, sessions: s2 } = setup([makeSession({ id: "p", origin: "odin" }), makeSession({ id: "f", origin: "odin" })]);
  i2.recordHarnessEvent("p", { type: "usage", model: "claude-sonnet-5-5", usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 }, cumulative: true, costUsd: null, contextTokens: null });
  i2.recordBaseline("f", "p");
  assert.equal(s2.records.get("f")!.metrics.tokens.output, 0);
});

test("a fake harness run feeds recordHarnessEvent", async () => {
  const { fakeHarness } = await import("../harness/fake.ts");
  const harness = fakeHarness({ script: () => [{ tool: "Read", input: { file_path: "a.txt" } }, { text: "ok" }, { usage: { input: 10, output: 20 }, costUsd: 0.001 }] });
  const { ingest, sessions } = setup([makeSession({ id: "run", origin: "odin" })]);
  const handle = harness.start({ cwd: "/work/demo", sessionId: "run", prompt: { text: "go" } });
  for await (const event of handle.events) {
    ingest.recordHarnessEvent("run", event);
    if (event.type === "turn.end") await handle.close();
  }
  const m = sessions.records.get("run")!.metrics;
  assert.equal(m.turns, 1);
  assert.equal(m.toolCalls, 1);
  assert.ok(m.tokens.output >= 20);
});
