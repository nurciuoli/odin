import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { foldHarnessEvents } from "@odin/shared/transcript";
import { detectInjected, injectedMessage } from "./injected.ts";
import { historyEntries } from "./history.ts";
import { createMapState, mapMessage } from "./map.ts";

const HAND_BACK = 'Another Claude session sent a message:\n<agent-message from="reviewer">\n[Subagent hand-back] Fixed the bug; tests pass.\n</agent-message>';

test("a subagent hand-back is an agent report, not the user's", () => {
  assert.deepEqual(detectInjected(HAND_BACK), { source: "agent", from: "reviewer", text: "Fixed the bug; tests pass." });
});

test("other harness wrappers at the start are recognised", () => {
  assert.deepEqual(detectInjected('<cross-session-message from="ops">\nDeploy done\n</cross-session-message>'), { source: "peer", from: "ops", text: "Deploy done" });
  assert.deepEqual(detectInjected("[SYSTEM NOTIFICATION - NOT USER INPUT]\nContext was compacted."), { source: "system", from: null, text: "Context was compacted." });
  assert.deepEqual(detectInjected('<teammate-message teammate_id="lead">hi</teammate-message>'), { source: "agent", from: "lead", text: "hi" });
  assert.deepEqual(detectInjected('<channel source="slack">ping</channel>'), { source: "channel", from: "slack", text: "ping" });
  assert.deepEqual(detectInjected("<scheduled-wakeup>check CI</scheduled-wakeup>"), { source: "scheduled", from: null, text: "check CI" });
  assert.equal(detectInjected("<system-reminder>x</system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT] hi")?.source, "system");
  assert.deepEqual(detectInjected("Another Claude session sent a message:\nhello"), { source: "peer", from: null, text: "hello" });
});

test("user text that merely contains a wrapper mid-message stays the user's", () => {
  for (const text of [`Why do I see this? ${HAND_BACK}`, "look: [SYSTEM NOTIFICATION - NOT USER INPUT]", "a <agent-message from=\"x\">y</agent-message>", "<agent-messages>no</agent-messages>"]) {
    assert.equal(detectInjected(text), null, text);
  }
});

test("the SDK origin wins: human is the user's, peer and channel are injected", () => {
  assert.equal(injectedMessage({ origin: { kind: "human" } }, HAND_BACK), null);
  assert.deepEqual(injectedMessage({ origin: { kind: "peer", from: "uds:x", name: "builder", senderTaskId: "t1", body: "[Subagent hand-back] done" } }, "anything"), { source: "agent", from: "builder", text: "done" });
  assert.deepEqual(injectedMessage({ origin: { kind: "peer", from: "uds:x" } }, "hi"), { source: "peer", from: "uds:x", text: "hi" });
  assert.deepEqual(injectedMessage({ origin: { kind: "channel", server: "slack" } }, "yo"), { source: "channel", from: "slack", text: "yo" });
  assert.equal(injectedMessage({}, "just typing"), null);
});

const userMsg = (uuid: string, content: unknown, extra: Record<string, unknown> = {}) =>
  ({ type: "user", uuid, session_id: "s", message: { role: "user", content }, parent_tool_use_id: null, parent_agent_id: null, ...extra });

test("stored history and the live stream give a hand-back the same injected entry", () => {
  const expected = [{ kind: "injected", id: "h1", source: "agent", from: "reviewer", text: "Fixed the bug; tests pass.", at: null, parentToolUseId: null }];
  assert.deepEqual(historyEntries([userMsg("h1", HAND_BACK) as unknown as SessionMessage]), expected);
  assert.deepEqual(foldHarnessEvents(mapMessage(createMapState(), userMsg("h1", [{ type: "text", text: HAND_BACK }]))), expected);
});

test("a typed message in history stays a user entry", () => {
  assert.deepEqual(historyEntries([userMsg("u1", "please fix it") as unknown as SessionMessage]), [{ kind: "user", id: "u1", text: "please fix it", at: null, parentToolUseId: null }]);
});
