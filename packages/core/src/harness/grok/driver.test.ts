import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../../db/db.ts";
import type { HarnessEvent } from "@odin/shared/harness";
import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createGrokHarness } from "./driver.ts";
import type { Rpc, Wire } from "./transport.ts";

class FakeRpc implements Rpc {
  onMessage: (message: Wire) => void = () => {};
  onExit: (error: Error | null) => void = () => {};
  calls: { method: string; params: Wire }[] = [];
  replies: Wire[] = [];
  notes: Wire[] = [];
  closed = false;
  responses: Record<string, Wire | ((params: Wire) => Wire)> = {};
  async request(method: string, params: Wire = {}): Promise<Wire> {
    this.calls.push({ method, params });
    const preset = this.responses[method];
    if (typeof preset === "function") return preset(params);
    if (preset) return preset;
    if (method === "initialize") {
      return {
        authMethods: [{ id: "cached_token" }],
        _meta: { modelState: { availableModels: [{ modelId: "grok-4.7", name: "Grok 4.7", description: "frontier", _meta: { totalContextTokens: 256000 } }] } },
      };
    }
    if (method === "session/new") return { sessionId: "native-1" };
    if (method === "session/fork") return { sessionId: "native-fork" };
    if (method === "session/prompt") return { stopReason: "end_turn", _meta: { modelId: "grok-4.7", usage: { apiDurationMs: 20, inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cachedReadTokens: 0, cacheCreationTokens: 0, costUsdTicks: 0, modelUsage: { "grok-4.7": { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cachedReadTokens: 0, cacheCreationTokens: 0, costUsdTicks: 0 } } } } };
    return {};
  }
  respond(id: string | number, result: Wire) { this.replies.push({ id, result }); }
  notify(method: string, params: Wire = {}) { this.notes.push({ method, params }); }
  reject(id: string | number, message: string) { this.replies.push({ id, error: message }); }
  close() { this.closed = true; }
}

async function take(events: AsyncIterable<HarnessEvent>, stop: (event: HarnessEvent) => boolean) {
  const out: HarnessEvent[] = [];
  for await (const event of events) {
    out.push(event);
    if (stop(event)) break;
  }
  return out;
}

function setup(overrides: Partial<import("./driver.ts").GrokOptions> = {}) {
  const db = openDb(":memory:");
  const connections: FakeRpc[] = [];
  const harness = createGrokHarness({
    db,
    historyRoot: join(tmpdir(), "odin-grok-missing"),
    connect: () => {
      const rpc = new FakeRpc();
      connections.push(rpc);
      return rpc;
    },
    binary: () => "grok",
    version: async () => {},
    ...overrides,
  });
  return { db, connections, harness };
}

test("a new Grok session links the native id and streams a turn", async () => {
  const { db, connections, harness } = setup();
  const handle = harness.start({ cwd: "C:\\repo", sessionId: "odin-1", prompt: { text: "hi" }, permissionMode: "plan", model: "grok-4.7" });
  const rpc = connections[0]!;
  const original = rpc.request.bind(rpc);
  rpc.request = async (method, params = {}) => {
    if (method === "session/prompt") {
      rpc.calls.push({ method, params });
      rpc.onMessage({ method: "session/update", params: { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } } } });
      rpc.onMessage({ method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "pong" } } } });
      rpc.onMessage({ method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "call-1", title: "Read", status: "pending", rawInput: { path: "a.ts" } } } });
      rpc.onMessage({ method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed", content: [{ type: "text", text: "ok" }] } } });
      return { stopReason: "end_turn", _meta: { modelId: "grok-4.7", usage: { apiDurationMs: 40, modelUsage: { "grok-4.7": { inputTokens: 10, outputTokens: 2, reasoningTokens: 3, cachedReadTokens: 1, cacheCreationTokens: 0, costUsdTicks: 1e9 } } } } };
    }
    return original(method, params);
  };
  const events = await take(handle.events, (event) => event.type === "turn.end");
  assert.equal(events[0]?.type, "init");
  if (events[0]?.type === "init") {
    assert.equal(events[0].sessionId, "odin-1");
    assert.equal(events[0].permissionMode, "plan");
    assert.equal(events[0].model, "grok-4.7");
  }
  assert.ok(events.some((event) => event.type === "delta" && event.kind === "thinking" && event.text === "hmm"));
  assert.ok(events.some((event) => event.type === "entry" && event.entry.kind === "assistant" && event.entry.text === "pong"));
  assert.ok(events.some((event) => event.type === "tool.result" && event.toolUseId === "call-1" && event.result.ok && event.result.text === "ok"));
  const usage = events.find((event) => event.type === "usage");
  assert.ok(usage && usage.type === "usage" && usage.usage.output === 5 && usage.costUsd === 1);
  const end = events.at(-1);
  assert.deepEqual(end, { type: "turn.end", durationMs: 40, ok: true, error: null });
  const link = db.prepare("SELECT native_id FROM harness_session_links WHERE harness = 'grok' AND session_id = 'odin-1'").get() as { native_id: string };
  assert.equal(link.native_id, "native-1");
  assert.equal(rpc.calls.some((call) => call.method === "session/set_mode" && call.params.modeId === "plan"), true);
  assert.equal(rpc.calls.some((call) => call.method === "authenticate" && call.params.methodId === "cached_token"), true);
  await handle.close();
});

