import { test } from "node:test";
import assert from "node:assert/strict";
import type { HarnessEvent } from "@odin/shared/harness";
import { foldHarnessEvents } from "@odin/shared/transcript";
import { commandsKnown, createMapState, mapMessage, type MapState } from "./map.ts";
import recording from "./fixtures/sdk-recording.json" with { type: "json" };
import hand from "./fixtures/hand-built.json" with { type: "json" };
import fx from "./fixtures/interrupt.json" with { type: "json" };

const SID = "4c7baeb7-3dd0-457b-93ab-4a07c9cf7c78";

function run(messages: unknown[], state: MapState = createMapState(), sent?: Set<string>): HarnessEvent[] {
  return messages.flatMap((m) => mapMessage(state, m as Record<string, unknown>, sent));
}

test("the recorded session maps to the exact event stream", () => {
  const events = run(recording.messages);
  const bashId = "toolu_01NXFULWszHTJHLww2fxBTof";
  const reply1 = "msg_011CgvCmPac1WmP9JbxG3CCz:0";
  const reply2 = "msg_011CgvCmbwFM5XqZkmKN8RA1:0";
  assert.deepEqual(events, [
    {
      type: "init",
      sessionId: SID,
      model: "claude-fable-5-2",
      permissionMode: "default",
      cwd: "/fixture/proj",
      tools: ["Task", "Artifact", "ArtifactComments", "ArtifactData", "AskUserQuestion", "Bash", "CronCreate", "CronDelete", "CronList", "DesignSync", "Edit", "EnterPlanMode"],
      slashCommands: ["deep-research", "design", "slides", "design-sync", "dataviz"].map((name) => ({ name, description: "", argumentHint: "", source: "custom" as const })),
      agents: ["claude", "claude-code-guide", "Explore", "general-purpose", "Plan", "statusline-setup"],
    },
    { type: "state", state: "running" },
    {
      type: "entry",
      entry: { kind: "tool", id: bashId, name: "Bash", input: { command: "ls", description: "List files in current directory" }, at: "2026-11-11T00:35:39.400Z", parentToolUseId: null },
    },
    { type: "tool.result", toolUseId: bashId, result: { ok: true, text: "hello.txt", truncated: false } },
    { type: "delta", entryId: reply1, kind: "assistant", text: "The output is:\n\n```\nh", parentToolUseId: null },
    { type: "delta", entryId: reply1, kind: "assistant", text: "ello.txt\n```", parentToolUseId: null },
    {
      type: "entry",
      entry: { kind: "assistant", id: reply1, text: "The output is:\n\n```\nhello.txt\n```", model: "claude-fable-5-2", at: "2026-11-11T00:35:41.106Z", parentToolUseId: null },
    },
    {
      type: "usage",
      model: "claude-fable-5-2",
      usage: { input: 10, output: 227, cacheRead: 98163, cacheWrite: 32902 },
      cumulative: false,
      costUsd: 0.5552246,
      contextTokens: 2 + 32816 + 86,
    },
    { type: "turn.end", durationMs: 5762, ok: true, error: null },
    { type: "state", state: "idle" },
    // Turn 2: the re-sent init is not re-emitted (same model and mode).
    { type: "state", state: "running" },
    { type: "delta", entryId: reply2, kind: "assistant", text: "ok", parentToolUseId: null },
    { type: "entry", entry: { kind: "assistant", id: reply2, text: "ok", model: "claude-fable-5-2", at: "2026-11-11T00:35:44.708Z", parentToolUseId: null } },
    {
      type: "usage",
      model: "claude-fable-5-2",
      // the turn's own usage: the difference from turn 1's cumulative report
      usage: { input: 4, output: 4, cacheRead: 131065 - 98163, cacheWrite: 32928 - 32902 },
      cumulative: false,
      costUsd: 0.5624129999999999 - 0.5552246,
      contextTokens: 4 + 32902 + 26,
    },
    { type: "turn.end", durationMs: 3619, ok: true, error: null },
    { type: "state", state: "idle" },
  ]);
  // Folded, the tool result sits on its call and deltas were replaced by whole entries.
  const t = foldHarnessEvents(events);
  assert.deepEqual(t.map((e) => e.kind), ["tool", "assistant", "assistant"]);
  assert.equal(t[0]!.kind === "tool" && t[0]!.result?.text, "hello.txt");
});

