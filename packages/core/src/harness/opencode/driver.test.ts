import assert from "node:assert/strict";
import { test } from "node:test";
import type { OpenCodeClient, OpenCodeEvent, SessionInfo, SessionMessageInfo, SessionPromptInput, JobInfo } from "@opencode/client";
import type { HarnessEvent } from "@odin/shared/harness";
import { openDb } from "../../db/db.ts";
import { createOpenCodeHarness } from "./driver.ts";
import { EventQueue, messageEntries } from "./map.ts";

const tokens = { input: 10, output: 8, reasoning: 3, cache: { read: 2, write: 1 } };
const session = (id = "native-1"): SessionInfo => ({ id, projectID: "p", cost: 0, tokens, time: { created: 1000, updated: 2000 }, title: "Fixture", location: { directory: "C:\\repo" }, model: { providerID: "provider", id: "model" } });
async function until(predicate: () => boolean) { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); } assert.fail("Timed out waiting for fake driver"); }
function setup() {
  const db = openDb(":memory:");
  const streams: EventQueue<OpenCodeEvent>[] = [];
  const messages: SessionMessageInfo[] = [];
  const jobs: JobInfo[] = [];
  const agents = [{ id: "build", name: "Build", mode: "primary", hidden: false }];
  const resources: { agents: { name: string; description: string }[]; skills: { id: string; name: string; description: string }[] } = { agents: [], skills: [] };
  const prompts: SessionPromptInput[] = [];
  const calls: { method: string; input: unknown }[] = [];
  const messageLists: { sessionID: string; order?: string; cursor?: string; limit?: number }[] = [];
  const sessionLists: { directory: string; parentID?: string | null; order?: string; cursor?: string; limit?: number }[] = [];
  const sessions = new Map([["native-1", session()]]);
  const readyDirs: string[] = [];
  let sequence = 0;
  let closed = 0;
  let active = false;
  const call = async (method: string, input: unknown) => { calls.push({ method, input }); };
  const client = {
    event: { subscribe({ signal }: { signal: AbortSignal }) { const queue = new EventQueue<OpenCodeEvent>(); streams.push(queue); queue.push({ id: `connected-${++sequence}`, type: "server.connected", data: {} }); signal.addEventListener("abort", () => queue.end()); return queue; } },
    session: {
      create: async (input: unknown) => { await call("create", input); return session(); },
      get: async ({ sessionID }: { sessionID: string }) => { const item = sessions.get(sessionID); if (!item) throw Object.assign(new Error("Missing"), { status: 404 }); return item; },
      fork: async () => { const item = session("native-fork"); sessions.set(item.id, item); return item; },
      active: async () => active ? { "native-1": { type: "running" } } : {},
      list: async (input: { directory: string; parentID?: string | null; order?: string; cursor?: string; limit?: number }) => {
        sessionLists.push(input);
        const limit = input.limit ?? 100;
        const start = input.cursor ? Number(input.cursor) : 0;
        const data = [...sessions.values()].slice(start, start + limit);
        // The server emits a next cursor for every non-empty page, including the last short page.
        const next = data.length > 0 ? String(start + data.length) : undefined;
        return { data, cursor: { next } };
      },
      prompt: async (input: SessionPromptInput) => { prompts.push(input); active = true; return {}; },
      form: { list: async () => [], reply: (input: unknown) => call("form.reply", input), cancel: (input: unknown) => call("form.cancel", input) },
      switchAgent: (input: unknown) => call("agent", input), switchModel: (input: unknown) => call("model", input), update: (input: unknown) => call("update", input),
      interrupt: async (input: unknown) => { active = false; await call("interrupt", input); },
      compact: (input: unknown) => call("compact", input),
      command: (input: unknown) => call("command", input), shell: (input: unknown) => call("shell", input),
      revert: { stage: (input: unknown) => call("revert", input), clear: (input: unknown) => call("unrevert", input), commit: (input: unknown) => call("commitRevert", input) },
      remove: async (input: { sessionID: string }) => { await call("delete", input); if (!sessions.has(input.sessionID)) throw Object.assign(new Error("Missing"), { status: 404 }); sessions.delete(input.sessionID); },
      context: async () => messages, diff: async () => [],
    },
    message: { list: async (input: { sessionID: string; order?: string; cursor?: string; limit?: number }) => {
      messageLists.push(input);
      if (input.cursor && input.order) throw Object.assign(new Error("Cursor cannot be combined with order"), { status: 400 });
      const limit = input.limit ?? 100;
      const start = input.cursor ? Number(input.cursor) : 0;
      const data = messages.slice(start, start + limit);
      // The server emits a next cursor for every non-empty page, including the last short page.
      const next = data.length > 0 ? String(start + data.length) : undefined;
      return { data, cursor: { next } };
    } },
    agent: { list: async () => ({ data: agents }) },
    command: { list: async () => ({ data: [{ name: "review", description: "Review changes" }] }) },
    skill: { list: async () => ({ data: [] }) }, provider: { list: async () => ({ data: [{ id: "provider", name: "Provider", activation: "enabled" }] }) },
    mcp: { list: async () => ({ data: [] }) }, plugin: { list: async () => ({ data: [] }) },
    model: { list: async () => ({ data: [{ id: "model", providerID: "provider", modelID: "native-model", name: "Fixture", enabled: true, variants: [{ id: "deep" }] }] }) },
    permission: { list: async () => [], reply: (input: unknown) => call("permission.reply", input) },
    experimental: { job: { list: async () => jobs } },
  } as unknown as OpenCodeClient;
  const harness = createOpenCodeHarness({ db, directories: async path => [path], runtime: async () => ({ client, ready: async (cwd: string) => { readyDirs.push(cwd); }, resources: () => resources, prepare: async (id, opts) => { await call("prepare", { id, opts }); }, close: async () => { closed++; } }) });
  function emit(type: string, data: Record<string, unknown>) { streams.at(-1)!.push({ id: `e${++sequence}`, created: 3000, type, data, durable: { aggregateID: "native-1", seq: sequence, version: 1 } } as OpenCodeEvent); }
  function open(options = {}) { const handle = harness.start({ sessionId: "odin-1", cwd: "C:\\repo", ...options }); const events: HarnessEvent[] = []; void (async () => { for await (const event of handle.events) events.push(event); })(); return { handle, events }; }
  return { db, streams, messages, jobs, agents, resources, prompts, calls, messageLists, sessionLists, sessions, readyDirs, harness, emit, open, get closed() { return closed; }, set active(value: boolean) { active = value; } };
}