test("a mode change during startup replaces the initial mode", async () => {
  const { db, connections, harness } = setup();
  const handle = harness.start({ cwd: "C:\\repo", sessionId: "mode-race", permissionMode: "plan", prompt: { text: "hi" } });
  try {
    await handle.setPermissionMode("default");
    const events = await take(handle.events, (event) => event.type === "turn.end");
    const init = events.find((event) => event.type === "init");
    assert.equal(init?.type === "init" && init.permissionMode, "default");
    assert.deepEqual(connections[0]!.calls.filter((call) => call.method === "session/set_mode").map((call) => call.params.modeId), ["default"]);
  } finally {
    await handle.close();
    db.close();
  }
});

test("attachments become image and resource blocks, and a bad image is left out", async () => {
  const { connections, harness } = setup();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
  const handle = harness.start({
    cwd: "C:\\repo",
    sessionId: "odin-files",
    prompt: { text: "look", attachments: [{ name: "red.png", mediaType: "image/png", data: png }, { name: "x.svg", mediaType: "image/svg+xml", data: "<svg/>" }] },
  });
  const events = await take(handle.events, (event) => event.type === "turn.end");
  const prompt = connections[0]!.calls.find((call) => call.method === "session/prompt");
  assert.equal(prompt?.params.prompt[1]?.text, '<attachment name="red.png" media-type="image/png" />');
  assert.equal(prompt?.params.prompt[2]?.type, "image");
  assert.equal(prompt?.params.prompt.length, 3);
  assert.ok(events.some((event) => event.type === "notice" && event.text.includes("x.svg")));
  await handle.close();
});

test("cancel ends the turn as interrupted and a permission answer is returned", async () => {
  const { connections, harness } = setup();
  const handle = harness.start({ cwd: "C:\\repo", sessionId: "odin-2", prompt: { text: "edit" } });
  const rpc = connections[0]!;
  const original = rpc.request.bind(rpc);
  let release: (value: Wire) => void = () => {};
  rpc.request = (method, params = {}) => {
    if (method === "session/prompt") {
      rpc.calls.push({ method, params });
      rpc.onMessage({
        id: 7,
        method: "session/request_permission",
        params: { toolCall: { toolCallId: "call-9", title: "Bash", rawInput: { command: "npm test" } }, options: [{ optionId: "once", kind: "allow_once" }, { optionId: "no", kind: "reject_once" }] },
      });
      return new Promise((resolve) => { release = resolve; });
    }
    return original(method, params);
  };
  const waiting = await take(handle.events, (event) => event.type === "state" && event.state === "waiting");
  const request = waiting.find((event) => event.type === "permission.request");
  assert.ok(request && request.type === "permission.request" && request.request.canAlwaysAllow === false);
  handle.answer(request && request.type === "permission.request" ? request.request.id : "", { behavior: "deny" });
  assert.equal(rpc.replies[0]?.result.outcome.optionId, "no");
  release({ stopReason: "cancelled" });
  const rest = await take(handle.events, (event) => event.type === "turn.end");
  const end = rest.at(-1);
  assert.equal(end?.type, "turn.end");
  if (end?.type === "turn.end") assert.equal(end.error, "interrupted");
  await handle.interrupt();
  assert.equal(rpc.notes.some((note) => note.method === "session/cancel"), true);
  await handle.close();
});