test("a later init with a new model or mode emits model / permission.mode instead", () => {
  const state = createMapState();
  const init = recording.messages[3]!;
  run([init], state);
  const events = run([{ ...init, model: "claude-other-1", permissionMode: "plan" }, init], state);
  assert.deepEqual(events, [
    { type: "model", model: "claude-other-1" },
    { type: "permission.mode", mode: "plan" },
    { type: "model", model: "claude-fable-5-2" },
    { type: "permission.mode", mode: "default" },
  ]);
});

test("thinking: thinking deltas and entries share <message.id>:<index> ids with the text that follows", () => {
  const events = run(hand.thinking);
  assert.deepEqual(events, [
    { type: "delta", entryId: "msg_T:0", kind: "thinking", text: "Let me ", parentToolUseId: null },
    { type: "delta", entryId: "msg_T:0", kind: "thinking", text: "think.", parentToolUseId: null },
    { type: "entry", entry: { kind: "thinking", id: "msg_T:0", text: "Let me think.", at: "2026-11-11T00:00:01.000Z", parentToolUseId: null } },
    { type: "delta", entryId: "msg_T:1", kind: "assistant", text: "Hi", parentToolUseId: null },
    { type: "entry", entry: { kind: "assistant", id: "msg_T:1", text: "Hi", model: "claude-test-1", at: "2026-11-11T00:00:02.000Z", parentToolUseId: null } },
  ]);
});

test("subagent activity nests under the Task call; subagent usage doesn't set contextTokens", () => {
  const state = createMapState();
  const events = run(hand.subagent, state);
  assert.deepEqual(events, [
    { type: "entry", entry: { kind: "tool", id: "toolu_task", name: "Task", input: { description: "Look around", prompt: "List the files", subagent_type: "Explore" }, at: "2026-11-11T00:00:01.000Z", parentToolUseId: null } },
    { type: "entry", entry: { kind: "user", id: "u-sub", text: "List the files", at: "2026-11-11T00:00:02.000Z", parentToolUseId: "toolu_task" } },
    { type: "delta", entryId: "msg_S:0", kind: "assistant", text: "Looking", parentToolUseId: "toolu_task" },
    { type: "entry", entry: { kind: "assistant", id: "msg_S:0", text: "Looking", model: "claude-small-1", at: "2026-11-11T00:00:03.000Z", parentToolUseId: "toolu_task" } },
    { type: "entry", entry: { kind: "tool", id: "toolu_read", name: "Read", input: { file_path: "/p/a.txt" }, at: "2026-11-11T00:00:04.000Z", parentToolUseId: "toolu_task" } },
    { type: "tool.result", toolUseId: "toolu_read", result: { ok: true, text: "hello", truncated: false } },
    { type: "tool.result", toolUseId: "toolu_task", result: { ok: true, text: "Found a.txt\n[image]", truncated: false } },
  ]);
  assert.equal(state.contextTokens, 1);
  assert.equal(state.contextModel, "claude-test-1");
});

test("is_error tool results map to ok: false", () => {
  const events = run(hand.toolError);
  assert.deepEqual(events.at(-1), { type: "tool.result", toolUseId: "toolu_err", result: { ok: false, text: "Exit code 1", truncated: false } });
});

test("TodoWrite input becomes a todos event after its entry (invalid items dropped)", () => {
  const events = run(hand.todoWrite);
  assert.deepEqual(events.map((e) => e.type), ["entry", "todos"]);
  assert.deepEqual(events[1], {
    type: "todos",
    todos: [
      { content: "Read", status: "completed", activeForm: "Reading" },
      { content: "Write", status: "in_progress", activeForm: "Writing" },
    ],
  });
});

test("error results: turn.end not ok with the errors joined, then idle", () => {
  const state = createMapState();
  state.state = "running";
  assert.deepEqual(run([hand.errorResult], state), [
    { type: "turn.end", durationMs: 12, ok: false, error: "boom; bang" },
    { type: "state", state: "idle" },
  ]);
  state.state = "running";
  assert.deepEqual(run([hand.apiErrorResult], state), [
    { type: "usage", model: "claude-test-1", usage: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 }, cumulative: false, costUsd: 0.01, contextTokens: null },
    { type: "turn.end", durationMs: 30, ok: false, error: "API Error: 500 overloaded" },
    { type: "state", state: "idle" },
  ]);
});

