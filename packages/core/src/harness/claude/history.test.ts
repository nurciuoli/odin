import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { foldHarnessEvents } from "@odin/shared/transcript";
import { historyAttachment, historyEntries } from "./history.ts";
import { createMapState, mapMessage } from "./map.ts";
import { toSdkUserMessage } from "./input.ts";
import stored from "./fixtures/session-messages.json" with { type: "json" };
import recording from "./fixtures/sdk-recording.json" with { type: "json" };
import fx from "./fixtures/interrupt.json" with { type: "json" };

const messages = stored.messages as unknown as SessionMessage[];

test("stored messages map to transcript entries with tool results attached", () => {
  const entries = historyEntries(messages);
  assert.deepEqual(entries, [
    { kind: "user", id: "u-1", text: "Run ls", at: "2026-11-11T00:35:30.000Z", parentToolUseId: null },
    { kind: "thinking", id: "msg_011CgvCmBc3988xk19sWZvDV:0", text: "Use Bash.", at: "2026-11-11T00:35:39.000Z", parentToolUseId: null },
    {
      kind: "tool",
      id: "toolu_01NXFULWszHTJHLww2fxBTof",
      name: "Bash",
      input: { command: "ls", description: "List files in current directory" },
      at: "2026-11-11T00:35:39.400Z",
      parentToolUseId: null,
      result: { ok: true, text: "hello.txt", truncated: false },
    },
    { kind: "assistant", id: "msg_011CgvCmPac1WmP9JbxG3CCz:0", text: "The output is:\n\n```\nhello.txt\n```", model: "claude-fable-5-2", at: "2026-11-11T00:35:41.106Z", parentToolUseId: null },
    {
      kind: "user",
      id: "u-3",
      text: "Look at these",
      attachments: [
        { name: "shot.png", mediaType: "image/png" },
        { name: "a & b.md", mediaType: "text/markdown" },
        { name: "image", mediaType: "image/jpeg" },
      ],
      at: null,
      parentToolUseId: null,
    },
    { kind: "tool", id: "toolu_task", name: "Task", input: { prompt: "Check" }, at: null, parentToolUseId: null, result: { ok: true, text: "Done", truncated: false } },
    { kind: "tool", id: "toolu_grep", name: "Grep", input: { pattern: "x" }, at: null, parentToolUseId: "toolu_task", result: { ok: false, text: "no matches", truncated: false } },
  ]);
});

test("history and the live mapping give the same ids for the same assistant message", () => {
  const state = createMapState();
  const live = foldHarnessEvents(recording.messages.flatMap((m) => mapMessage(state, m)));
  const liveIds = live.map((e) => e.id);
  const storedIds = historyEntries(messages).map((e) => e.id);
  for (const id of ["toolu_01NXFULWszHTJHLww2fxBTof", "msg_011CgvCmPac1WmP9JbxG3CCz:0"]) {
    assert.ok(liveIds.includes(id) && storedIds.includes(id), id);
  }
});

test("a message the driver sent with attachments reads back with its attachment names", () => {
  const sent = toSdkUserMessage(
    {
      text: "see",
      attachments: [
        { name: "pic.png", mediaType: "image/png", data: "AAAA" },
        { name: "notes.txt", mediaType: "text/plain", data: "line 1\nline 2" },
      ],
    },
    "00000000-0000-4000-8000-000000000001",
  );
  const back = historyEntries([{ type: "user", uuid: "u", session_id: "s", message: sent.message, parent_tool_use_id: null, parent_agent_id: null }]);
  assert.deepEqual(back, [
    { kind: "user", id: "u", text: "see", attachments: [{ name: "pic.png", mediaType: "image/png" }, { name: "notes.txt", mediaType: "text/plain" }], at: null, parentToolUseId: null },
  ]);
  const stored = [{ type: "user", uuid: "u", session_id: "s", message: sent.message, parent_tool_use_id: null, parent_agent_id: null }];
  assert.deepEqual(historyAttachment(stored as unknown as SessionMessage[], "u", 0), { name: "pic.png", mediaType: "image/png", data: "AAAA", encoding: "base64" });
  assert.deepEqual(historyAttachment(stored as unknown as SessionMessage[], "u", 1), { name: "notes.txt", mediaType: "text/plain", data: "line 1\nline 2", encoding: "utf8" });
  assert.equal(historyAttachment(stored as unknown as SessionMessage[], "u", 2), null);
});

const NOTIFICATION = [
  "<task-notification>",
  "<task-id>a1b2c3</task-id>",
  "<tool-use-id>toolu_bg</tool-use-id>",
  "<output-file>/tmp/claude/tasks/a1b2c3.output</output-file>",
  "<status>completed</status>",
  '<summary>Agent "Sidebar add-project plus icon" completed</summary>',
  "<result>Added the icon.</result>",
  "<usage><total_tokens>1200</total_tokens></usage>",
  "</task-notification>",
].join("\n");

