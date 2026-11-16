import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readNativeHistory } from "./history.ts";

const SID = "11111111-1111-4111-8111-111111111111";
const PARENT = "22222222-2222-4222-8222-222222222222";
const CHILD = "33333333-3333-4333-8333-333333333333";

test("read-only rollout history validates identity and preserves native subagent lifecycle with child content", async () => {
  const root = await mkdtemp(join(tmpdir(), "odin-codex-history-"));
  try {
    const dir = join(root, "2026", "11", "12");
    await mkdir(dir, { recursive: true });
    const rows = [
      { type: "session_meta", payload: { id: SID, parent_thread_id: PARENT } },
      { type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", id: "user", content: [{ type: "text", text: "Review this" }] } } },
      { type: "event_msg", payload: { type: "item_completed", item: { type: "SubAgentActivity", id: "start", kind: "started", agent_thread_id: CHILD, agent_path: "/root/reviewer", model: "fixture", reasoning_effort: "high" }, started_at_ms: 1000, completed_at_ms: 1000 } },
      { type: "event_msg", payload: { type: "item_completed", item: { type: "SubAgentActivity", id: "done", kind: "completed", agent_thread_id: CHILD, agent_path: "/root/reviewer" }, started_at_ms: 2000, completed_at_ms: 2000 } },
      { type: "event_msg", payload: { type: "item_completed", item: { type: "AgentMessage", id: "reply", content: [{ type: "text", text: "Reviewed" }] } } },
    ];
    const file = join(dir, `rollout-2026-11-12-${SID}.jsonl`);
    await writeFile(file, rows.map(r => JSON.stringify(r)).join("\n") + '\n{"partial":');
    const history = await readNativeHistory(SID, root);
    assert.equal(history?.parentId, PARENT);
    assert.deepEqual(history?.transcript.map(e => e.kind), ["user", "task", "assistant"]);
    const task = history?.transcript.find(e => e.kind === "task");
    assert.equal(task?.task.state, "completed");
    assert.equal(task?.task.childSessionId, CHILD);
    assert.equal(task?.task.runId, "start");
    const reply = history?.transcript.at(-1);
    assert.equal(reply?.kind === "assistant" && reply.text, "Reviewed");
    assert.equal(await readNativeHistory("../../outside", root), null);
    await writeFile(file, JSON.stringify({ type: "session_meta", payload: { id: CHILD, parent_thread_id: PARENT } }));
    assert.equal(await readNativeHistory(SID, root), null);
    await writeFile(file, "x".repeat(8 * 1024 * 1024 + 1));
    assert.equal(await readNativeHistory(SID, root), null);
    await writeFile(file, [rows[0], { type: "response_item", payload: { type: "message", content: [] } }].map(r => JSON.stringify(r)).join("\n"));
    assert.equal(await readNativeHistory(SID, root), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