test("OpenCode links native identity, subscribes before admission, streams stable content and per-step usage", async () => {
  const f = setup();
  const { handle, events } = f.open({ prompt: { text: "hello" }, model: "provider/model", runtimeOptions: { agent: "build", variant: "deep" } });
  await until(() => f.prompts.length === 1);
  assert.equal(events[0]?.type, "init");
  assert.equal(f.db.prepare("SELECT native_id FROM harness_session_links WHERE session_id='odin-1'").get()?.native_id, "native-1");
  assert.equal(f.streams.length, 1);
  f.emit("session.execution.started", { sessionID: "native-1" });
  f.emit("session.step.started", { sessionID: "native-1", assistantMessageID: "assistant", model: { providerID: "provider", id: "active-model" }, agent: "build", started: 3000 });
  f.emit("session.text.delta", { sessionID: "native-1", assistantMessageID: "assistant", ordinal: 0, delta: "Hello" });
  f.emit("session.text.ended", { sessionID: "native-1", assistantMessageID: "assistant", ordinal: 0, text: "Hello" });
  f.emit("session.step.ended", { sessionID: "native-1", assistantMessageID: "assistant", tokens, cost: 0.04, finish: "stop" });
  f.active = false;
  f.emit("session.execution.succeeded", { sessionID: "native-1" });
  await until(() => events.some(event => event.type === "turn.end"));
  assert.equal(events.filter(event => event.type === "turn.end").length, 1);
  const usage = events.find(event => event.type === "usage");
  assert.deepEqual(usage && { model: usage.model, usage: usage.usage }, { model: "provider/active-model", usage: { input: 10, output: 8, cacheRead: 2, cacheWrite: 1 } });
  await handle.close(); await f.harness.close!(); f.db.close();
});

test("OpenCode admits only idle messages and keeps runtime alive when a handle closes", async () => {
  const f = setup(); const { handle, events } = f.open();
  await until(() => events.some(event => event.type === "state"));
  handle.send({ text: "first", clientId: "client-1", attachments: [{ name: "a.txt", mediaType: "text/plain", data: "contents" }] });
  assert.throws(() => handle.send({ text: "second" }), /processing/);
  await until(() => f.prompts.length === 1);
  assert.equal(f.prompts[0]?.files?.[0]?.uri, "data:text/plain;base64,Y29udGVudHM=");
  await handle.close(); assert.equal(f.closed, 0);
  assert.throws(() => handle.send({ text: "closed" }), /closed/);
  await f.harness.close!(); assert.equal(f.closed, 1); f.db.close();
});