test("api_retry, compaction and rate-limit rejections become notices; status carries mode changes", () => {
  const state = createMapState();
  state.permissionMode = "default";
  assert.deepEqual(run(hand.notices, state), [
    { type: "notice", level: "warning", text: "API error (HTTP 529); retrying in 2s (attempt 1/10)" },
    { type: "notice", level: "info", text: "Conversation compacted (auto, 150000 tokens before)" },
    { type: "notice", level: "error", text: "Compaction failed: too long" },
    { type: "notice", level: "error", text: "Rate limit reached (five hour); resets 2026-11-11T05:20:00.000Z" },
    { type: "permission.mode", mode: "acceptEdits" },
    { type: "state", state: "running" },
  ]);
});

test("user messages the driver sent are not echoed; replays and synthetic ones are skipped", () => {
  const msg = (extra: Record<string, unknown>) => ({ type: "user", message: { role: "user", content: "hi" }, parent_tool_use_id: "toolu_x", uuid: "u-1", ...extra });
  assert.deepEqual(run([msg({})], createMapState(), new Set(["u-1"])), []);
  assert.deepEqual(run([msg({ isReplay: true })]), []);
  assert.deepEqual(run([msg({ isSynthetic: true })]), []);
  // Main-thread text from the SDK (not a subagent prompt) is ignored: the driver shows what it sends itself.
  assert.deepEqual(run([msg({ parent_tool_use_id: null })]), []);
});

test("unknown message types and stream events without a message are ignored", () => {
  assert.deepEqual(run([{ type: "active_goal", value: null }, { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } }, parent_tool_use_id: null }]), []);
});

test("usage: a resumed or forked process reports each turn's own usage, whatever totals the CLI restored", () => {
  // Observed live: a fork restored its parent's totals as of an earlier turn, so its first cumulative report is
  // neither the parent's latest total nor zero-based.
  const state = createMapState({ resumed: true });
  const assistant = (id: string, usage: Record<string, number>, text = "ok") => ({
    type: "assistant",
    parent_tool_use_id: null,
    message: { id, model: "claude-test-1", content: [{ type: "text", text }], usage },
  });
  const result = (u: Record<string, number>, costUSD: number) => ({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 5,
    modelUsage: { "claude-test-1": { ...u, costUSD } },
  });
  const usageOf = (events: HarnessEvent[]) => events.filter((e) => e.type === "usage");
  // Turn 1: restored base 6/161/69848/35110 (unknown to the driver) + this turn's message 2/4/35123/362.
  const first = usageOf(run([
    assistant("m1", { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 35123, cache_creation_input_tokens: 362 }),
    assistant("m1", { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 35123, cache_creation_input_tokens: 362 }),
    result({ inputTokens: 8, outputTokens: 165, cacheReadInputTokens: 104971, cacheCreationInputTokens: 35472 }, 0.008),
  ], state));
  assert.equal(first.length, 1);
  const u1 = first[0]!;
  assert.ok(u1.type === "usage");
  assert.deepEqual(u1.usage, { input: 2, output: 4, cacheRead: 35123, cacheWrite: 362 });
  assert.equal(u1.cumulative, false);
  assert.ok(u1.costUsd! > 0 && u1.costUsd! < 0.008, `a share of the cost: ${u1.costUsd}`);
  // Turn 2 in the same process: the difference.
  const second = usageOf(run([
    assistant("m2", { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 35400, cache_creation_input_tokens: 10 }),
    result({ inputTokens: 10, outputTokens: 168, cacheReadInputTokens: 140371, cacheCreationInputTokens: 35482 }, 0.0085),
  ], state));
  assert.deepEqual(second.map((e) => e.type === "usage" && e.usage), [{ input: 2, output: 3, cacheRead: 35400, cacheWrite: 10 }]);
  assert.ok(second[0]!.type === "usage" && Math.abs(second[0]!.costUsd! - 0.0005) < 1e-12);
});

test("usage: a model with nothing new this turn is not reported", () => {
  const state = createMapState();
  const result = (models: Record<string, Record<string, number>>) => ({ type: "result", subtype: "success", is_error: false, duration_ms: 1, modelUsage: models });
  run([result({ a: { inputTokens: 1, outputTokens: 1, costUSD: 0.1 }, b: { inputTokens: 1, outputTokens: 1, costUSD: 0.1 } })], state);
  const events = run([result({ a: { inputTokens: 2, outputTokens: 2, costUSD: 0.2 }, b: { inputTokens: 1, outputTokens: 1, costUSD: 0.1 } })], state);
  assert.deepEqual(events.filter((e) => e.type === "usage").map((e) => e.type === "usage" && e.model), ["a"]);
});

