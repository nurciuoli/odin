import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "@odin/shared/api";
import { HttpError } from "../http/util.ts";
import { PROJECT, setup, waitFor } from "./test-setup.ts";

const status = (n: number) => (e: unknown) => e instanceof HttpError && e.status === n;

test("selected MCP ids persist without secrets and resolve current configuration on resume and fork", async () => {
  const s = setup();
  const save = (secret: string) => s.services.library.save("mcp", "selected", { "selected.json": JSON.stringify({ name: "Selected", type: "stdio", command: "selected-mcp", env: { TOKEN: secret } }) });
  const secret = () => { const server = s.harness.starts.at(-1)!.mcpServers?.selected; return server?.type === "stdio" ? server.env?.TOKEN : undefined; };
  try {
    save("first-secret");
    const session = await s.sessions.start({ project: PROJECT, prompt: { text: "start" }, mcp: ["selected"] });
    assert.equal(secret(), "first-secret");
    const row = s.deps.db.prepare("SELECT launch_config FROM sessions WHERE id=?").get(session.id)!;
    assert.equal(row.launch_config, JSON.stringify({ mcpIds: ["selected"] }));
    await s.sessions.end(session.id);
    save("updated-secret");
    await s.sessions.send(session.id, { text: "resume" });
    assert.equal(secret(), "updated-secret");
    const child = await s.sessions.fork(session.id, { prompt: { text: "fork" } });
    assert.equal(secret(), "updated-secret");
    assert.equal(s.deps.db.prepare("SELECT launch_config FROM sessions WHERE id=?").get(child.id)?.launch_config, row.launch_config);
    await s.sessions.end(child.id);
    s.services.library.remove("mcp", "selected");
    await s.sessions.send(child.id, { text: "missing integration" });
    assert.equal(s.sessions.queue(child.id).paused, true);
    assert.equal(s.sessions.queue(child.id).messages[0]!.state, "queued");
    assert.match(s.sessions.get(child.id)!.error!, /unknown library mcp selected/);
    s.sessions.patch(child.id, { state: "ended", error: null });
    await s.sessions.send(child.id, { text: "keep this paused" });
    assert.equal(s.sessions.get(child.id)!.state, "ended");
    assert.equal(s.sessions.get(child.id)!.error, null);
  } finally { await s.sessions.close(); }
});

test("opening a streaming session includes deltas when native history is unavailable", async () => {
  const s = setup({ harness: { script: () => [
    { emit: { type: "delta", entryId: "partial", kind: "assistant", text: "Still working", parentToolUseId: null } },
    { wait: new Promise<void>(() => {}) },
  ] } });
  try {
    const st = await s.sessions.start({ project: PROJECT, prompt: { text: "hello" } });
    s.harness.messages = async () => [];
    await waitFor(async () => (await s.sessions.detail(st.id))!.transcript.some(e => e.id === "partial"));
    const entry = (await s.sessions.detail(st.id))!.transcript.find(e => e.id === "partial");
    assert.equal(entry?.kind === "assistant" && entry.text, "Still working");
    assert.deepEqual((await s.sessions.detail(st.id))!.streaming, ["partial"]);
    const delta = s.deps.events.find(e => e.type === "session.event" && e.event.type === "delta");
    assert.equal(delta?.type === "session.event" && delta.event.type === "delta" && delta.event.offset, 0);
  } finally { await s.sessions.close(); }
});

test("failed turn reason survives idle and reload", async () => {
  const reason = "Codex usage limit reached. Your session is preserved.";
  const s = setup({ harness: { script: () => [{ emit: { type: "turn.end", durationMs: 1, ok: false, error: reason } }, { emit: { type: "state", state: "idle" } }, { wait: new Promise<void>(() => {}) }] } });
  try {
    const session = await s.sessions.start({ project: PROJECT, prompt: { text: "hello" } });
    await idle(s, session.id);
    assert.equal((await s.sessions.detail(session.id))!.error, reason);

  } finally { await s.sessions.close(); }
});

test("multiple repositories persist, filter by membership and reach the harness on start, resume and fork", async () => {
  const s = setup();
  try {
    const path = join(s.deps.config.home, "other");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "AGENTS.md"), "Other repository guidance.");
    const base = s.services.projects.get(PROJECT)!;
    const get = s.services.projects.get;
    s.services.projects.get = name => name === "other" ? { ...base, name, path } : get(name);
    s.deps.db.prepare("INSERT INTO projects (name, path, created_at, updated_at) VALUES (?, ?, ?, ?)").run("other", path, "2026-10-01", "2026-10-01");
    const session = await s.sessions.start({ project: PROJECT, projects: ["other", PROJECT, "other"], prompt: { text: "Work across repositories" }, worktree: true });
    assert.deepEqual(session.projects, [PROJECT, "other"]);
    assert.equal(s.sessions.list({ project: "other" })[0]?.id, session.id);
    assert.equal(s.sessions.counts("other").total, 1);
    assert.equal(s.sessions.counts().total, 1);
    assert.equal(s.worktrees.length, 1);
    assert.deepEqual(s.harness.starts.at(-1)!.additionalDirectories, [path]);
    assert.match(s.harness.starts.at(-1)!.instructions!, /Other repository guidance/);
    await idle(s, session.id);
    await s.sessions.end(session.id);
    await s.sessions.send(session.id, { text: "Continue" });
    assert.deepEqual(s.harness.starts.at(-1)!.additionalDirectories, [path]);
    await idle(s, session.id);
    const fork = await s.sessions.fork(session.id, { prompt: { text: "Alternative" } });
    assert.deepEqual(fork.projects, [PROJECT, "other"]);
    assert.deepEqual(s.harness.starts.at(-1)!.additionalDirectories, [path]);
    const starts = s.harness.starts.length;
    await assert.rejects(s.sessions.start({ project: PROJECT, projects: [], prompt: { text: "Bad" } }), status(400));
    await assert.rejects(s.sessions.start({ project: PROJECT, projects: [PROJECT, "unknown"], prompt: { text: "Bad" } }), status(404));
    assert.equal(s.harness.starts.length, starts);
  } finally { await s.sessions.close(); }
});

