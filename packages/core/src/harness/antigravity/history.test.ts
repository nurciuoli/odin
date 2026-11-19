import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listSessions, readMessages, sessionInfo } from "./history.ts";
import { tempDir, removeTempDir } from "../../test-helpers.ts";

test("history lists sessions and reads transcript entries", () => {
  const root = tempDir("odin-agy-history-");
  try {
    const sessId = "session-test-123";
    const logDir = join(root, sessId, ".system_generated", "logs");
    mkdirSync(logDir, { recursive: true });

    const lines = [
      JSON.stringify({
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        created_at: "2026-11-15T12:00:00Z",
        content: "<USER_REQUEST>\nBuild the new dashboard\n</USER_REQUEST>",
      }),
      JSON.stringify({
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-15T12:00:05Z",
        model: "gemini-3.8-flash",
        thinking: "Let's inspect the files",
        content: "I am starting the build now.",
        tool_calls: [{ name: "read_file", args: { Path: "dashboard.ts" } }],
      }),
      JSON.stringify({
        step_index: 2,
        source: "MODEL",
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-15T12:00:08Z",
        content: "File contents here",
      }),
    ];

    writeFileSync(join(logDir, "transcript.jsonl"), lines.join("\n"));

    const sessions = listSessions(root);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.sessionId, sessId);
    assert.equal(sessions[0]!.title, "Build the new dashboard");
    assert.equal(sessions[0]!.firstPrompt, "Build the new dashboard");

    const info = sessionInfo(root, sessId);
    assert.ok(info);
    assert.equal(info.title, "Build the new dashboard");

    const messages = readMessages(root, sessId);
    assert.equal(messages.length, 4); // user, thinking, assistant, tool (with result)
    assert.equal(messages[0]!.kind, "user");
    assert.equal((messages[0] as any).text, "Build the new dashboard");
    assert.equal(messages[1]!.kind, "thinking");
    assert.equal(messages[2]!.kind, "assistant");
    assert.equal(messages[3]!.kind, "tool");
    assert.equal((messages[3] as any).result?.ok, true);
    assert.equal((messages[3] as any).result?.text, "File contents here");
  } finally {
    removeTempDir(root);
  }
});