const userMsg = (uuid: string, content: unknown): SessionMessage =>
  ({ type: "user", uuid, session_id: "s", message: { role: "user", content }, parent_tool_use_id: null, parent_agent_id: null }) as unknown as SessionMessage;

const noticeEntry = { kind: "task", id: 'task:["a1b2c3",null]', task: { taskId: "a1b2c3", runId: null, kind: "agent", label: "Background task", state: "completed", toolUseId: "toolu_bg", parentToolUseId: null, childSessionId: "a1b2c3", startedAt: null, completedAt: null, observedAt: null, summary: 'Agent "Sidebar add-project plus icon" completed' }, at: null, parentToolUseId: null };

test("a task notification becomes a task entry, not a user message", () => {
  assert.deepEqual(historyEntries([userMsg("n1", `\n${NOTIFICATION}\n`)]), [noticeEntry]);
  assert.deepEqual(historyEntries([userMsg("n2", [{ type: "text", text: NOTIFICATION }, { type: "text", text: "<system-reminder>\nbe brief\n</system-reminder>" }])]), [noticeEntry]);
  const text = JSON.stringify(historyEntries([userMsg("n1", NOTIFICATION)]));
  for (const secret of ["/tmp/claude", "Added the icon"]) assert.ok(!text.includes(secret), secret);
});

test("a task notification beside the user's own text: a system entry then a user entry with only their text", () => {
  const entries = historyEntries([userMsg("n3", [{ type: "text", text: NOTIFICATION }, { type: "text", text: "task notification wasn't handled properly" }])]);
  assert.deepEqual(entries, [noticeEntry, { kind: "user", id: "n3", text: "task notification wasn't handled properly", at: null, parentToolUseId: null }]);
});

test("a notification without a summary falls back to its status; without a task id the id comes from the message", () => {
  const entries = historyEntries([userMsg("n4", "<task-notification><status>failed</status></task-notification>")]);
  assert.deepEqual(entries, [{ kind: "system", id: "n4:notice:0", level: "info", text: "Background task failed", at: null, parentToolUseId: null }]);
});

test("malformed or partial notification tags stay user text", () => {
  for (const text of ["<task-notification><status>completed</status>", "see <task-notification><summary>x</summary></task-notification>", "<task-notification>x</task-notification> and more"]) {
    assert.deepEqual(historyEntries([userMsg("m", text)]), [{ kind: "user", id: "m", text, at: null, parentToolUseId: null }], text);
  }
});

test("history and the live stream give a notification the same entry id", () => {
  const live = foldHarnessEvents(
    mapMessage(createMapState(), { type: "system", subtype: "task_notification", task_id: "a1b2c3", tool_use_id: "toolu_bg", status: "completed", output_file: "/tmp/claude/tasks/a1b2c3.output", summary: 'Agent "Sidebar add-project plus icon" completed', uuid: "x", session_id: "s" }),
  );
  const normalized = live.map(entry => entry.kind === "task" ? { ...entry, task: { ...entry.task, observedAt: null } } : entry);
  assert.deepEqual(normalized, [noticeEntry]);
  assert.deepEqual(historyEntries([userMsg("n1", NOTIFICATION)]), normalized);
});

test("interrupted and denied tool calls get a status and label; the interrupt marker is not a user entry", () => {
  const interrupted = historyEntries(fx.interruptHistory as unknown as SessionMessage[]);
  assert.deepEqual(interrupted.map((e) => e.kind), ["user", "tool"]);
  const tool = interrupted[1]!;
  assert.deepEqual(tool.kind === "tool" && tool.result, { ok: false, text: "Stopped by you", truncated: false, status: "interrupted" });
  const classifier = historyEntries(fx.denyHistoryProse as unknown as SessionMessage[]);
  const c = classifier[1]!;
  assert.equal(c.kind === "tool" && c.result?.status, "denied");
  assert.match(c.kind === "tool" ? c.result!.text : "", /classifier: curl pipes to shell$/);
});

test("a rejection with no interrupt after it is denied; 'stopped while running' is interrupted", () => {
  const base = fx.interruptHistory as unknown as SessionMessage[];
  const noMarker = historyEntries(base.slice(0, 3));
  const t = noMarker[1]!;
  assert.equal(t.kind === "tool" && t.result?.status, "denied");
  const stopped = structuredClone(base.slice(0, 3)) as any[];
  stopped[2].message.content[0].content += "\n\nCorrection to the text above: this call was stopped while running, not refused before it ran.";
  const s = historyEntries(stopped)[1]!;
  assert.equal(s.kind === "tool" && s.result?.status, "interrupted");
});

test("live and history give the same entries for an interrupt", () => {
  const state = createMapState();
  const live = foldHarnessEvents(fx.interruptLive.flatMap((m) => mapMessage(state, m as Record<string, unknown>)));
  const hist = historyEntries(fx.interruptHistory as unknown as SessionMessage[]).filter((e) => e.kind !== "user");
  assert.deepEqual(live, hist);
});