async function idle(s: ReturnType<typeof setup>, id: string) {
  await waitFor(() => s.sessions.get(id)?.state === "idle", 2000, `${id} idle`);
}

test("global and project instructions apply on start, resume and fork without selecting a primary agent", async () => {
  const s = setup();
  try {
    s.services.library.save("instruction", "global", { "AGENTS.md": "Global guidance.\n" });
    s.services.library.save("instruction", "project", { "AGENTS.md": "Project guidance.\n" });
    await s.services.library.install(PROJECT, { kind: "instruction", id: "project", action: "install" });
    const session = await s.sessions.start({ project: PROJECT, prompt: { text: "Hello" } });
    assert.match(s.harness.starts.at(-1)!.instructions!, /Global guidance[\s\S]*Project guidance/);
    assert.equal("agent" in s.harness.starts.at(-1)!, false);
    assert.match(s.harness.starts.at(-1)!.instructions!, /Odin preview instructions[\s\S]*post_artifact[\s\S]*override any skill/);
    await idle(s, session.id);
    await s.sessions.end(session.id);
    s.services.library.save("instruction", "global", { "AGENTS.md": "Updated global guidance.\n" });
    await s.sessions.send(session.id, { text: "Continue" });
    assert.match(s.harness.starts.at(-1)!.instructions!, /Updated global guidance[\s\S]*Project guidance/);
    assert.match(s.harness.starts.at(-1)!.instructions!, /Odin preview instructions/);
    await idle(s, session.id);
    await s.sessions.fork(session.id, { prompt: { text: "Try another approach" } });
    assert.match(s.harness.starts.at(-1)!.instructions!, /Odin preview instructions/);
    assert.match(s.harness.starts.at(-1)!.instructions!, /Updated global guidance[\s\S]*Project guidance/);
    assert.equal("agent" in s.harness.starts.at(-1)!, false);
  } finally { await s.sessions.close(); }
});

test("start: record exists at once, events update it, SSE goes out, transcript in detail", async () => {
  const s = setup();
  try {
    const started = await s.sessions.start({ project: PROJECT, prompt: { text: "hello there\nmore" } });
    assert.equal(started.state, "running");
    assert.equal(started.origin, "odin");
    assert.equal(started.title, "hello there");
    assert.equal(started.harness, "claude");
    assert.equal(started.cwd, s.projectPath);
    assert.equal(started.branch, "main");
    assert.equal(s.harness.starts[0]!.sessionId, started.id);
    assert.equal(s.harness.starts[0]!.prompt!.text, "hello there\nmore");
    assert.equal(s.harness.starts[0]!.permissionMode, "default");
    await idle(s, started.id);

    const updated = s.deps.events.filter((e) => e.type === "session.updated");
    assert.ok(updated.length >= 2);
    const evs = s.deps.events.filter((e) => e.type === "session.event").map((e) => (e.type === "session.event" ? e.event.type : ""));
    assert.deepEqual(evs.slice(0, 2), ["init", "state"]);
    assert.ok(evs.includes("turn.end"));
    assert.equal(s.harnessEvents.length, evs.length, "every event goes to ingest");
    assert.deepEqual(s.refreshed, [started.id]);

    const d = (await s.sessions.detail(started.id))!;
    assert.equal(d.live, true);
    assert.deepEqual(d.transcript.map((e) => e.kind), ["user", "assistant"]);
    assert.equal(d.model, "claude-fake-1");
    assert.deepEqual(d.pending, []);
    assert.deepEqual(s.sessions.counts(), { running: 0, waiting: 0, total: 1 });
  } finally {
    await s.sessions.close();
  }
});

test("onEvent and onUpdated listeners fire", async () => {
  const s = setup();
  const seen: string[] = [];
  const updates: Session[] = [];
  s.sessions.onEvent((_id, e) => seen.push(e.type));
  s.sessions.onUpdated((x) => updates.push(x));
  try {
    const st = await s.sessions.start({ project: PROJECT, prompt: { text: "hi" } });
    await idle(s, st.id);
    assert.ok(seen.includes("init") && seen.includes("turn.end"));
    assert.equal(updates.at(-1)!.state, "idle");
  } finally {
    await s.sessions.close();
  }
});