test("Grok accepts service dispatch at idle and reports failed boundaries before idle", { timeout: 2000 }, async () => {
  const { db, connections, harness } = setup();
  const handle = harness.start({ cwd: "C:\\repo", prompt: { text: "one" } });
  const rpc = connections[0]!;
  rpc.responses["session/prompt"] = { stopReason: "cancelled" };
  const events: HarnessEvent[] = [];
  let idleCount = 0;
  try {
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === "state" && event.state === "idle") {
        idleCount++;
        if (idleCount === 2) break;
        // The service decides whether to resume; sending from this boundary must not get stuck in pump.
        rpc.responses["session/prompt"] = { stopReason: "end_turn" };
        handle.send({ text: "two" });
      }
    }
    const turns = events.filter(event => event.type === "turn.end");
    assert.deepEqual(turns.map(event => [event.ok, event.error]), [[false, "interrupted"], [true, null]]);
    assert.deepEqual(rpc.calls.filter(call => call.method === "session/prompt").map(call => call.params.prompt[0].text), ["one", "two"]);
  } finally { await handle.close(); db.close(); }
});

test("check reports availability without reading credentials", async () => {
  const { harness } = setup();
  assert.deepEqual(await harness.check(), { available: true, note: "Uses the existing Grok Build installation and login (grok)" });
  const missing = createGrokHarness({ db: openDb(":memory:"), connect: () => new FakeRpc(), binary: () => null, historyRoot: join(tmpdir(), "missing") });
  assert.equal((await missing.check()).available, false);
});