test("OpenCode keeps native form fields and permission project semantics", async () => {
  const f = setup(); const { handle, events } = f.open();
  await until(() => events.some(event => event.type === "state"));
  f.emit("permission.asked", { id: "permission", sessionID: "native-1", action: "shell", resources: ["git status"], save: ["git *"] });
  await until(() => events.some(event => event.type === "permission.request"));
  handle.answer("permission", { behavior: "allow", scope: "project" });
  await until(() => f.calls.some(call => call.method === "permission.reply"));
  assert.deepEqual(f.calls.find(call => call.method === "permission.reply")?.input, { sessionID: "native-1", requestID: "permission", decision: "always" });
  f.emit("form.created", { form: { id: "form", sessionID: "native-1", title: "Details", fields: [{ key: "count", type: "integer", required: true }] } });
  await until(() => events.some(event => event.type === "permission.request" && event.request.id === "form:form"));
  const form = events.find(event => event.type === "permission.request" && event.request.id === "form:form");
  assert.ok(form?.type === "permission.request" && form.request.input.nativeForm);
  handle.answer("form:form", { behavior: "allow", scope: "once", updatedInput: { count: 3 } });
  await until(() => f.calls.some(call => call.method === "form.reply"));
  assert.deepEqual(f.calls.find(call => call.method === "form.reply")?.input, { sessionID: "native-1", formID: "form", answer: { count: 3 } });
  await f.harness.close!(); f.db.close();
});

test("OpenCode reconnect recovers history and leaves a lost delivery boundary uncertain", async () => {
  const f = setup(); const { handle, events } = f.open({ prompt: { text: "work" } });
  await until(() => f.prompts.length === 1);
  f.messages.push({ id: "recovered", type: "assistant", agent: "build", model: { providerID: "provider", id: "model" }, time: { created: 2000 }, content: [{ type: "text", text: "Recovered" }] });
  f.active = false; f.streams[0]!.end();
  await until(() => events.some(event => event.type === "turn.end"));
  assert.equal(f.streams.length, 2);
  assert.ok(events.some(event => event.type === "entry" && event.entry.kind === "assistant" && event.entry.text === "Recovered"));
  assert.ok(events.some(event => event.type === "turn.end" && !event.ok && event.error?.includes("disconnected")));
  await handle.close(); await f.harness.close!(); f.db.close();
});

test("OpenCode native actions use v2 stage/clear/commit and reject unsupported model variants", async () => {
  const f = setup(); const { handle, events } = f.open(); await until(() => events.some(event => event.type === "state"));
  await handle.nativeAction!({ type: "revert", messageId: "message", files: false });
  await handle.nativeAction!({ type: "unrevert" }); await handle.nativeAction!({ type: "commitRevert" });
  assert.deepEqual(f.calls.find(call => call.method === "revert")?.input, { sessionID: "native-1", messageID: "message", files: false });
  await assert.rejects(handle.setRuntimeOptions!({ variant: "invalid" }), /variant/);
  await assert.rejects(handle.setPermissionMode("bypassPermissions"), /native permission/);
  await f.harness.close!(); f.db.close();
});

test("OpenCode imports measurements idempotently and validates child ownership before reading", async () => {
  const f = setup(); await f.harness.list("C:\\repo");
  f.messages.push({ id: "assistant", type: "assistant", agent: "build", model: { providerID: "provider", id: "model" }, time: { created: 2000 }, tokens, cost: 0.03, content: [{ type: "text", text: "answer" }] });
  f.messages.push({ id: "compacted", type: "compaction", status: "completed", reason: "manual", time: { created: 2500 }, summary: "Short", tokens, cost: 0.01, model: { providerID: "provider", id: "model" } });
  const measured = await f.harness.measurements!("opencode:native-1");
  assert.ok(measured?.some(item => item.id === "usage:compacted"));
  assert.deepEqual(measured, await f.harness.measurements!("opencode:native-1"));
  f.sessions.set("child", { ...session("child"), parentID: "unrelated" });
  const child = await f.harness.taskMessages!("opencode:native-1", { taskId: "task", runId: null, kind: "agent", label: "child", state: "completed", childSessionId: "child", toolUseId: null, parentToolUseId: null, startedAt: null, completedAt: null, observedAt: null });
  assert.equal(child.status, "unavailable");
  const fork = await f.harness.fork("opencode:native-1"); assert.equal(fork, "opencode:native-fork");
  await f.harness.close!(); f.db.close();
});