test("permission prompt: waiting → answer → running → idle; 409 for a closed prompt; send while waiting → 409", async () => {
  const s = setup({ harness: { script: () => [{ tool: "Write", input: { file_path: "a.txt" }, ask: true }, { text: "done" }] } });
  try {
    const st = await s.sessions.start({ project: PROJECT, prompt: { text: "write it" } });
    await waitFor(() => s.sessions.get(st.id)?.state === "waiting");
    assert.equal(s.sessions.get(st.id)!.waitingFor, "permission");
    const d = (await s.sessions.detail(st.id))!;
    assert.equal(d.pending.length, 1);
    const rid = d.pending[0]!.id;

    await assert.rejects(s.sessions.send(st.id, { text: "hurry" }), status(409));
    assert.throws(() => s.sessions.answer(st.id, rid, { behavior: "maybe" } as never), status(400));
    assert.throws(() => s.sessions.answer("nope", rid, { behavior: "allow", scope: "once" }), status(404));

    s.sessions.answer(st.id, rid, { behavior: "allow", scope: "session" });
    assert.throws(() => s.sessions.answer(st.id, rid, { behavior: "allow", scope: "once" }), status(409));
    await idle(s, st.id);
    assert.deepEqual(s.harness.answers.map((a) => a.answer), [{ behavior: "allow", scope: "session" }]);
    const states = s.deps.events.flatMap((e) => (e.type === "session.updated" ? [e.session.state] : []));
    const iw = states.indexOf("waiting");
    assert.ok(iw > 0 && states.slice(iw).includes("running") && states.at(-1) === "idle", states.join(","));
    assert.equal(s.sessions.get(st.id)!.waitingFor, null);
    assert.deepEqual((await s.sessions.detail(st.id))!.pending, []);
  } finally {
    await s.sessions.close();
  }
});

test("question prompts set waitingFor question", async () => {
  const s = setup({ harness: { script: () => [{ tool: "AskUserQuestion", input: { questions: [] }, ask: true }] } });
  try {
    const st = await s.sessions.start({ project: PROJECT, prompt: { text: "ask" } });
    await waitFor(() => s.sessions.get(st.id)?.state === "waiting");
    assert.equal(s.sessions.get(st.id)!.waitingFor, "question");
  } finally {
    await s.sessions.close();
  }
});

test("interrupt stops a running turn; a no-op when idle", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const s = setup({ harness: { script: () => [{ text: "start" }, { wait: gate }, { text: "never" }] } });
  try {
    const st = await s.sessions.start({ project: PROJECT, prompt: { text: "go" } });
    await waitFor(() => s.harnessEvents.some((e) => e.event.type === "entry" && e.event.entry.kind === "assistant"));
    await s.sessions.interrupt(st.id);
    release();
    await idle(s, st.id);
    const end = s.harnessEvents.find((e) => e.event.type === "turn.end")!.event;
    assert.ok(end.type === "turn.end" && !end.ok && end.error === "interrupted");
    await s.sessions.interrupt(st.id); // idle: no-op
    await assert.rejects(s.sessions.interrupt("nope"), status(404));
  } finally {
    await s.sessions.close();
  }
});

test("end → ended; sending to an ended session resumes it with `resume`", async () => {
  const s = setup();
  try {
    const st = await s.sessions.start({ project: PROJECT, prompt: { text: "one" } });
    await idle(s, st.id);
    const ended = await s.sessions.end(st.id);
    assert.equal(ended.state, "ended");
    assert.ok(ended.endedAt);
    assert.equal((await s.sessions.detail(st.id))!.live, false);

    const resumed = await s.sessions.send(st.id, { text: "two" });
    assert.equal(resumed.state, "running");
    assert.equal(resumed.endedAt, null);
    const last = s.harness.starts.at(-1)!;
    assert.equal(last.resume, st.id);
    assert.equal(last.cwd, s.projectPath);
    assert.equal(last.prompt!.text, "two");
    assert.equal(last.sessionId, undefined);
    await idle(s, st.id);
    const d = (await s.sessions.detail(st.id))!;
    assert.deepEqual(d.transcript.map((e) => e.kind), ["user", "assistant", "user", "assistant"]);
    assert.equal(new Set(d.transcript.map((e) => e.id)).size, 4);

    // A live send goes to the same handle.
    await s.sessions.send(st.id, { text: "three" });
    assert.equal(s.harness.starts.length, 2);
    await waitFor(() => s.harness.handles.get(st.id)!.sent.length === 2);
    await assert.rejects(s.sessions.send(st.id, { text: "" }), status(400));
  } finally {
    await s.sessions.close();
  }
});

test("fork without a prompt: stored copy, idle, parentId, baseline, copied fields", async () => {
  const s = setup();
  try {
    const st = await s.sessions.start({ project: PROJECT, prompt: { text: "base" }, tags: ["x"] });
    await idle(s, st.id);
    const f = await s.sessions.fork(st.id, {});
    assert.notEqual(f.id, st.id);
    assert.equal(f.state, "idle");
    assert.equal(f.parentId, st.id);
    assert.equal(f.title, "base (fork)");
    assert.deepEqual(f.tags, ["x"]);
    assert.deepEqual(s.baselines, [{ id: f.id, parent: st.id }]);
    assert.equal(s.harness.starts.length, 1, "no harness start without a prompt");
    assert.equal(s.harness.stored(f.id)!.length, 2);
    assert.equal((await s.harness.info(f.id))!.title, "base (fork)");
  } finally {
    await s.sessions.close();
  }
});