test("instructions and subagent guidance are sent as rules, and an explicit title is renamed", async () => {
  const { connections, harness } = setup();
  const handle = harness.start({
    cwd: "C:\\repo",
    sessionId: "odin-3",
    title: "My Task",
    agents: { reviewer: { description: "Reviews", prompt: "Look" } },
    instructions: "Be brief",
    prompt: { text: "hi" },
  });
  const events = await take(handle.events, (event) => event.type === "turn.end");
  assert.equal(events.some((event) => event.type === "notice"), false);
  const init = events.find((event) => event.type === "init");
  assert.deepEqual(init?.type === "init" ? init.agents : [], ["reviewer"]);
  const created = connections[0]!.calls.find((call) => call.method === "session/new");
  assert.match(String(created?.params._meta?.rules), /Be brief/);
  assert.match(String(created?.params._meta?.rules), /## reviewer/);
  assert.equal(connections[0]!.calls.some((call) => call.method === "x.ai/session/rename" && call.params.title === "My Task"), true);
  await handle.close();

  const resumed = harness.start({ cwd: "C:\\repo", resume: "existing", instructions: "Be brief", prompt: { text: "Explain the build" }, title: "Explain the build" });
  await take(resumed.events, (event) => event.type === "turn.end");
  const loaded = connections[1]!.calls.find((call) => call.method === "session/load");
  assert.match(String(loaded?.params._meta?.rules), /Be brief/);
  assert.equal(connections[1]!.calls.some((call) => call.method === "x.ai/session/rename"), false);
  await resumed.close();
});

test("resume ignores replay, separates text around tools and uses fresh streaming ids", async () => {
  const { harness, connections } = setup();
  const handle = harness.start({ cwd: "C:\\repo", resume: "existing", prompt: { text: "continue" } });
  const rpc = connections[0]!;
  const original = rpc.request.bind(rpc);
  const update = (data: Wire) => rpc.onMessage({ method: "session/update", params: { update: data } });
  rpc.request = async (method, params = {}) => {
    if (method === "session/load") {
      update({ sessionUpdate: "agent_message_chunk", content: { text: "old replay" } });
      update({ sessionUpdate: "tool_call", toolCallId: "old", title: "old tool" });
    }
    if (method === "session/prompt") {
      update({ sessionUpdate: "agent_message_chunk", content: { text: "Before" } });
      update({ sessionUpdate: "tool_call", toolCallId: "tool", title: "Read" });
      update({ sessionUpdate: "tool_call_update", toolCallId: "tool", rawInput: { path: "a.ts" }, status: "completed", content: [{ type: "content", content: { type: "text", text: "ok" } }] });
      update({ sessionUpdate: "agent_message_chunk", content: { text: "After" } });
    }
    return original(method, params);
  };
  const events = await take(handle.events, event => event.type === "turn.end");
  assert.equal(JSON.stringify(events).includes("old replay"), false);
  assert.equal(events.some(event => event.type === "entry" && event.entry.id === "old"), false);
  const entries = events.flatMap(event => event.type === "entry" ? [event.entry] : []);
  assert.deepEqual(entries.map(entry => entry.kind), ["assistant", "tool", "tool", "assistant"]);
  assert.notEqual(entries[0]?.id, entries.at(-1)?.id);
  const tool = entries[2];
  assert.ok(tool?.kind === "tool");
  assert.equal(tool.name, "Read");
  assert.deepEqual(tool.input, { path: "a.ts" });
  assert.equal(events.some(event => event.type === "tool.result" && event.result.text === "ok"), true);
  assert.deepEqual(rpc.calls.find(call => call.method === "initialize")?.params.clientCapabilities, {});
  await handle.close();
});

test("ACP plans become todos and unsupported requests receive a reply", async () => {
  const { harness, connections } = setup();
  const handle = harness.start({ cwd: "C:\\repo", prompt: { text: "plan" } });
  const rpc = connections[0]!;
  const original = rpc.request.bind(rpc);
  rpc.request = async (method, params = {}) => {
    if (method === "session/prompt") {
      rpc.onMessage({ method: "session/update", params: { update: { sessionUpdate: "plan", entries: [{ content: "Build", status: "in_progress", priority: "high" }, { content: "Invalid", status: "unexpected" }] } } });
      rpc.onMessage({ id: "unsupported", method: "terminal/create", params: {} });
    }
    return original(method, params);
  };
  const events = await take(handle.events, event => event.type === "turn.end");
  assert.deepEqual(events.find(event => event.type === "todos"), { type: "todos", todos: [{ content: "Build", status: "in_progress" }] });
  assert.deepEqual(rpc.replies, [{ id: "unsupported", error: "Unsupported client method" }]);
  await handle.close();
});

test("an unknown stored model does not fail resume, and a rejected model or mode still starts the turn", async () => {
  const { harness, connections } = setup();
  const resumed = harness.start({ cwd: "C:\\repo", resume: "existing", model: "grok-4.7-build", prompt: { text: "continue" } });
  const rpc = connections[0]!;
  const original = rpc.request.bind(rpc);
  rpc.request = async (method, params = {}) => {
    if (method === "session/load") {
      rpc.onMessage({ method: "_x.ai/session_notification", params: { update: { sessionUpdate: "model_changed", model_id: "grok-4.7" } } });
    }
    if (method === "session/prompt") {
      rpc.calls.push({ method, params });
      return { stopReason: "end_turn", _meta: { usage: { apiDurationMs: 1, modelUsage: { "grok-4.7-build": { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cachedReadTokens: 0, cacheCreationTokens: 0, costUsdTicks: 0 } } } } };
    }
    return original(method, params);
  };
  const events = await take(resumed.events, (event) => event.type === "turn.end");
  assert.equal(events[0]?.type, "init");
  if (events[0]?.type === "init") assert.equal(events[0].model, "grok-4.7");
  assert.equal(events.some((event) => event.type === "notice" && event.text.includes("grok-4.7-build")), false);
  assert.equal(rpc.calls.some((call) => call.method === "session/set_model"), false);
  const usage = events.find((event) => event.type === "usage");
  assert.equal(usage?.type === "usage" && usage.model, "grok-4.7");
  assert.equal(events.some((event) => event.type === "model"), false);
  assert.equal(events.at(-1)?.type, "turn.end");
  await resumed.close();

  const unknown = harness.start({ cwd: "C:\\repo", sessionId: "odin-unknown-model", model: "gpt-4", prompt: { text: "go" } });
  const unknownEvents = await take(unknown.events, (event) => event.type === "turn.end");
  assert.equal(unknownEvents.some((event) => event.type === "notice" && event.text.includes("gpt-4")), true);
  assert.equal(connections[1]!.calls.some((call) => call.method === "session/set_model"), false);
  await unknown.close();

  const started = harness.start({ cwd: "C:\\repo", sessionId: "odin-model", model: "grok-4.7", permissionMode: "plan", prompt: { text: "go" } });
  const second = connections[2]!;
  const secondOriginal = second.request.bind(second);
  second.request = async (method, params = {}) => {
    if (method === "session/set_model" || method === "session/set_mode") throw new Error("Invalid params: unknown model id (-32602)");
    return secondOriginal(method, params);
  };
  const continued = await take(started.events, (event) => event.type === "turn.end");
  assert.equal(continued.some((event) => event.type === "exit"), false);
  assert.equal(continued.at(-1)?.type, "turn.end");
  assert.equal(second.calls.some((call) => call.method === "session/prompt"), true);
  await started.close();
});


test("failed Grok authentication closes its transport and refuses later sends", async () => {
  const { db, connections, harness } = setup();
  const handle = harness.start({ cwd: "C:/repo", sessionId: "failed-start" });
  const rpc = connections[0]!;
  rpc.request = async () => { throw new Error("Authentication failed"); };
  try {
    const events = await take(handle.events, event => event.type === "exit");
    assert.equal(events.at(-1)?.type, "exit");
    assert.equal(rpc.closed, true);
    assert.throws(() => handle.send({ text: "late" }), /closed/);
    await handle.close();
  } finally { db.close(); }
});

test("closing Grok during initialization does not authenticate or create a session later", async () => {
  const { db, connections, harness } = setup();
  const handle = harness.start({ cwd: "C:/repo", sessionId: "closed-early" });
  try {
    await handle.close();
    await new Promise(resolve => setImmediate(resolve));
    const events = await take(handle.events, () => false);
    assert.deepEqual(events, [{ type: "exit", outcome: "closed", error: null }]);
    assert.equal(connections[0]!.closed, true);
    assert.deepEqual(connections[0]!.calls.map(call => call.method), ["initialize"]);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM harness_session_links").get()?.n, 0);
  } finally { db.close(); }
});

test("Grok discovery preserves local identity and includes native worktree histories", async () => {
  const root = mkdtempSync(join(tmpdir(), "odin-grok-discovery-"));
  const project = join(root, "repo"), worktree = join(root, "worktree");
  const { db, connections, harness } = setup({ historyRoot: join(root, "sessions"), directories: async () => [project, worktree, project] });
  const handle = harness.start({ cwd: project, sessionId: "odin-local" });
  try {
    await take(handle.events, event => event.type === "init");
    for (const [cwd, native] of [[project, "native-1"], [worktree, "outside-worktree"]]) {
      const dir = join(root, "sessions", encodeURIComponent(cwd!), native!);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "summary.json"), JSON.stringify({ info: { id: native, cwd }, updated_at: "2026-11-13T01:00:00.000Z" }));
      writeFileSync(join(dir, "chat_history.jsonl"), JSON.stringify({ type: "user", content: "hello" }));
    }
    const listed = await harness.list(project);
    assert.deepEqual(listed.map(info => info.sessionId).sort(), ["grok:outside-worktree", "odin-local"]);
    assert.deepEqual((await harness.list(project)).map(info => info.sessionId), listed.map(info => info.sessionId));
    assert.equal((await harness.info("odin-local", project))?.sessionId, "odin-local");
    assert.equal((await harness.messages("grok:outside-worktree", worktree)).length, 1);
    assert.equal(connections.length, 1, "discovery and history do not spawn Grok");
  } finally { await handle.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Grok cancels an unavailable once scope and stays waiting for remaining requests", async () => {
  const { db, connections, harness } = setup();
  const handle = harness.start({ cwd: "C:/repo" });
  try {
    await take(handle.events, event => event.type === "state" && event.state === "idle");
    const rpc = connections[0]!;
    for (const id of [1, 2]) rpc.onMessage({ id, method: "session/request_permission", params: { options: [{ optionId: "allow_always", kind: "allow_always" }] } });
    handle.answer("1", { behavior: "allow", scope: "once" });
    assert.deepEqual(rpc.replies[0], { id: 1, result: { outcome: { outcome: "cancelled" } } });
    const events = await take(handle.events, event => event.type === "permission.resolved");
    assert.equal(events.at(-1)?.type, "permission.resolved");
    const remaining = await take(handle.events, event => event.type === "state");
    assert.deepEqual(remaining, [{ type: "state", state: "waiting" }]);
  } finally { await handle.close(); db.close(); }
});

