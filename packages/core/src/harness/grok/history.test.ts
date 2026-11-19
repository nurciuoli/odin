import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { encodedCwd, listSessions, readMessages, readOwnedChild } from "./history.ts";

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

    writeFileSync(join(dir, "summary.json"), JSON.stringify({
      info: { id: "native-1", cwd },
      updated_at: "2026-11-13T02:00:00.000Z",
      session_summary: "A longer summary that should not win",
      generated_title: "Fix the login redirect",
    }));
    writeFileSync(join(dir, "chat_history.jsonl"), JSON.stringify({ type: "user", content: [{ type: "text", text: "<user_query>Explain the build</user_query>" }] }));
    writeFileSync(join(dir, "updates.jsonl"), [
      JSON.stringify({ timestamp: 1, method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "spawn-1", name: "spawn_subagent", rawInput: { description: "Review" } } } }),
      JSON.stringify({ timestamp: 2, method: "session/update", params: { update: { sessionUpdate: "subagent_spawned", subagent_id: "child-1", attempt_id: "a1", description: "Review", child_session_id: "child-1" } } }),
      JSON.stringify({ timestamp: 3, method: "_x.ai/session/update", params: { update: { sessionUpdate: "subagent_finished", subagent_id: "child-1", attempt_id: "a1", description: "Review", status: "completed", output: "done" } } }),
    ].join("\n"));
    const titled = listSessions(join(root, "sessions"), cwd);
    assert.equal(titled[0]?.title, "Fix the login redirect");
    const withTasks = readMessages(join(root, "sessions"), cwd, "native-1");
    const task = withTasks.find((entry) => entry.kind === "task");
    assert.equal(task?.kind === "task" && task.task.state, "completed");
    assert.equal(task?.kind === "task" && task.task.toolUseId, "spawn-1");
    assert.equal(task?.kind === "task" && task.task.childSessionId, "child-1");

    const child = join(root, "sessions", encodedCwd(cwd), "child-1");
    mkdirSync(child, { recursive: true });
    writeFileSync(join(child, "summary.json"), JSON.stringify({ info: { id: "child-1", cwd }, session_kind: "subagent", generated_title: "Child", updated_at: "2026-11-13T03:00:00.000Z" }));
    writeFileSync(join(child, "chat_history.jsonl"), JSON.stringify({ type: "assistant", content: "from the child" }));
    const stranger = join(root, "sessions", encodedCwd(cwd), "stranger");
    mkdirSync(stranger, { recursive: true });
    writeFileSync(join(stranger, "summary.json"), JSON.stringify({ info: { id: "stranger", cwd }, session_kind: "subagent", updated_at: "2026-11-13T03:00:00.000Z" }));
    writeFileSync(join(stranger, "chat_history.jsonl"), JSON.stringify({ type: "user", content: "secret" }));
    assert.equal(listSessions(join(root, "sessions"), cwd).some((info) => info.sessionId === "child-1"), false);
    const owned = readOwnedChild(join(root, "sessions"), cwd, "native-1", "child-1");
    assert.equal(owned?.some((entry) => entry.kind === "assistant" && entry.text === "from the child"), true);
    assert.equal(readOwnedChild(join(root, "sessions"), cwd, "native-1", "stranger"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