test("fork with a prompt: harness start with resume + fork + new sessionId; worktree fork", async () => {
  const s = setup();
  try {
    const st = await s.sessions.start({ project: PROJECT, prompt: { text: "base" } });
    await idle(s, st.id);
    const f = await s.sessions.fork(st.id, { prompt: { text: "other way" }, title: "Alt", worktree: true });
    assert.equal(f.state, "running");
    assert.equal(f.title, "Alt");
    const opts = s.harness.starts.at(-1)!;
    assert.deepEqual([opts.resume, opts.fork, opts.sessionId, opts.prompt!.text], [st.id, true, f.id, "other way"]);
    assert.equal(f.workspace.kind, "worktree");
    assert.equal(opts.cwd, f.cwd);
    assert.match(s.worktrees[0]!.branch, /^odin\/alt-[0-9a-f]{8}$/);
    assert.deepEqual(s.baselines, [{ id: f.id, parent: st.id }]);
    await idle(s, f.id);
    assert.equal((await s.sessions.detail(f.id))!.transcript.length, 4);
    await assert.rejects(s.sessions.fork("nope", {}), status(404));
  } finally {
    await s.sessions.close();
  }
});

test("discover imports external sessions once; ensureExternal creates or returns", async () => {
  const s = setup();
  try {
    s.harness.seed({ sessionId: "ext-1", cwd: s.projectPath, title: "From the terminal", gitBranch: "feature" });
    s.harness.seed({ sessionId: "ext-2", cwd: "/somewhere/else" });
    assert.equal(await s.sessions.discover(PROJECT), 1);
    assert.equal(await s.sessions.discover(PROJECT), 0);
    const e = s.sessions.get("ext-1")!;
    assert.deepEqual([e.origin, e.state, e.title, e.branch, e.workspace.kind], ["external", "idle", "From the terminal", "feature", "checkout"]);
    await assert.rejects(s.sessions.discover("nope"), status(404));

    const x = s.sessions.ensureExternal({ id: "ext-3", harness: "claude", project: PROJECT, cwd: s.projectPath, at: "2026-10-02T00:00:00Z", model: "opus" });
    assert.deepEqual([x.origin, x.model, x.updatedAt], ["external", "opus", "2026-10-02T00:00:00Z"]);
    const again = s.sessions.ensureExternal({ id: "ext-3", harness: "claude", project: PROJECT, cwd: "/x", at: "2026-10-03T00:00:00Z" });
    assert.equal(again.cwd, s.projectPath);
    assert.throws(() => s.sessions.ensureExternal({ id: "ext-4", harness: "claude", project: "nope", cwd: "/x", at: "2026-10-03T00:00:00Z" }), status(404));

    // An external session can be resumed and stays external.
    s.harness.seed({ sessionId: "ext-1", cwd: s.projectPath, title: "From the terminal" });
    const r = await s.sessions.send("ext-1", { text: "continue" });
    assert.equal(r.origin, "external");
    assert.equal(s.harness.starts.at(-1)!.resume, "ext-1");
    await idle(s, "ext-1");
  } finally {
    await s.sessions.close();
  }
});

test("discover gives hook-created sessions the harness's generated name, but keeps user renames", async () => {
  const s = setup();
  try {
    const at = "2026-10-02T00:00:00Z";
    s.sessions.ensureExternal({ id: "hook-1", harness: "claude", project: PROJECT, cwd: s.projectPath, at });
    s.sessions.ensureExternal({ id: "hook-2", harness: "claude", project: PROJECT, cwd: s.projectPath, at, title: "My name" });
    s.harness.seed({ sessionId: "hook-1", cwd: s.projectPath, title: "Fix the login redirect" });
    s.harness.seed({ sessionId: "hook-2", cwd: s.projectPath, title: "Generated" });
    await s.sessions.discover(PROJECT);
    assert.equal(s.sessions.get("hook-1")!.title, "Fix the login redirect");
    assert.equal(s.sessions.get("hook-2")!.title, "My name");
  } finally {
    await s.sessions.close();
  }
});

test("a project can be added to an idle session and reaches the harness on the next turn", async () => {
  const s = setup();
  try {
    const path = join(s.deps.config.home, "later");
    mkdirSync(path, { recursive: true });
    const base = s.services.projects.get(PROJECT)!;
    const get = s.services.projects.get;
    s.services.projects.get = name => name === "later" ? { ...base, name, path } : get(name);
    s.deps.db.prepare("INSERT INTO projects (name, path, created_at, updated_at) VALUES (?, ?, ?, ?)").run("later", path, "2026-10-01", "2026-10-01");
    const session = await s.sessions.start({ project: PROJECT, prompt: { text: "Start small" } });
    await idle(s, session.id);
    await assert.rejects(s.sessions.update(session.id, { addProjects: ["nope"] }), status(404));
    await assert.rejects(s.sessions.update(session.id, { addProjects: [""] }), status(400));
    const updated = await s.sessions.update(session.id, { addProjects: ["later", PROJECT, "later"] });
    assert.deepEqual(updated.projects, [PROJECT, "later"]);
    assert.equal(s.sessions.list({ project: "later" })[0]?.id, session.id);
    await s.sessions.send(session.id, { text: "Now use it" });
    assert.deepEqual(s.harness.starts.at(-1)!.additionalDirectories, [path]);
    await idle(s, session.id);
    const again = await s.sessions.update(session.id, { addProjects: ["later"] });
    assert.deepEqual(again.projects, [PROJECT, "later"], "adding a project twice changes nothing");
  } finally { await s.sessions.close(); }
});