test("Grok effort uses model metadata independently of permission modes", async () => {
  const rpc = new FakeRpc();
  const s = setup({ connect: () => rpc });
  let handle: ReturnType<typeof s.harness.start> | undefined;
  try {
    rpc.responses.initialize = { authMethods: [{ id: "cached_token" }], _meta: { modelState: { availableModels: [{ modelId: "grok-4.7", _meta: { reasoningEffort: "medium", reasoningEfforts: [{ value: "low" }, { value: "medium", default: true }, { value: "high" }] } }] } } };
    handle = s.harness.start({ cwd: "/fixture", model: "grok-4.7", effort: "high" });
    const events = take(handle.events, e => e.type === "init");
    await events;
    assert.deepEqual((await s.harness.models())[0]!.effortLevels, ["low", "medium", "high"]);
    assert.ok(rpc.calls.some(c => c.method === "session/set_model" && c.params._meta?.reasoningEffort === "high"));
    await handle.setEffort!("low");
    await handle.setEffort!(null);
    const last = rpc.calls.filter(c => c.method === "session/set_model").at(-1)!;
    assert.equal(last.params._meta.reasoningEffort, "medium");
    assert.equal(rpc.calls.some(c => c.method === "session/set_mode"), false);
  } finally { await handle?.close(); s.db.close(); }
});