test("background task notifications: the system message and an injected user message reconcile to one task", () => {
  const system = { type: "system", subtype: "task_notification", task_id: "t9", tool_use_id: "toolu_bg", status: "completed", output_file: "/tmp/out", summary: 'Agent "Fix tests" completed', uuid: "sys-1", session_id: SID };
  const injected = {
    type: "user",
    uuid: "u-n",
    parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "text", text: "<task-notification><task-id>t9</task-id><tool-use-id>toolu_bg</tool-use-id><output-file>/tmp/out</output-file><status>completed</status><summary>Agent &quot;Fix tests&quot; completed</summary></task-notification>" }] },
  };
  const events = run([system, injected]);
  assert.ok(events.every(e => e.type === "task"));
  const entries = foldHarnessEvents(events);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "task");
  if (entries[0].kind === "task") {
    assert.equal(entries[0].task.state, "completed");
    assert.equal(entries[0].task.summary, 'Agent "Fix tests" completed');
    assert.equal(entries[0].task.toolUseId, "toolu_bg");
  }
  assert.ok(!JSON.stringify(events).includes("/tmp/out"));
  assert.deepEqual(run([{ ...system, skip_transcript: true }]), []);
});

test("top-level user text that isn't a notification is still not echoed", () => {
  assert.deepEqual(run([{ type: "user", uuid: "u-x", parent_tool_use_id: null, message: { role: "user", content: "<task-notification>partial" } }]), []);
});

test("commands: the initialize list feeds init, later changes emit commands; local output and resets surface", () => {
  const state = createMapState();
  assert.deepEqual(commandsKnown(state, [{ name: "compact", description: "C", argumentHint: "", builtin: true }]), []);
  const init = mapMessage(state, { type: "system", subtype: "init", session_id: "s", model: "m", permissionMode: "default", cwd: "/", tools: [], slash_commands: ["compact", "other"], agents: [] });
  const ev = init.find((e) => e.type === "init") as Extract<HarnessEvent, { type: "init" }>;
  assert.deepEqual(ev.slashCommands, [{ name: "compact", description: "C", argumentHint: "", source: "builtin" }]);
  assert.deepEqual(mapMessage(state, { type: "system", subtype: "commands_changed", commands: [{ name: "x" }] }), [
    { type: "commands", slashCommands: [{ name: "x", description: "", argumentHint: "", source: "custom" }] },
  ]);
  const out = mapMessage(state, { type: "system", subtype: "local_command_output", content: "Context: 12%", uuid: "u1" });
  assert.equal(out.length, 1);
  assert.ok(out[0]!.type === "entry" && out[0]!.entry.kind === "assistant" && out[0]!.entry.text === "Context: 12%" && out[0]!.entry.id === "u1");
  assert.deepEqual(mapMessage(state, { type: "system", subtype: "local_command_output", content: "" }), []);
  const reset = mapMessage(state, { type: "conversation_reset" });
  assert.equal(reset[0]?.type, "notice");
});

test("live: a user-rejected result is an interrupt, a permission-rule reject is a denial that keeps the message", () => {
  const i = run(fx.interruptLive);
  assert.deepEqual(i.find((e) => e.type === "tool.result"), { type: "tool.result", toolUseId: "toolu_int", result: { ok: false, text: "Stopped by you", truncated: false, status: "interrupted" } });
  const d = run(fx.denyLive);
  assert.deepEqual(d.find((e) => e.type === "tool.result"), { type: "tool.result", toolUseId: "toolu_deny", result: { ok: false, text: "The user denied this tool call (test).", truncated: false, status: "denied" } });
});

test("the interrupt marker text is never a user entry, and the abort result is an interrupt without the diagnostic", () => {
  for (const msgs of [fx.interruptLive, fx.streamInterruptLive]) {
    const ev = run(msgs);
    assert.ok(!ev.some((e) => e.type === "entry" && e.entry.kind === "user"));
    assert.deepEqual(ev.find((e) => e.type === "turn.end"), { type: "turn.end", durationMs: msgs === fx.interruptLive ? 4905 : 800, ok: false, error: "interrupted" });
  }
  // Nested under a subagent too.
  const nested = run([{ ...fx.streamInterruptLive[0], parent_tool_use_id: "toolu_x" }]);
  assert.deepEqual(nested, []);
});

test("an ordinary error_during_execution keeps its errors", () => {
  const ev = run([{ type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom"], duration_ms: 1, modelUsage: {} }]);
  assert.deepEqual(ev.find((e) => e.type === "turn.end"), { type: "turn.end", durationMs: 1, ok: false, error: "boom" });
});