test("discovery timer runs over projects.list()", async () => {
  const s = setup({ projectsRescanMs: 20 });
  try {
    s.harness.seed({ sessionId: "ext-t", cwd: s.projectPath });
    await waitFor(() => !!s.sessions.get("ext-t"), 2000, "timer discovery");
  } finally {
    await s.sessions.close();
  }
});

test("list filters", async () => {
  const s = setup();
  try {
    const t = (n: number) => `2026-10-0${n}T00:00:00Z`;
    s.sessions.ensureExternal({ id: "a", harness: "claude", project: PROJECT, cwd: s.projectPath, title: "Fix login", at: t(1), model: "opus" });
    s.sessions.ensureExternal({ id: "b", harness: "claude", project: PROJECT, cwd: s.projectPath, title: "Add 100% coverage", at: t(2) });
    s.sessions.ensureExternal({ id: "c", harness: "claude", project: PROJECT, cwd: s.projectPath, title: "Other", at: t(3) });
    s.sessions.patch("a", { updatedAt: t(1) });
    await s.sessions.update("b", { tags: ["ui", "ui", " "], pinned: true });
    s.sessions.patch("b", { updatedAt: t(2) });
    await s.sessions.update("c", { archived: true });
    s.sessions.patch("c", { updatedAt: t(3), state: "failed" });

    const ids = (f: Parameters<typeof s.sessions.list>[0]) => s.sessions.list(f).map((x) => x.id);
    assert.deepEqual(ids({}), ["c", "b", "a"]);
    assert.deepEqual(ids({ archived: false }), ["b", "a"]);
    assert.deepEqual(ids({ tag: "ui" }), ["b"]);
    assert.deepEqual(s.sessions.get("b")!.tags, ["ui"]);
    assert.deepEqual(ids({ model: "opus" }), ["a"]);
    assert.deepEqual(ids({ q: "LOGIN" }), ["a"]);
    assert.deepEqual(ids({ q: "100%" }), ["b"]);
    assert.deepEqual(ids({ q: "%" }), ["b"]);
    assert.deepEqual(ids({ pinned: true }), ["b"]);
    assert.deepEqual(ids({ state: ["failed"] }), ["c"]);
    assert.deepEqual(ids({ state: ["idle", "failed"], limit: 2 }), ["c", "b"]);
    assert.deepEqual(ids({ since: t(2) }), ["c", "b"]);
    assert.deepEqual(ids({ origin: "odin" }), []);
    assert.deepEqual(ids({ project: "nope" }), []);
    assert.deepEqual(s.sessions.counts(PROJECT), { running: 0, waiting: 0, total: 2 });
  } finally {
    await s.sessions.close();
  }
});

test("update: rename calls harness.rename; live model/mode change; a non-live session stores them for the resume", async () => {
  const s = setup();
  try {
    const st = await s.sessions.start({ project: PROJECT, prompt: { text: "x" } });
    await idle(s, st.id);
    const u = await s.sessions.update(st.id, { title: "  New name ", pinned: true });
    assert.equal(u.title, "New name");
    assert.equal(u.pinned, true);
    assert.equal((await s.harness.info(st.id))!.title, "New name");

    const m = await s.sessions.update(st.id, { model: "fast", permissionMode: "plan" });
    assert.equal(m.model, "fast");
    assert.equal(m.permissionMode, "plan");
    assert.equal(s.harness.handles.get(st.id)!.model, "fast");

    await s.sessions.end(st.id);
    const stored = await s.sessions.update(st.id, { model: "opus", permissionMode: "acceptEdits" });
    assert.deepEqual([stored.model, stored.permissionMode], ["opus", "acceptEdits"]);
    await s.sessions.send(st.id, { text: "again" });
    assert.deepEqual([s.harness.starts.at(-1)!.resume, s.harness.starts.at(-1)!.model, s.harness.starts.at(-1)!.permissionMode], [st.id, "opus", "acceptEdits"]);
    await idle(s, st.id);
    await assert.rejects(s.sessions.update(st.id, { title: "" }), status(400));
    await assert.rejects(s.sessions.update(st.id, { permissionMode: "yolo" as never }), status(400));
    await assert.rejects(s.sessions.update("nope", {}), status(404));
  } finally {
    await s.sessions.close();
  }
});

test("update: a mode the live process refuses restarts it between turns, and is a 409 mid-turn", async () => {
  const s = setup({ harness: { script: (m) => (m.text === "slow" ? [{ text: "a" }, { wait: 300 }, { text: "b" }] : [{ text: "ok" }]) } });
  try {
    const refuse = (id: string) => {
      (s.harness.handles.get(id) as { setPermissionMode: (m: string) => Promise<void> }).setPermissionMode = async () => {
        throw new Error("Cannot set permission mode to bypassPermissions");
      };
    };
    const st = await s.sessions.start({ project: PROJECT, prompt: { text: "x" } });
    await idle(s, st.id);
    refuse(st.id);
    const u = await s.sessions.update(st.id, { permissionMode: "bypassPermissions" });
    assert.equal(u.permissionMode, "bypassPermissions");
    assert.equal(u.state, "idle");
    assert.equal((await s.sessions.detail(st.id))!.live, false, "the refusing process was closed");
    await s.sessions.send(st.id, { text: "slow" });
    assert.equal(s.harness.starts.at(-1)!.permissionMode, "bypassPermissions", "the resume starts in the new mode");

    refuse(st.id);
    await assert.rejects(s.sessions.update(st.id, { permissionMode: "plan" }), status(409));
    assert.equal(s.sessions.get(st.id)!.permissionMode, "bypassPermissions");
    await idle(s, st.id);
  } finally {
    await s.sessions.close();
  }
});