test("a background subagent holds the turn until it finishes and the wake turn completes", async () => {
  const { connections, harness } = setup();
  const handle = harness.start({ cwd: "C:\\repo", sessionId: "odin-sub", prompt: { text: "delegate" } });
  const rpc = connections[0]!;
  const original = rpc.request.bind(rpc);
  let prompts = 0;
  rpc.request = async (method, params = {}) => {
    if (method === "session/prompt") {
      prompts += 1;
      rpc.calls.push({ method, params });
      if (prompts === 1) {
        rpc.onMessage({ method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "spawn-1", name: "spawn_subagent", status: "completed", rawInput: { description: "Review" }, content: [{ type: "text", text: "started" }] } } });
        rpc.onMessage({ method: "session/update", params: { update: { sessionUpdate: "subagent_spawned", subagent_id: "child-1", attempt_id: "a1", description: "Review", child_session_id: "child-1" } } });
        setTimeout(() => {
          rpc.onMessage({ method: "_x.ai/session/update", params: { update: { sessionUpdate: "subagent_finished", subagent_id: "child-1", attempt_id: "a1", description: "Review", status: "completed", output: "done", will_wake: true } } });
          setTimeout(() => {
            rpc.onMessage({ method: "session/update", params: { update: { sessionUpdate: "turn_completed" } } });
          }, 30);
        }, 30);
      }
      return { stopReason: "end_turn", _meta: { usage: { apiDurationMs: 5, modelUsage: { "grok-4.7-build": { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cachedReadTokens: 0, cacheCreationTokens: 0, costUsdTicks: 0 } } } } };
    }
    return original(method, params);
  };
  const events: HarnessEvent[] = [];
  let sawRunning = false;
  for await (const event of handle.events) {
    events.push(event);
    if (event.type === "task" && event.task.state === "running") {
      sawRunning = true;
      assert.equal(event.task.toolUseId, "spawn-1");
      assert.equal(prompts, 1);
      handle.send({ text: "next" });
      assert.equal(rpc.calls.filter((call) => call.method === "session/prompt").length, 1);
    }
    if (events.filter((item) => item.type === "turn.end").length === 2) break;
  }
  assert.equal(sawRunning, true);
  assert.equal(prompts, 2);
  const usage = events.find((event) => event.type === "usage");
  assert.equal(usage?.type === "usage" && usage.model, "grok-4.7");
  const ends = events.filter((event) => event.type === "turn.end");
  assert.ok(events.findIndex((event) => event.type === "task" && event.task.state === "completed") < events.indexOf(ends[0]!));
  await handle.close();
});

test("rename uses the live session and a background command holds the turn", async () => {
  const { connections, harness } = setup();
  const handle = harness.start({ cwd: "C:\\repo", sessionId: "odin-bg", prompt: { text: "run" } });
  const rpc = connections[0]!;
  const original = rpc.request.bind(rpc);
  rpc.request = async (method, params = {}) => {
    if (method === "session/prompt") {
      rpc.calls.push({ method, params });
      rpc.onMessage({ method: "session/update", params: { update: { sessionUpdate: "task_backgrounded", task_id: "bash-1", tool_call_id: "call-1", command: "yarn test" } } });
      setTimeout(() => {
        rpc.onMessage({ method: "session/update", params: { update: { sessionUpdate: "task_completed", will_wake: false, task_snapshot: { task_id: "bash-1", command: "yarn test", exit_code: 0, output: "ok" } } } });
      }, 20);
      return { stopReason: "end_turn" };
    }
    return original(method, params);
  };
  const started = take(handle.events, (event) => event.type === "init");
  await started;
  await harness.rename(handle.sessionId, "Renamed title");
  assert.equal(rpc.calls.some((call) => call.method === "x.ai/session/rename" && call.params.title === "Renamed title"), true);
  const events = await take(handle.events, (event) => event.type === "turn.end");
  assert.equal(events.some((event) => event.type === "task" && event.task.kind === "command" && event.task.state === "completed"), true);
  assert.equal(events.at(-1)?.type, "turn.end");
  await handle.close();
});
