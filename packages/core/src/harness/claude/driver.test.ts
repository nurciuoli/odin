import { test } from "node:test";
import assert from "node:assert/strict";
import type { CanUseTool, Options, PermissionUpdate, Query, SDKSessionInfo, SDKUserMessage, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { HarnessEvent } from "@odin/shared/harness";
import { ODIN_MCP_SERVER } from "@odin/shared";
import { foldHarnessEvents } from "@odin/shared/transcript";
import { binaryPackages, createClaudeHarness, type ClaudeSdk } from "./driver.ts";
import { InputQueue } from "./input.ts";
import { hostToolDefinitions, paramsShape } from "./tools.ts";
import { z } from "zod";
import recording from "./fixtures/sdk-recording.json" with { type: "json" };

const SID = "4c7baeb7-3dd0-457b-93ab-4a07c9cf7c78";
const turn1 = recording.messages.slice(0, 29);
const turn2 = recording.messages.slice(29);

const tick = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

interface FakeQuery {
  query: ClaudeSdk["query"];
  /** Options of the last query() call. */
  options(): Options;
  /** User messages the driver wrote to the prompt stream. */
  received: SDKUserMessage[];
  promptEnded: boolean;
  /** Feed SDK messages to the driver (an Error makes the query throw). */
  emit(...messages: unknown[]): void;
  end(): void;
  interrupts: number;
  closed: boolean;
  efforts: unknown[];
  models: string[];
  modes: string[];
}

function fakeQuery(opts: { initialization?: unknown; throwOnStart?: string } = {}): FakeQuery {
  const out = new InputQueue<unknown>();
  let last: Options | undefined;
  const fq: FakeQuery = {
    query: (params) => {
      if (opts.throwOnStart) throw new Error(opts.throwOnStart);
      last = params.options;
      void (async () => {
        for await (const m of params.prompt as AsyncIterable<SDKUserMessage>) fq.received.push(m);
        fq.promptEnded = true;
      })();
      const gen = (async function* () {
        for await (const m of out) {
          if (m instanceof Error) throw m;
          yield m;
        }
      })();
      return Object.assign(gen, {
        interrupt: async () => {
          fq.interrupts++;
          return undefined;
        },
        close: () => {
          fq.closed = true;
          out.end();
        },
        applyFlagSettings: async (settings: unknown) => void fq.efforts.push(settings),
        setModel: async (m?: string) => void fq.models.push(m ?? ""),
        setPermissionMode: async (m: string) => void fq.modes.push(m),
        supportedModels: async () => recording.supportedModels,
        initializationResult: async () => opts.initialization ?? { commands: [], agents: [], models: [] },
      }) as unknown as Query;
    },
    options: () => last!,
    received: [],
    promptEnded: false,
    emit: (...messages) => messages.forEach((m) => out.push(m)),
    end: () => out.end(),
    interrupts: 0,
    closed: false,
    efforts: [],
    models: [],
    modes: [],
  };
  return fq;
}

function collect(events: AsyncIterable<HarnessEvent>) {
  const list: HarnessEvent[] = [];
  let ended = false;
  void (async () => {
    for await (const e of events) list.push(e);
    ended = true;
  })();
  return { list, ended: () => ended };
}

function harness(fq: FakeQuery, extra: Partial<ClaudeSdk> = {}, logs: string[] = []) {
  return createClaudeHarness({ sdk: { query: fq.query, ...extra }, log: (l) => logs.push(l), now: () => new Date("2026-11-11T01:00:00.000Z") });
}

function canUseTool(fq: FakeQuery): CanUseTool {
  return fq.options().canUseTool!;
}

test("start: query options follow the contract", async () => {
  const fq = fakeQuery();
  const h = harness(fq);
  const handle = h.start({
    cwd: "/fixture/proj",
    sessionId: "new-id",
    prompt: { text: "hello" },
    title: "T",
    model: "opus",
    instructions: "Follow global and project guidance.",
    agents: { reviewer: { description: "Reviews", prompt: "You review.", tools: ["Read"] } },
    mcpServers: { docs: { type: "http", url: "http://127.0.0.1:9/mcp" }, local: { type: "stdio", command: "srv", args: ["-x"] } },
    hostTools: [{ name: "post_artifact", description: "Post", params: { html: { type: "string", description: "HTML" } }, handler: async () => ({ text: "ok" }) }],
    additionalDirectories: ["/extra"],
  });
  assert.equal(handle.sessionId, "new-id");
  const o = fq.options();
  assert.equal(o.cwd, "/fixture/proj");
  assert.equal(o.sessionId, "new-id");
  assert.equal(o.resume, undefined);
  assert.equal(o.model, "opus");
  assert.equal(o.permissionMode, "default");
  assert.equal(o.allowDangerouslySkipPermissions, true, "so a live session can switch to bypassPermissions");
  assert.equal(o.includePartialMessages, true);
  assert.deepEqual(o.settingSources, ["user", "project", "local"]);
  assert.equal(o.agent, undefined);
  assert.deepEqual(o.systemPrompt, { type: "preset", preset: "claude_code", append: "Follow global and project guidance." });
  assert.deepEqual(o.agents, { reviewer: { description: "Reviews", prompt: "You review.", tools: ["Read"] } });
  assert.deepEqual(o.mcpServers?.docs, { type: "http", url: "http://127.0.0.1:9/mcp" });
  assert.deepEqual(o.mcpServers?.local, { type: "stdio", command: "srv", args: ["-x"] });
  const odin = o.mcpServers?.[ODIN_MCP_SERVER] as { type: string; name: string };
  assert.equal(odin.type, "sdk");
  assert.equal(odin.name, ODIN_MCP_SERVER);
  assert.deepEqual(o.additionalDirectories, ["/extra"]);
  assert.equal(o.title, "T");
  assert.equal(o.env, process.env);
  assert.equal(typeof o.canUseTool, "function");
  assert.equal(typeof o.stderr, "function");
  await handle.close();
});

test("resume and fork options; a plain resume keeps the resumed id", async () => {
  const fq = fakeQuery();
  const h = harness(fq);
  const r = h.start({ cwd: "/p", resume: SID, prompt: { text: "again" } });
  assert.equal(r.sessionId, SID);
  assert.equal(fq.options().resume, SID);
  assert.equal(fq.options().sessionId, undefined);
  assert.equal(fq.options().forkSession, undefined);
  await r.close();
  const f = h.start({ cwd: "/p", resume: SID, fork: true, sessionId: "fork-id", prompt: { text: "branch" }, permissionMode: "plan" });
  assert.equal(f.sessionId, "fork-id");
  assert.equal(fq.options().resume, SID);
  assert.equal(fq.options().sessionId, "fork-id");
  assert.equal(fq.options().forkSession, true);
  assert.equal(fq.options().permissionMode, "plan");
  await f.close();
});

test("a turn: init first, the sent message as a user entry, the recorded stream, idle; messages queue until the turn ends", async () => {
  const fq = fakeQuery();
  const h = harness(fq);
  const handle = h.start({ cwd: "/fixture/proj", resume: SID, prompt: { text: "Run ls" } });
  const ev = collect(handle.events);
  await tick();
  assert.equal(fq.received.length, 1);
  const first = fq.received[0]!;
  assert.deepEqual(first.message, { role: "user", content: "Run ls" });
  // Nothing before init.
  assert.equal(ev.list.length, 0);

  // Sent mid-turn: queued until the result.
  handle.send({ text: "say ok" });
  await tick();
  assert.equal(fq.received.length, 1);

  fq.emit(...turn1);
  await tick();
  assert.equal(fq.received.length, 2);
  const second = fq.received[1]!;
  assert.deepEqual(second.message, { role: "user", content: "say ok" });
  fq.emit(...turn2);
  await tick();

  assert.deepEqual(ev.list.map((e) => e.type), [
    "init", "state", "entry", "entry", "tool.result", "delta", "delta", "entry", "usage", "turn.end", "state",
    "state", "entry", "delta", "entry", "usage", "turn.end", "state",
  ]);
  assert.deepEqual(ev.list[2], { type: "entry", entry: { kind: "user", id: first.uuid, text: "Run ls", at: "2026-11-11T01:00:00.000Z", parentToolUseId: null } });
  assert.deepEqual(ev.list[12], { type: "entry", entry: { kind: "user", id: second.uuid, text: "say ok", at: "2026-11-11T01:00:00.000Z", parentToolUseId: null } });
  assert.deepEqual(foldHarnessEvents(ev.list).map((e) => e.kind), ["user", "tool", "assistant", "user", "assistant"]);
  assert.deepEqual(ev.list.filter((e) => e.type === "state").map((e) => e.type === "state" && e.state), ["running", "idle", "running", "idle"]);

  // supportedModels from the live query, cached.
  assert.deepEqual((await h.models()).slice(0, 2), [
    { value: "default", displayName: "Default (recommended)", description: "Fable 5.2", resolved: "claude-fable-5-2", effortLevels: ["low", "medium", "high", "xhigh", "max"] },
    { value: "opus", displayName: "Opus 5.5", description: "Best for everyday, complex tasks", resolved: "claude-opus-5-5", effortLevels: ["low", "medium", "high", "xhigh", "max"] },
  ]);

  await handle.close();
  await tick();
  assert.deepEqual(ev.list.at(-1), { type: "exit", outcome: "closed", error: null });
  assert.equal(ev.ended(), true);
});

test("models() with nothing cached asks an idle CLI for its catalog, sends no prompt and closes it", async () => {
  const fq = fakeQuery();
  const cold = await harness(fq).models();
  assert.equal(cold.find((m) => m.value === "opus")!.resolved, "claude-opus-5-5");
  assert.ok(cold.every((m) => m.resolved));
  assert.equal(fq.received.length, 0);
  assert.equal(fq.closed, true);
});

test("models() falls back to bare aliases when the CLI can't report its catalog", async () => {
  const logs: string[] = [];
  const h = harness(fakeQuery({ throwOnStart: "no claude here" }), {}, logs);
  assert.deepEqual((await h.models()).map((m) => [m.value, m.resolved, m.effortLevels]), [
    ["default", null, undefined], ["opus", null, undefined], ["sonnet", null, undefined], ["haiku", null, undefined],
  ]);
  assert.ok(logs.some((l) => l.includes("model catalog failed")));
});

test("Claude accepts the next service-dispatched message at the idle boundary", async () => {
  const fq = fakeQuery();
  const handle = harness(fq).start({ cwd: "/fixture/proj", resume: SID, prompt: { text: "one" } });
  let dispatched = false;
  const consume = (async () => {
    for await (const event of handle.events) {
      if (event.type === "state" && event.state === "idle" && !dispatched) {
        dispatched = true;
        handle.send({ text: "two" });
      }
    }
  })();
  try {
    fq.emit(...turn1);
    await tick();
    assert.equal(fq.received.length, 2);
    assert.deepEqual(fq.received[1]!.message, { role: "user", content: "two" });
  } finally { await handle.close(); await consume; }
});

async function runningHandle() {
  const fq = fakeQuery();
  const h = harness(fq);
  const handle = h.start({ cwd: "/fixture/proj", resume: SID, prompt: { text: "write" } });
  const ev = collect(handle.events);
  fq.emit(recording.messages[3], recording.messages[4]);
  await tick();
  return { fq, h, handle, ev };
}

const rec = recording.canUseToolCall;

test("answer: permission.request → waiting → resolved → running; the SDK gets the PermissionResult", async () => {
  const { fq, handle, ev } = await runningHandle();
  const ac = new AbortController();
  const pending = canUseTool(fq)(rec.toolName, rec.input, { ...rec.options, suggestions: rec.options.suggestions as PermissionUpdate[], signal: ac.signal });
  await tick();
  const n = ev.list.length;
  assert.deepEqual(ev.list.slice(n - 2).map((e) => e.type), ["permission.request", "state"]);
  const req = ev.list[n - 2]!;
  assert.ok(req.type === "permission.request");
  assert.equal(req.request.id, rec.options.requestId);
  assert.equal(req.request.sessionId, SID);
  assert.equal(req.request.createdAt, "2026-11-11T01:00:00.000Z");
  assert.deepEqual(ev.list[n - 1], { type: "state", state: "waiting" });

  handle.answer("unknown", { behavior: "allow", scope: "once" });
  handle.answer(rec.options.requestId, { behavior: "allow", scope: "session" });
  handle.answer(rec.options.requestId, { behavior: "deny" }); // already answered: ignored
  const result = await pending;
  assert.deepEqual(result, {
    behavior: "allow",
    updatedInput: rec.input,
    updatedPermissions: [
      { type: "addRules", rules: [{ toolName: "Write" }], behavior: "allow", destination: "session" },
      { type: "setMode", mode: "acceptEdits", destination: "session" },
    ],
    decisionClassification: "user_permanent",
  });
  await tick();
  assert.deepEqual(ev.list.slice(n), [
    { type: "permission.resolved", requestId: rec.options.requestId, behavior: "allow" },
    { type: "state", state: "running" },
  ]);
  await handle.close();
});

test("deny answers map to a deny result", async () => {
  const { fq, handle, ev } = await runningHandle();
  const pending = canUseTool(fq)("Bash", { command: "rm" }, { requestId: "r2", toolUseID: "t2", signal: new AbortController().signal });
  await tick();
  handle.answer("r2", { behavior: "deny", message: "no", interrupt: true });
  assert.deepEqual(await pending, { behavior: "deny", message: "no", interrupt: true, decisionClassification: "user_reject" });
  await tick();
  assert.ok(ev.list.some((e) => e.type === "permission.resolved" && e.behavior === "deny"));
  await handle.close();
});

test("abort: the SDK withdrawing a prompt resolves it cancelled", async () => {
  const { fq, handle, ev } = await runningHandle();
  const ac = new AbortController();
  const pending = canUseTool(fq)("Bash", { command: "ls" }, { requestId: "r3", toolUseID: "t3", signal: ac.signal });
  await tick();
  ac.abort();
  const result = (await pending)!;
  assert.equal(result.behavior, "deny");
  await tick();
  assert.deepEqual(ev.list.slice(-2), [
    { type: "permission.resolved", requestId: "r3", behavior: "cancelled" },
    { type: "state", state: "running" },
  ]);
  handle.answer("r3", { behavior: "allow", scope: "once" });
  await tick();
  assert.equal(ev.list.filter((e) => e.type === "permission.resolved").length, 1);
  await handle.close();
});

test("interrupt: cancels open prompts and interrupts the query; a no-op when idle", async () => {
  const { fq, handle, ev } = await runningHandle();
  const pending = canUseTool(fq)("Bash", { command: "ls" }, { requestId: "r4", toolUseID: "t4", signal: new AbortController().signal });
  await tick();
  await handle.interrupt();
  assert.equal(fq.interrupts, 1);
  assert.equal((await pending)?.behavior, "deny");
  assert.ok(ev.list.some((e) => e.type === "permission.resolved" && e.requestId === "r4" && e.behavior === "cancelled"));
  // What the CLI really sends after an interrupt: a diagnostic, not the word "interrupted".
  fq.emit({ type: "result", subtype: "error_during_execution", duration_ms: 5, is_error: true, errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"], modelUsage: {} });
  await tick();
  assert.deepEqual(ev.list.slice(-2), [
    { type: "turn.end", durationMs: 5, ok: false, error: "interrupted" },
    { type: "state", state: "idle" },
  ]);
  await handle.interrupt();
  assert.equal(fq.interrupts, 1);
  await handle.close();
});

test("interrupt: only the interrupted turn is a stop; a later failure keeps its error", async () => {
  const { fq, handle, ev } = await runningHandle();
  await handle.interrupt();
  fq.emit({ type: "result", subtype: "error_during_execution", duration_ms: 5, is_error: true, errors: ["[ede_diagnostic] x"], modelUsage: {} });
  await tick();
  assert.deepEqual(ev.list.findLast((e) => e.type === "turn.end"), { type: "turn.end", durationMs: 5, ok: false, error: "interrupted" });
  handle.send({ text: "again" });
  await tick();
  fq.emit({ type: "result", subtype: "error_during_execution", duration_ms: 7, is_error: true, errors: ["boom"], modelUsage: {} });
  await tick();
  assert.deepEqual(ev.list.findLast((e) => e.type === "turn.end"), { type: "turn.end", durationMs: 7, ok: false, error: "boom" });
  await handle.close();
});

test("close: cancels prompts, ends the input, closes the query, one exit; later calls are ignored", async () => {
  const { fq, handle, ev } = await runningHandle();
  const pending = canUseTool(fq)("Bash", { command: "ls" }, { requestId: "r5", toolUseID: "t5", signal: new AbortController().signal });
  await tick();
  await handle.close();
  await handle.close();
  assert.equal((await pending)?.behavior, "deny");
  handle.send({ text: "late" });
  await tick();
  assert.equal(fq.closed, true);
  assert.equal(fq.promptEnded, true);
  assert.equal(fq.received.length, 1);
  assert.deepEqual(ev.list.slice(-2), [
    { type: "permission.resolved", requestId: "r5", behavior: "cancelled" },
    { type: "exit", outcome: "closed", error: null },
  ]);
  assert.equal(ev.list.filter((e) => e.type === "exit").length, 1);
  assert.equal(ev.ended(), true);
  // canUseTool after close is refused at once.
  assert.equal((await canUseTool(fq)("Bash", {}, { requestId: "r6", toolUseID: "t6", signal: new AbortController().signal }))?.behavior, "deny");
});

test("a thrown query exits failed with the message; an ended one exits failed too", async () => {
  const logs: string[] = [];
  const fq = fakeQuery();
  const h = harness(fq, {}, logs);
  const handle = h.start({ cwd: "/p", sessionId: "s1", prompt: { text: "x" } });
  const ev = collect(handle.events);
  fq.emit(recording.messages[3], new Error("Claude Code process exited with code 1"));
  await tick();
  assert.deepEqual(ev.list.at(-1), { type: "exit", outcome: "failed", error: "Claude Code process exited with code 1" });
  assert.equal(ev.ended(), true);
  assert.ok(logs.some((l) => l.includes("process exited")));

  const fq2 = fakeQuery();
  const handle2 = harness(fq2).start({ cwd: "/p", sessionId: "s2", prompt: { text: "x" } });
  const ev2 = collect(handle2.events);
  fq2.end();
  await tick();
  assert.deepEqual(ev2.list, [{ type: "exit", outcome: "failed", error: "claude exited" }]);

  const handle3 = harness(fakeQuery({ throwOnStart: "spawn failed" })).start({ cwd: "/p", prompt: { text: "x" } });
  const ev3 = collect(handle3.events);
  await tick();
  assert.deepEqual(ev3.list, [{ type: "exit", outcome: "failed", error: "spawn failed" }]);
});

test("stderr is logged, never emitted", async () => {
  const logs: string[] = [];
  const fq = fakeQuery();
  const handle = harness(fq, {}, logs).start({ cwd: "/p", sessionId: "abcdef123", prompt: { text: "x" } });
  const ev = collect(handle.events);
  fq.options().stderr!("warning one\n\nwarning two\n");
  assert.deepEqual(logs, ["[claude abcdef12] warning one", "[claude abcdef12] warning two"]);
  await handle.close();
  await tick();
  assert.ok(!JSON.stringify(ev.list).includes("warning"));
});

test("a reattach without a prompt announces the session from the initialize response and goes idle", async () => {
  const fq = fakeQuery({ initialization: { commands: [{ name: "review" }], agents: [{ name: "Explore" }], models: [] } });
  const handle = harness(fq).start({ cwd: "/p", resume: SID, model: "sonnet" });
  const ev = collect(handle.events);
  await tick();
  assert.deepEqual(ev.list, [
    { type: "init", sessionId: SID, model: "sonnet", permissionMode: "default", cwd: "/p", tools: [], slashCommands: [{ name: "review", description: "", argumentHint: "", source: "custom" }], agents: ["Explore"] },
    { type: "state", state: "idle" },
  ]);
  assert.equal(fq.received.length, 0);
  // The real init on the next turn only reports what changed.
  handle.send({ text: "hi" });
  fq.emit(recording.messages[3]);
  await tick();
  assert.deepEqual(ev.list.slice(2).map((e) => e.type), ["state", "entry", "model"]);
  await handle.close();
});

test("setModel and setPermissionMode go to the query and emit events", async () => {
  const { fq, handle, ev } = await runningHandle();
  await handle.setModel("haiku");
  await handle.setPermissionMode("acceptEdits");
  assert.deepEqual(fq.models, ["haiku"]);
  assert.deepEqual(fq.modes, ["acceptEdits"]);
  assert.deepEqual(ev.list.slice(-2), [{ type: "model", model: "haiku" }, { type: "permission.mode", mode: "acceptEdits" }]);
  await handle.close();
  await assert.rejects(handle.setModel("opus"));
});

test("deleting an absent Claude session succeeds but existing-session failures propagate", async () => {
  const failure = new Error("delete failed");
  let exists = false;
  const h = harness(fakeQuery(), {
    deleteSession: async () => { throw failure; },
    getSessionInfo: async () => exists ? recording.listSessionsEntry as SDKSessionInfo : undefined,
  });
  await h.delete(SID, "/fixture/proj");
  exists = true;
  await assert.rejects(h.delete(SID, "/fixture/proj"), error => error === failure);
});

test("history functions call the SDK with the project dir and map the results", async () => {
  const calls: unknown[][] = [];
  const older: SDKSessionInfo = { sessionId: "old", summary: "Old summary", lastModified: 1_000, firstPrompt: "first" };
  const fq = fakeQuery();
  const h = harness(fq, {
    listSessions: async (o) => {
      calls.push(["list", o]);
      return [older, recording.listSessionsEntry as SDKSessionInfo];
    },
    getSessionInfo: async (id, o) => {
      calls.push(["info", id, o]);
      return id === SID ? (recording.listSessionsEntry as SDKSessionInfo) : undefined;
    },
    getSessionMessages: async (id, o) => {
      calls.push(["messages", id, o]);
      return [{ type: "user", uuid: "u1", session_id: id, message: { role: "user", content: "hi" }, parent_tool_use_id: null, parent_agent_id: null }] as SessionMessage[];
    },
    renameSession: async (id, title, o) => void calls.push(["rename", id, title, o]),
    forkSession: async (id, o) => {
      calls.push(["fork", id, o]);
      return { sessionId: "forked" };
    },
    deleteSession: async (id, o) => void calls.push(["delete", id, o]),
  });
  const list = await h.list("/fixture/proj");
  assert.deepEqual(list, [
    {
      sessionId: SID,
      title: "Probe session",
      firstPrompt: "Create a file hello.txt containing the word hi, using the Write tool. Then say done.",
      cwd: "/fixture/proj",
      gitBranch: "master",
      createdAt: new Date(1794357298497).toISOString(),
      updatedAt: new Date(1794357324450).toISOString(),
    },
    { sessionId: "old", title: "Old summary", firstPrompt: "first", cwd: null, gitBranch: null, createdAt: null, updatedAt: new Date(1000).toISOString() },
  ]);
  assert.equal((await h.info(SID, "/fixture/proj"))?.title, "Probe session");
  assert.equal(await h.info("nope"), null);
  assert.deepEqual(await h.messages(SID, "/fixture/proj"), [{ kind: "user", id: "u1", text: "hi", at: null, parentToolUseId: null }]);
  await h.rename(SID, "New", "/fixture/proj");
  assert.equal(await h.fork(SID, "/fixture/proj"), "forked");
  await h.delete(SID);
  assert.deepEqual(calls, [
    ["list", { dir: "/fixture/proj", includeWorktrees: true }],
    ["info", SID, { dir: "/fixture/proj" }],
    ["info", "nope", undefined],
    ["messages", SID, { dir: "/fixture/proj", includeSystemMessages: true }],
    ["rename", SID, "New", { dir: "/fixture/proj" }],
    ["fork", SID, { dir: "/fixture/proj" }],
    ["delete", SID, undefined],
  ]);
});

test("forkAt cuts the stored conversation at the message before the user message", async () => {
  const calls: unknown[][] = [];
  const message = (type: string, uuid: string) => ({ type, uuid, session_id: SID, message: { role: type, content: "x" }, parent_tool_use_id: null, parent_agent_id: null });
  const h = harness(fakeQuery(), {
    getSessionMessages: async () => [message("user", "u1"), message("assistant", "a1"), message("user", "u2"), message("assistant", "a2")] as SessionMessage[],
    forkSession: async (id, o) => {
      calls.push(["fork", id, o]);
      return { sessionId: "forked" };
    },
  });
  assert.equal(h.capabilities?.checkpoints?.forkAt, true);
  assert.equal(await h.forkAt!(SID, "u2", "/fixture/proj"), "forked");
  assert.equal(await h.forkAt!(SID, "u2:typed"), "forked");
  assert.deepEqual(calls, [["fork", SID, { dir: "/fixture/proj", upToMessageId: "a1" }], ["fork", SID, { upToMessageId: "a1" }]]);
  await assert.rejects(h.forkAt!(SID, "a1"), /not a user message/);
  await assert.rejects(h.forkAt!(SID, "u1"), /nothing before the first message/);
});

test("check(): a Settings override is read at each check and reported as the path used", async () => {
  let override: string | null = null;
  const h = createClaudeHarness({ resolvePackage: (s) => `/nm/${s}`, toolOverride: () => override });
  assert.deepEqual(await h.check(), { available: true, note: "auth: inherited from the environment" });
  override = "/definitely/not/here/claude";
  assert.deepEqual(await h.check(), { available: false, note: "claude executable not found at /definitely/not/here/claude" });
  override = process.execPath;
  assert.deepEqual(await h.check(), { available: true, note: `auth: inherited from the environment (${process.execPath})` });
});

test("check(): available when the platform binary package resolves; the note never carries credentials", async () => {
  const yes = createClaudeHarness({ resolvePackage: (s) => `/nm/${s}` });
  assert.deepEqual(await yes.check(), { available: true, note: "auth: inherited from the environment" });
  const no = createClaudeHarness({
    resolvePackage: () => {
      throw new Error("not found");
    },
  });
  const r = await no.check();
  assert.equal(r.available, false);
  assert.match(r.note ?? "", /no Claude Code binary/);
  const missing = createClaudeHarness({ pathToClaudeCodeExecutable: "/definitely/not/here/claude" });
  assert.equal((await missing.check()).available, false);
  assert.deepEqual(binaryPackages("linux", "x64"), ["@anthropic-ai/claude-agent-sdk-linux-x64", "@anthropic-ai/claude-agent-sdk-linux-x64-musl"]);
  assert.deepEqual(binaryPackages("darwin", "arm64"), ["@anthropic-ai/claude-agent-sdk-darwin-arm64"]);
});

test("host tools: zod schemas from params; handler text, isError and thrown errors", async () => {
  const shape = paramsShape({
    title: { type: "string", description: "Title" },
    count: { type: "number", description: "N", optional: true },
    draft: { type: "boolean", description: "Draft" },
  });
  const schema = z.object(shape);
  assert.deepEqual(schema.parse({ title: "a", draft: false }), { title: "a", draft: false });
  assert.throws(() => schema.parse({ title: 1, draft: false }));
  assert.equal(shape.title!.description, "Title");

  const seen: unknown[] = [];
  const [ok, bad, boom] = hostToolDefinitions([
    { name: "ok", description: "d", params: {}, handler: async (input) => (seen.push(input), { text: "done" }) },
    { name: "bad", description: "d", params: {}, handler: async () => ({ text: "nope", isError: true }) },
    {
      name: "boom",
      description: "d",
      params: {},
      handler: async () => {
        throw new Error("exploded");
      },
    },
  ]);
  assert.deepEqual(await ok!.handler({ a: 1 }, {}), { content: [{ type: "text", text: "done" }] });
  assert.deepEqual(seen, [{ a: 1 }]);
  assert.deepEqual(await bad!.handler({}, {}), { content: [{ type: "text", text: "nope" }], isError: true });
  assert.deepEqual(await boom!.handler({}, {}), { content: [{ type: "text", text: "Odin host tool failed" }], isError: true });
});

test("Claude effort uses query options and session-only flag settings", async () => {
  const fq = fakeQuery();
  const h = createClaudeHarness({ sdk: { query: fq.query } as ClaudeSdk });
  const handle = h.start({ cwd: "/fixture", effort: "high" });
  assert.equal(fq.options().effort, "high");
  await handle.setEffort!("max");
  await handle.setEffort!(null);
  assert.deepEqual(fq.efforts, [{ effortLevel: "max" }, { effortLevel: null }]);
  await handle.close();
});

test("an abort result the driver didn't ask for is an interrupt; the SDK's error-result throw after it is not a failure", async () => {
  const { fq, handle, ev } = await runningHandle();
  fq.emit({ type: "result", subtype: "error_during_execution", duration_ms: 5, is_error: true, terminal_reason: "aborted_tools", errors: ["[ede_diagnostic] x"], modelUsage: {} });
  await tick();
  assert.deepEqual(ev.list.findLast((e) => e.type === "turn.end"), { type: "turn.end", durationMs: 5, ok: false, error: "interrupted" });
  fq.emit(new Error("Claude Code returned an error result: [ede_diagnostic] x"));
  await tick();
  const exits = ev.list.filter((e) => e.type === "exit");
  assert.deepEqual(exits, [{ type: "exit", outcome: "closed", error: null }]);
  await handle.close();
});

test("an error-result throw without an abort result still fails the session", async () => {
  const { fq, ev } = await runningHandle();
  fq.emit(new Error("Claude Code returned an error result: boom"));
  await tick();
  assert.deepEqual(ev.list.filter((e) => e.type === "exit"), [{ type: "exit", outcome: "failed", error: "Claude Code returned an error result: boom" }]);
});