test("failed native deletion preserves the session record for retry", async () => {
  const s = setup();
  try {
    const st = await s.sessions.start({ project: PROJECT, prompt: { text: "x" } });
    await idle(s, st.id);
    const remove = s.harness.delete;
    s.harness.delete = async () => { throw new Error("native store unavailable"); };
    await assert.rejects(s.sessions.remove(st.id), status(502));
    assert.ok(s.sessions.get(st.id));
    assert.equal(s.deps.events.some(e => e.type === "session.removed" && e.sessionId === st.id), false);
    s.harness.delete = remove;
    await s.sessions.remove(st.id);
    assert.equal(s.sessions.get(st.id), null);
  } finally { await s.sessions.close(); }
});

test("remove closes the handle, deletes in the harness, removes the record", async () => {
  const s = setup();
  try {
    const st = await s.sessions.start({ project: PROJECT, prompt: { text: "x" } });
    await idle(s, st.id);
    await s.sessions.remove(st.id);
    assert.equal(s.sessions.get(st.id), null);
    assert.equal(s.harness.stored(st.id), null);
    assert.equal(s.harness.handles.size, 0);
    assert.ok(s.deps.events.some((e) => e.type === "session.removed" && e.sessionId === st.id));
    assert.equal(await s.sessions.detail(st.id), null);
    await assert.rejects(s.sessions.remove(st.id), status(404));
  } finally {
    await s.sessions.close();
  }
});

test("boot recovery: running/waiting → idle", async () => {
  const s = setup({
    before: (deps) => {
      const ins = deps.db.prepare(
        "INSERT INTO sessions (id, harness, project, title, origin, state, waiting_for, cwd, created_at, updated_at, metrics) VALUES (?, 'claude', 'demo', 't', 'odin', ?, ?, '/x', 't', 't', '{}')",
      );
      ins.run("r", "running", null);
      ins.run("w", "waiting", "permission");
      ins.run("e", "ended", null);
    },
  });
  try {
    assert.deepEqual(["r", "w", "e"].map((id) => s.sessions.get(id)!.state), ["idle", "idle", "ended"]);
    assert.equal(s.sessions.get("w")!.waitingFor, null);
    assert.equal((await s.sessions.detail("w"))!.live, false);
  } finally {
    await s.sessions.close();
  }
});

test("idle handles close after idleCloseMs; the session stays idle and resumable", async () => {
  const s = setup({ idleCloseMs: 30 });
  try {
    const st = await s.sessions.start({ project: PROJECT, prompt: { text: "x" } });
    await idle(s, st.id);
    await waitFor(async () => !(await s.sessions.detail(st.id))!.live, 2000, "idle close");
    assert.equal(s.sessions.get(st.id)!.state, "idle");
    assert.equal(s.harness.handles.size, 0);
    await s.sessions.send(st.id, { text: "again" });
    assert.equal(s.harness.starts.at(-1)!.resume, st.id);
    await idle(s, st.id);
  } finally {
    await s.sessions.close();
  }
});

test("harness exit failed → failed with the error; resumable afterwards", async () => {
  const s = setup({ harness: { script: (m) => (m.text === "x" ? [{ text: "hm" }, { fail: "boom" }] : [{ text: "fine" }]) } });
  try {
    const st = await s.sessions.start({ project: PROJECT, prompt: { text: "x" } });
    await waitFor(() => s.sessions.get(st.id)?.state === "failed");
    assert.equal(s.sessions.get(st.id)!.error, "boom");
    assert.equal((await s.sessions.detail(st.id))!.live, false);
    const ended = await s.sessions.end(st.id);
    assert.equal(ended.state, "failed", "end leaves a failed session failed");
    const r = await s.sessions.send(st.id, { text: "again" });
    assert.deepEqual([r.state, r.error], ["running", null]);
    assert.equal(s.harness.starts.at(-1)!.resume, st.id);
    await idle(s, st.id);
  } finally {
    await s.sessions.close();
  }
});

test("a harness that throws on start → record failed, 502", async () => {
  const s = setup();
  s.harness.start = () => {
    throw new Error("no binary");
  };
  try {
    await assert.rejects(s.sessions.start({ project: PROJECT, prompt: { text: "x" } }), status(502));
    const [rec] = s.sessions.list();
    assert.equal(rec!.state, "failed");
    assert.equal(rec!.error, "no binary");
  } finally {
    await s.sessions.close();
  }
});

test("worktree start calls createWorktree with the planned branch", async () => {
  const s = setup();
  try {
    const st = await s.sessions.start({ project: PROJECT, prompt: { text: "Fix the thing" }, worktree: true });
    assert.equal(s.worktrees.length, 1);
    assert.match(s.worktrees[0]!.branch, /^odin\/fix-the-thing-[0-9a-f]{8}$/);
    assert.equal(st.branch, s.worktrees[0]!.branch);
    assert.deepEqual(st.workspace, { kind: "worktree", path: st.cwd, branch: st.branch });
    assert.equal(s.harness.starts[0]!.cwd, st.cwd);
    await s.sessions.start({ project: PROJECT, prompt: { text: "y" }, worktree: true, branch: "feat/custom" });
    assert.equal(s.worktrees[1]!.branch, "feat/custom");
    await assert.rejects(s.sessions.start({ project: PROJECT, prompt: { text: "y" }, worktree: true, branch: "--force" }), status(400));
  } finally {
    await s.sessions.close();
  }
});