test("OpenCode loads every message page without sending order and cursor together", async () => {
  const f = setup();
  for (let i = 0; i < 101; i++) f.messages.push({ id: `m${i}`, type: "user", time: { created: i }, text: String(i) });
  const transcript = await f.harness.messages("opencode:native-1");
  assert.equal(transcript.length, 101);
  assert.equal(f.messageLists.length, 2);
  assert.equal(f.messageLists[0]?.order, "asc");
  assert.equal(f.messageLists[0]?.cursor, undefined);
  assert.equal(f.messageLists[1]?.order, undefined);
  assert.equal(f.messageLists[1]?.cursor, "100");
  const short = setup();
  short.messages.push({ id: "only", type: "user", time: { created: 1 }, text: "hi" });
  const one = await short.harness.messages("opencode:native-1");
  assert.equal(one.length, 1);
  assert.equal(short.messageLists.length, 1);
  assert.equal(short.messageLists[0]?.order, "asc");
  assert.equal(short.messageLists[0]?.cursor, undefined);
  await f.harness.close!(); f.db.close();
  await short.harness.close!(); short.db.close();
});

test("OpenCode lists every session page without sending order and cursor together", async () => {
  const f = setup();
  for (let i = 0; i < 100; i++) f.sessions.set(`extra-${i}`, session(`extra-${i}`));
  const listed = await f.harness.list("C:\\repo");
  assert.equal(listed.length, 101);
  assert.equal(f.sessionLists.length, 2);
  assert.equal(f.sessionLists[0]?.order, "desc");
  assert.equal(f.sessionLists[0]?.cursor, undefined);
  assert.equal(f.sessionLists[1]?.order, undefined);
  assert.equal(f.sessionLists[1]?.cursor, "100");
  const short = setup();
  assert.equal((await short.harness.list("C:\\repo")).length, 1);
  assert.equal(short.sessionLists.length, 1);
  assert.equal(short.sessionLists[0]?.order, "desc");
  assert.equal(short.sessionLists[0]?.cursor, undefined);
  await f.harness.close!(); f.db.close();
  await short.harness.close!(); short.db.close();
});

test("OpenCode maps native history text, reasoning and tool errors with stable live identities", () => {
  const mapped = messageEntries({ id: "message", type: "assistant", agent: "build", model: { providerID: "p", id: "m" }, time: { created: 1000 }, content: [
    { type: "text", text: "answer" }, { type: "reasoning", text: "thought" },
    { type: "tool", id: "tool", name: "shell", time: { created: 1100, completed: 1200 }, state: { status: "error", input: { command: "false" }, error: { type: "tool", message: "failed" } } },
  ] });
  assert.deepEqual(mapped.map(entry => entry.id), ["message:0", "message:1", "tool"]);
  assert.deepEqual(mapped.map(entry => entry.kind), ["assistant", "thinking", "tool"]);
  assert.ok(mapped[2]?.kind === "tool" && mapped[2].result?.ok === false);
});

test("OpenCode task snapshots use native job lifetimes rather than completed delegation tools", async () => {
  const f = setup(); await f.harness.list("C:\\repo");
  f.messages.push({ id: "assistant", type: "assistant", agent: "build", model: { providerID: "provider", id: "model" }, time: { created: 1000 }, content: [
    { type: "tool", id: "launch", name: "subagent", time: { created: 1000, completed: 1100 }, state: { status: "completed", input: { description: "Research" }, content: [{ type: "text", text: "Started" }], metadata: { sessionID: "child", status: "running" } } },
  ] });
  f.jobs.push({ id: "child", kind: "subagent", sessionID: "native-1", childSessionID: "child", status: "running", time: { started: 1000 }, agent: "explore", description: "Research" });
  const transcript = await f.harness.messages("opencode:native-1");
  const task = transcript.find(entry => entry.kind === "task");
  assert.ok(task?.kind === "task");
  assert.equal(task.task.state, "running"); assert.equal(task.task.runId, "1000"); assert.equal(task.task.toolUseId, "launch"); assert.equal(task.task.completedAt, null);
  f.jobs[0]!.status = "completed"; f.jobs[0]!.time.completed = 2000;
  const next = (await f.harness.messages("opencode:native-1")).find(entry => entry.kind === "task");
  assert.ok(next?.kind === "task"); assert.equal(next.id, task.id); assert.equal(next.task.state, "completed"); assert.equal(next.task.completedAt, new Date(2000).toISOString());
  await f.harness.close!(); f.db.close();
});

