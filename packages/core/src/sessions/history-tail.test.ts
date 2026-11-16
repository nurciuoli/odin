import { test } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptEntry } from "@odin/shared/harness";
import { fakeHarness } from "../harness/fake.ts";
import { historyCovers, mergeInFlight, todosFromTranscript } from "./service.ts";
import { PROJECT, setup, waitFor } from "./test-setup.ts";

const base = { at: null, parentToolUseId: null };
const user = (id: string, text: string): TranscriptEntry => ({ kind: "user", id, text, ...base });
const asst = (id: string, text: string): TranscriptEntry => ({ kind: "assistant", id, text, model: null, ...base });
const think = (id: string, text: string): TranscriptEntry => ({ kind: "thinking", id, text, ...base });
const tool = (id: string, result?: string): TranscriptEntry => ({ kind: "tool", id, name: "Bash", input: {}, ...base, ...(result ? { result: { ok: true, text: result, truncated: false } } : {}) });

test("mergeInFlight: history ids that never match the live ids keep order and don't duplicate text", () => {
  // Disk: the finished first turn, then the current turn so far (user, assistant, four tools).
  const stored = [user("grok-0", "one"), asst("grok-1", "first"), tool("call-a", "ok"), user("grok-4", "two"), asst("grok-5", "second"), tool("call-b", "ok"), tool("call-c"), tool("call-d"), tool("call-e")];
  // Live: the current turn only.
  const tail = [think("s:turn-2:0:thought", "hm"), asst("s:turn-2:0:assistant", "second"), tool("call-b"), tool("call-c", "ok"), tool("call-d"), tool("call-e")];
  const out = mergeInFlight(stored, tail);
  assert.deepEqual(out.map((e) => e.id), ["grok-0", "grok-1", "call-a", "grok-4", "s:turn-2:0:thought", "s:turn-2:0:assistant", "call-b", "call-c", "call-d", "call-e"]);
  assert.equal(out.filter((e) => e.kind === "assistant" && e.text === "second").length, 1);
  assert.deepEqual(mergeInFlight(stored, []), stored);
});

test("todosFromTranscript reads Grok's todo_write list and skips a status-only merge", () => {
  const list = [{ content: "Read", status: "pending" as const }];
  const entries = [tool("call-1"), { ...tool("call-2"), name: "todo_write", input: { todos: list } }, { ...tool("call-3"), name: "todo_write", input: { todos: [{ id: "1", status: "completed" }] } }];
  assert.deepEqual(todosFromTranscript(entries), list);
  // An empty list is a deliberate clear, not a merge to look past.
  assert.deepEqual(todosFromTranscript([...entries, { ...tool("call-4"), name: "TodoWrite", input: { todos: [] } }]), []);
});

test("historyCovers: tools by id, assistant text by content", () => {
  const stored = [user("u", "q"), asst("grok-1", "all done here"), tool("call-a", "x")];
  assert.equal(historyCovers(stored, [think("t", "hm"), asst("l", "all done"), tool("call-a")]), true);
  assert.equal(historyCovers(stored, [tool("call-b")]), false);
  assert.equal(historyCovers(stored, [asst("l", "something else")]), false);
});

function grokSetup(script: Parameters<typeof fakeHarness>[0] extends infer O ? (O extends { script?: infer S } ? S : never) : never) {
  const h = fakeHarness({ id: "grok", script });
  const s = setup({ harnesses: { grok: h } });
  return { s, h };
}

test("detail for a history-replaces-tail harness: finished turn comes from history only", async () => {
  const { s, h } = grokSetup(() => [{ thinking: "hm" }, { tool: "Bash", result: "ok" }, { tool: "Bash", result: "ok" }, { text: "done" }]);
  try {
    const st = await s.sessions.start({ project: PROJECT, harness: "grok", prompt: { text: "go" } });
    await waitFor(() => s.sessions.get(st.id)?.state === "idle", 2000, "idle");
    const ids = (await s.sessions.detail(st.id))!.transcript.filter((e) => e.kind === "tool").map((e) => e.id);
    h.messages = async () => [user("grok-0", "go"), think("grok-1", "hm"), tool(ids[0]!, "ok"), tool(ids[1]!, "ok"), asst("grok-4", "done")];
    await new Promise((r) => setTimeout(r, 20));
    const out = (await s.sessions.detail(st.id))!.transcript;
    assert.deepEqual(out.map((e) => e.id), ["grok-0", "grok-1", ids[0], ids[1], "grok-4"]);
  } finally { await s.sessions.close(); }
});

test("detail mid-turn: stored entries up to the last user, then the live entries", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { s, h } = grokSetup(() => [{ thinking: "hm" }, { tool: "Bash", result: "ok" }, { wait: gate }, { text: "done" }]);
  try {
    const st = await s.sessions.start({ project: PROJECT, harness: "grok", prompt: { text: "go" } });
    await waitFor(async () => (await s.sessions.detail(st.id))!.transcript.some((e) => e.kind === "tool"), 2000, "tool");
    const toolId = (await s.sessions.detail(st.id))!.transcript.find((e) => e.kind === "tool")!.id;
    h.messages = async () => [user("grok-0", "go"), asst("grok-2", "partial"), tool(toolId, "ok")];
    const out = (await s.sessions.detail(st.id))!.transcript;
    // The fake also echoes a user entry into the live tail (Grok doesn't); the stored assistant after the user is dropped.
    assert.equal(out[0]!.id, "grok-0");
    assert.equal(out.some((e) => e.id === "grok-2"), false);
    assert.deepEqual(out.slice(-2).map((e) => e.kind), ["thinking", "tool"]);
    assert.equal(out.filter((e) => e.kind === "tool").length, 1);
    release();
  } finally { release(); await s.sessions.close(); }
});