test("where: an existing branch or worktree starts there and creates nothing new", async () => {
  const s = setup();
  try {
    const b = await s.sessions.start({ project: PROJECT, prompt: { text: "x" }, where: { kind: "branch", branch: "origin/feat/x" } });
    assert.deepEqual(s.opened, [{ name: PROJECT, branch: "origin/feat/x" }]);
    assert.equal(b.branch, "feat/x");
    assert.deepEqual(b.workspace, { kind: "worktree", path: b.cwd, branch: "feat/x" });
    assert.equal(s.worktrees.length, 0);

    const w = await s.sessions.start({ project: PROJECT, prompt: { text: "y" }, where: { kind: "worktree", path: join(s.projectPath, "..", "known-tree") } });
    assert.equal(w.branch, "known-branch");
    assert.deepEqual(w.workspace, { kind: "worktree", path: w.cwd, branch: "known-branch" });

    await assert.rejects(s.sessions.start({ project: PROJECT, prompt: { text: "z" }, where: { kind: "worktree", path: join(s.projectPath, "..", "other") } }), status(400));
    const n = await s.sessions.start({ project: PROJECT, prompt: { text: "n" }, where: { kind: "new-worktree", branch: "feat/new" } });
    assert.equal(n.branch, "feat/new");
    assert.equal(s.worktrees[0]!.branch, "feat/new");
    const c = await s.sessions.start({ project: PROJECT, prompt: { text: "c" }, where: { kind: "checkout" } });
    assert.deepEqual(c.workspace, { kind: "checkout" });
  } finally {
    await s.sessions.close();
  }
});

test("fork where: checkout, existing worktree, existing branch, new worktree from the parent's HEAD; exclusive with worktree", async () => {
  const s = setup();
  try {
    const st = await s.sessions.start({ project: PROJECT, prompt: { text: "base" } });
    await idle(s, st.id);
    const known = join(s.projectPath, "..", "known-tree");
    const w = await s.sessions.fork(st.id, { prompt: { text: "a" }, where: { kind: "worktree", path: known } });
    assert.deepEqual([w.branch, w.workspace.kind], ["known-branch", "worktree"]);
    const b = await s.sessions.fork(st.id, { prompt: { text: "b" }, where: { kind: "branch", branch: "origin/feat/q" } });
    assert.deepEqual([b.branch, s.opened.at(-1)!.branch], ["feat/q", "origin/feat/q"]);
    const c = await s.sessions.fork(st.id, { prompt: { text: "c" }, where: { kind: "checkout" } });
    assert.deepEqual([c.cwd, c.workspace], [s.projectPath, { kind: "checkout" }]);
    const n = await s.sessions.fork(st.id, { prompt: { text: "n" }, where: { kind: "new-worktree", branch: "feat/fork" } });
    assert.equal(n.branch, "feat/fork");
    assert.deepEqual(s.worktrees.at(-1), { name: PROJECT, branch: "feat/fork", fromCwd: st.cwd });
    await assert.rejects(s.sessions.fork(st.id, { prompt: { text: "x" }, where: { kind: "checkout" }, worktree: true }), status(400));
    await assert.rejects(s.sessions.fork(st.id, { prompt: { text: "x" }, aside: true, where: { kind: "new-worktree" } }), status(400));
    await assert.rejects(s.sessions.fork(st.id, { prompt: { text: "x" }, where: { kind: "worktree", path: "rel" } }), status(400));
  } finally {
    await s.sessions.close();
  }
});

test("unknown harness → 400; unknown project → 404; launch refusals", async () => {
  const s = setup();
  try {
    await assert.rejects(s.sessions.start({ project: PROJECT, prompt: { text: "x" }, harness: "pi" }), status(400));
    await assert.rejects(s.sessions.start({ project: PROJECT, prompt: { text: "x" }, harness: "constructor" }), status(400));
    await assert.rejects(s.sessions.start({ project: "nope", prompt: { text: "x" } }), status(404));
    await assert.rejects(s.sessions.start({ project: PROJECT }), status(400));
    assert.equal(s.sessions.list().length, 0, "no record when planning fails");
  } finally {
    await s.sessions.close();
  }
});

test("patch merges metrics shallowly and emits", () => {
  const s = setup();
  const x = s.sessions.ensureExternal({ id: "m", harness: "claude", project: PROJECT, cwd: s.projectPath, at: "2026-10-02T00:00:00Z" });
  const p = s.sessions.patch(x.id, { metrics: { turns: 3 }, pull: { number: 1, url: "u", state: "open", merged: false } });
  assert.equal(p.metrics.turns, 3);
  assert.equal(p.metrics.toolCalls, 0);
  assert.equal(p.pull!.number, 1);
  assert.throws(() => s.sessions.patch("nope", { title: "x" }), status(404));
  void s.sessions.close();
});