test("OpenCode slash commands dispatch natively and close interrupts active native work", async () => {
  const f = setup(); const { handle, events } = f.open(); await until(() => events.some(event => event.type === "state"));
  handle.send({ text: "/review staged changes" }); await until(() => f.calls.some(call => call.method === "command"));
  assert.equal(f.prompts.length, 0); assert.deepEqual(f.calls.find(call => call.method === "command")?.input, { sessionID: "native-1", name: "review", text: "staged changes", files: undefined, delivery: "queue" });
  await handle.close(); assert.ok(f.calls.some(call => call.method === "interrupt"));
  await f.harness.close!(); f.db.close();
});

test("OpenCode finishes a manual compaction, lists models without the server directory, and deletes an absent native session", async () => {
  const f = setup();
  const { handle, events } = f.open();
  await until(() => events.some(event => event.type === "state"));
  const readyBeforeModels = f.readyDirs.length;
  assert.deepEqual((await f.harness.models()).map(model => model.value), ["provider/model"]);
  assert.equal(f.readyDirs.length, readyBeforeModels);
  await handle.nativeAction!({ type: "compact" });
  assert.equal(events.filter(event => event.type === "turn.end").length, 0);
  f.messages.push({ id: "compacted", type: "compaction", status: "completed", reason: "manual", time: { created: 2500 }, summary: "Short", tokens, cost: 0.01, model: { providerID: "provider", id: "model" } });
  f.emit("session.compaction.ended", { sessionID: "native-1", reason: "manual", text: "Short", tokens, cost: 0.01 });
  await until(() => events.some(event => event.type === "turn.end" && event.ok));
  assert.ok(events.some(event => event.type === "usage" && event.model === "provider/model"));
  handle.send({ text: "continue" });
  await until(() => f.prompts.length === 1);
  f.emit("session.execution.started", { sessionID: "native-1" });
  f.emit("session.compaction.ended", { sessionID: "native-1", reason: "auto", text: "Still working" });
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.filter(event => event.type === "turn.end").length, 1);
  await handle.close();
  f.sessions.delete("native-1");
  await f.harness.delete!("odin-1");
  assert.equal(f.db.prepare("SELECT native_id FROM harness_session_links WHERE session_id = 'odin-1'").get(), undefined);
  await f.harness.close!();
  f.db.close();
});

test("OpenCode restores the configured native agent order and clears a named variant", async () => {
  const f = setup(); f.agents.unshift({ id: "custom-default", name: "Default", mode: "primary", hidden: false });
  const { handle, events } = f.open({ runtimeOptions: { agent: "build", variant: "deep" } });
  await until(() => events.some(event => event.type === "state"));
  await handle.setRuntimeOptions!({ agent: null, variant: null });
  assert.deepEqual(f.calls.filter(call => call.method === "agent").at(-1)?.input, { sessionID: "native-1", agent: "custom-default" });
  assert.deepEqual(f.calls.filter(call => call.method === "model").at(-1)?.input, { sessionID: "native-1", model: { providerID: "provider", id: "model" } });
  await f.harness.close!(); f.db.close();
});

test("OpenCode projected library resources appear in init and dispatch skills with native identity", async () => {
  const f = setup(); f.resources.agents.push({ name: "library-reader", description: "Read" }); f.resources.skills.push({ id: "native-library-skill", name: "library-skill", description: "Inspect" });
  const { handle, events } = f.open({ additionalDirectories: ["C:\\other"] });
  await until(() => events.some(event => event.type === "state"));
  const init = events.find(event => event.type === "init"); assert.ok(init?.type === "init");
  assert.ok(init.agents.includes("library-reader")); assert.ok(init.slashCommands.some(command => command.name === "library-skill" && command.source === "library"));
  handle.send({ text: "/library-skill inspect files" }); await until(() => f.prompts.length === 1);
  assert.deepEqual(f.prompts[0]?.skills, [{ id: "native-library-skill" }]); assert.equal(f.prompts[0]?.text, "inspect files");
  const prepare = f.calls.find(call => call.method === "prepare")?.input as { opts: { instructions: string } };
  assert.match(prepare.opts.instructions, /C:\\other/); assert.match(prepare.opts.instructions, /native external_directory/);
  await f.harness.close!(); f.db.close();
});
