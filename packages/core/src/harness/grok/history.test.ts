import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { encodedCwd, listSessions, readMessages } from "./history.ts";

test("history skips the system prompt and titles from the first user line", () => {
  const root = mkdtempSync(join(tmpdir(), "odin-grok-history-"));
  const cwd = join(root, "project");
  const dir = join(root, "sessions", encodedCwd(cwd), "native-1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "summary.json"), JSON.stringify({
    info: { id: "native-1", cwd },
    created_at: "2026-11-13T00:00:00.000Z",
    updated_at: "2026-11-13T01:00:00.000Z",
    session_summary: "",
  }));
  writeFileSync(join(dir, "chat_history.jsonl"), [
    JSON.stringify({ type: "system", content: "secret system prompt" }),
    JSON.stringify({ type: "user", content: { type: "text", text: "<user_info>rules</user_info>" } }),
    JSON.stringify({ type: "user", synthetic_reason: "system_reminder", content: "skills" }),
    JSON.stringify({ type: "user", content: [{ type: "text", text: "<user_query>Explain the build</user_query>" }] }),
    JSON.stringify({ type: "assistant", content: "pong" }),
  ].join("\n"));
  try {
    const listed = listSessions(join(root, "sessions"), cwd);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.sessionId, "native-1");
    assert.equal(listed[0]?.title, "Explain the build");
    const messages = readMessages(join(root, "sessions"), cwd, "native-1");
    assert.deepEqual(messages.map((entry) => entry.kind === "user" || entry.kind === "assistant" ? entry.text : entry.kind), ["Explain the build", "pong"]);
    assert.equal(JSON.stringify(messages).includes("secret system"), false);
    writeFileSync(join(dir, "chat_history.jsonl"), JSON.stringify({ type: "user", content: "<user_info>rules</user_info>" }));
    assert.deepEqual(listSessions(join(root, "sessions"), cwd), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