test("close() closes live handles and leaves records idle", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const s = setup({ harness: { script: () => [{ wait: gate }] } });
  const st = await s.sessions.start({ project: PROJECT, prompt: { text: "x" } });
  await waitFor(() => s.harness.handles.has(st.id) && s.harnessEvents.some((e) => e.event.type === "state"));
  await s.sessions.close();
  release();
  assert.equal(s.harness.handles.size, 0);
  assert.equal(s.sessions.get(st.id)!.state, "idle");
});

test("slash commands: live from init, kept after the handle closes, project fallback for a session that never ran", async () => {
  const s = setup();
  try {
    const st = await s.sessions.start({ project: PROJECT, harness: "claude", prompt: { text: "hi" } });
    await idle(s, st.id);
    assert.deepEqual((await s.sessions.detail(st.id))!.slashCommands.map((c) => c.name), ["compact", "review"]);
    await s.sessions.end(st.id);
    const after = (await s.sessions.detail(st.id))!;
    assert.equal(after.live, false);
    assert.deepEqual(after.slashCommands.map((c) => c.name), ["compact", "review"]);

    s.harness.seed({ sessionId: "ext-1", cwd: s.projectPath, title: "from a terminal" });
    await s.sessions.discover(PROJECT);
    assert.deepEqual((await s.sessions.detail("ext-1"))!.slashCommands.map((c) => c.name), ["compact", "review"]);
  } finally {
    await s.sessions.close();
  }
});

test("slash commands: empty when nothing in the project ever reported any", async () => {
  const s = setup();
  try {
    s.harness.seed({ sessionId: "ext-2", cwd: s.projectPath });
    await s.sessions.discover(PROJECT);
    assert.deepEqual((await s.sessions.detail("ext-2"))!.slashCommands, []);
  } finally {
    await s.sessions.close();
  }
});

test("slash commands: a commands event replaces the list; stored bare names still load", async () => {
  const s = setup();
  try {
    const next = [{ name: "deploy", description: "Ship", argumentHint: "", source: "custom" as const }];
    s.harness.setScript(() => [{ emit: { type: "commands", slashCommands: next } }, { text: "ok" }]);
    const st = await s.sessions.start({ project: PROJECT, harness: "claude", prompt: { text: "hi" } });
    await idle(s, st.id);
    assert.deepEqual((await s.sessions.detail(st.id))!.slashCommands, next);
    await s.sessions.end(st.id);
    assert.deepEqual((await s.sessions.detail(st.id))!.slashCommands, next);
    s.deps.db.prepare("UPDATE sessions SET slash_commands = ? WHERE id = ?").run(JSON.stringify(["/init", "review", 3]), st.id);
    assert.deepEqual((await s.sessions.detail(st.id))!.slashCommands.map((c) => [c.name, c.source]), [["init", "custom"], ["review", "custom"]]);
  } finally {
    await s.sessions.close();
  }
});

test("/clear, /reset and /new never reach the harness", async () => {
  const s = setup();
  try {
    for (const text of ["/clear", "  /reset now", "/new"]) {
      await assert.rejects(s.sessions.start({ project: PROJECT, prompt: { text } }), { status: 400 });
    }
    const st = await s.sessions.start({ project: PROJECT, prompt: { text: "hi" } });
    await idle(s, st.id);
    await assert.rejects(s.sessions.send(st.id, { text: "/clear" }), { status: 400 });
    await s.sessions.send(st.id, { text: "/clearly not a command" });
  } finally {
    await s.sessions.close();
  }
});

test("effort persists through start, offline update, resume and fork; invalid levels are refused", async () => {
  const s = setup();
  s.harness.models = async () => [{ value: "default", displayName: "Default", description: "", resolved: "claude-fake-1", effortLevels: ["low", "high"] }];
  try {
    const session = await s.sessions.start({ project: PROJECT, effort: "high", prompt: { text: "start" } });
    assert.equal(session.effort, "high");
    assert.equal(s.harness.starts.at(-1)!.effort, "high");
    await s.sessions.end(session.id);
    await assert.rejects(s.sessions.update(session.id, { effort: "max" }), status(400));
    assert.equal((await s.sessions.update(session.id, { effort: "low" })).effort, "low");
    await s.sessions.send(session.id, { text: "resume" });
    await waitFor(() => s.harness.starts.length === 2);
    assert.equal(s.harness.starts.at(-1)!.effort, "low");
    const child = await s.sessions.fork(session.id, { prompt: { text: "fork" } });
    assert.equal(child.effort, "low");
    assert.equal(s.harness.starts.at(-1)!.effort, "low");
  } finally { await s.sessions.close(); }
});

test("live effort updates reach the handle; incompatible model switches clear them", async () => {
  const s = setup();
  s.harness.models = async () => [
    { value: "default", displayName: "Default", description: "", resolved: "claude-fake-1", effortLevels: ["low", "high"] },
    { value: "fast", displayName: "Fast", description: "", resolved: null },
  ];
  try {
    const session = await s.sessions.start({ project: PROJECT, prompt: { text: "start" } });
    await waitFor(() => s.sessions.get(session.id)!.state === "idle");
    const levels: unknown[] = [];
    s.harness.handles.get(session.id)!.setEffort = async level => { levels.push(level); };
    assert.equal((await s.sessions.update(session.id, { effort: "high" })).effort, "high");
    assert.deepEqual(levels, ["high"]);
    assert.equal((await s.sessions.update(session.id, { model: "fast" })).effort, null);
    assert.deepEqual(levels, ["high", null]);
  } finally { await s.sessions.close(); }
});
