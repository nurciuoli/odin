// Checkpoints over the real sessions service and the fake harness. docs/contracts.md#checkpoints.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Checkpoint } from "@odin/shared/api";
import { HttpError } from "../http/util.ts";
import { PROJECT, setup, waitFor } from "../sessions/test-setup.ts";

const status = (n: number) => (e: unknown) => e instanceof HttpError && e.status === n;
const read = (dir: string, name: string) => readFileSync(join(dir, name), "utf8");

async function turn(s: ReturnType<typeof setup>, id: string, text: string, expected: number) {
  await s.sessions.send(id, { text });
  await waitFor(() => s.sessions.get(id)?.state === "idle", 3000, "idle");
  await waitFor(() => s.services.checkpoints.list(id).filter((c) => c.kind === "turn" && c.files).length >= expected, 3000, `checkpoint ${expected} finished`);
}

test("each turn gets a checkpoint with its before-tree, and rewinding restores files, branches and undoes", async () => {
  const s = setup({ checkpoints: true });
  try {
    writeFileSync(join(s.projectPath, "a.txt"), "v1");
    const st = await s.sessions.start({ project: PROJECT, prompt: { text: "one" } });
    await waitFor(() => s.services.checkpoints.list(st.id).some((c) => c.files), 3000, "first checkpoint finished");
    await waitFor(() => s.sessions.get(st.id)?.state === "idle", 3000, "idle");
    // The "agent" edits between turns here, because the fake harness touches no files.
    writeFileSync(join(s.projectPath, "a.txt"), "v2");
    writeFileSync(join(s.projectPath, "b.txt"), "added");
    await turn(s, st.id, "two", 2);
    writeFileSync(join(s.projectPath, "a.txt"), "v3");

    const list = s.services.checkpoints.list(st.id);
    assert.deepEqual(list.map((c) => [c.kind, c.turn, c.snapshot]), [["turn", 1, "ok"], ["turn", 2, "ok"]]);
    assert.ok(list.every((c) => c.messageId), "anchored on the user messages");
    const [cp1, cp2] = list as [Checkpoint, Checkpoint];
    assert.deepEqual(cp1.files, { changed: 0, added: 0, removed: 0 });
    assert.ok(s.deps.events.some((e) => e.type === "checkpoint.updated" && e.checkpoint.id === cp2.id));

    // What restoring turn 2 would change right now: a.txt (v3 → v2) only; b.txt already matches.
    const now = await s.services.checkpoints.diff(st.id, cp2.id, "current");
    assert.deepEqual(now.files, [{ path: "a.txt", status: "modified" }]);
    await assert.rejects(s.services.checkpoints.restore(st.id, cp2.id, { files: false, conversation: false }), status(400));
    await assert.rejects(s.services.checkpoints.restore(st.id, "nope", { files: true, conversation: false }), status(404));

    const files = await s.services.checkpoints.restore(st.id, cp2.id, { files: true, conversation: false });
    assert.equal(files.session.id, st.id);
    assert.equal(files.archivedSessionId, null);
    assert.equal(read(s.projectPath, "a.txt"), "v2");
    assert.equal(read(s.projectPath, "b.txt"), "added");
    const undo = s.services.checkpoints.list(st.id).find((c) => c.id === files.undoCheckpointId)!;
    assert.equal(undo.kind, "pre-restore");

    await s.services.checkpoints.restore(st.id, undo.id, { files: true, conversation: false });
    assert.equal(read(s.projectPath, "a.txt"), "v3", "undo puts the files back");

    // Turn 1 predates b.txt, so rewinding to it removes b.txt.
    await s.services.checkpoints.restore(st.id, cp1.id, { files: true, conversation: false });
    assert.equal(read(s.projectPath, "a.txt"), "v1");
    assert.equal(existsSync(join(s.projectPath, "b.txt")), false);
  } finally { await s.sessions.close(); }
});

test("rewinding the conversation forks before the message, archives the original and inherits earlier checkpoints", async () => {
  const s = setup({ checkpoints: true });
  try {
    const st = await s.sessions.start({ project: PROJECT, prompt: { text: "one" } });
    await waitFor(() => s.services.checkpoints.list(st.id).some((c) => c.files), 3000, "first checkpoint finished");
    await waitFor(() => s.sessions.get(st.id)?.state === "idle", 3000, "idle");
    await turn(s, st.id, "two", 2);
    const [cp1, cp2] = s.services.checkpoints.list(st.id) as [Checkpoint, Checkpoint];

    const r = await s.services.checkpoints.restore(st.id, cp2.id, { files: false, conversation: true });
    assert.notEqual(r.session.id, st.id);
    assert.equal(r.archivedSessionId, st.id);
    assert.equal(r.undoCheckpointId, null);
    assert.equal(s.sessions.get(st.id)!.archived, true);
    assert.equal(s.sessions.get(r.session.id)!.parentId, st.id);
    assert.equal((await s.sessions.detail(r.session.id))!.transcript.length, 2, "history before message two");
    const inherited = s.services.checkpoints.list(r.session.id);
    assert.deepEqual(inherited.map((c) => [c.turn, c.messageId]), [[1, cp1.messageId]]);

    await turn(s, r.session.id, "three", 2);
    assert.deepEqual(s.services.checkpoints.list(r.session.id).map((c) => c.turn), [1, 2], "the next turn continues the numbering");

    await assert.rejects(s.sessions.fork(st.id, { atMessageId: "not-a-message" }), (e) => e instanceof Error && /not a user message/.test(e.message));
  } finally { await s.sessions.close(); }
});

test("fork at a message with restoreFiles fills the new worktree from that checkpoint", async () => {
  const s = setup({ checkpoints: true });
  try {
    writeFileSync(join(s.projectPath, "a.txt"), "v1");
    const st = await s.sessions.start({ project: PROJECT, prompt: { text: "one" } });
    await waitFor(() => s.services.checkpoints.list(st.id).some((c) => c.files), 3000, "first checkpoint finished");
    await waitFor(() => s.sessions.get(st.id)?.state === "idle", 3000, "idle");
    writeFileSync(join(s.projectPath, "a.txt"), "v2");
    await turn(s, st.id, "two", 2);
    writeFileSync(join(s.projectPath, "a.txt"), "v3");
    const [, cp2] = s.services.checkpoints.list(st.id) as [Checkpoint, Checkpoint];

    await assert.rejects(s.sessions.fork(st.id, { atMessageId: cp2.messageId!, restoreFiles: true }), status(400), "needs a worktree");
    await assert.rejects(s.sessions.fork(st.id, { restoreFiles: true, worktree: true }), status(400), "needs a message");
    const fork = await s.sessions.fork(st.id, { atMessageId: cp2.messageId!, restoreFiles: true, worktree: true });
    assert.equal(fork.workspace.kind, "worktree");
    assert.equal(read(fork.cwd, "a.txt"), "v2");
    assert.equal(read(s.projectPath, "a.txt"), "v3", "the parent's files are untouched");
    assert.equal(s.sessions.get(st.id)!.archived, false);
    assert.deepEqual(s.services.checkpoints.list(fork.id).map((c) => c.turn), [1]);
  } finally { await s.sessions.close(); }
});

test("a harness without forkAt rejects conversation rewinds, and a disabled project takes no snapshots", async () => {
  const s = setup({ checkpoints: true });
  try {
    const st = await s.sessions.start({ project: PROJECT, prompt: { text: "one" } });
    await waitFor(() => s.services.checkpoints.list(st.id).some((c) => c.files), 3000, "first checkpoint finished");
    await waitFor(() => s.sessions.get(st.id)?.state === "idle", 3000, "idle");
    delete (s.harness as { forkAt?: unknown }).forkAt;
    const [cp1] = s.services.checkpoints.list(st.id) as [Checkpoint];
    await assert.rejects(s.services.checkpoints.restore(st.id, cp1.id, { files: false, conversation: true }), status(400));
    await assert.rejects(s.sessions.fork(st.id, { atMessageId: cp1.messageId! }), status(400));

    s.services.projects.get(PROJECT)!.settings.checkpoints = { enabled: false };
    await turn(s, st.id, "two", 1);
    assert.equal(s.services.checkpoints.list(st.id).length, 1, "no checkpoint while disabled");
  } finally { await s.sessions.close(); }
});

test("removing a session forgets its checkpoints", async () => {
  const s = setup({ checkpoints: true });
  try {
    const st = await s.sessions.start({ project: PROJECT, prompt: { text: "one" } });
    await waitFor(() => s.services.checkpoints.list(st.id).some((c) => c.files), 3000, "first checkpoint finished");
    await waitFor(() => s.sessions.get(st.id)?.state === "idle", 3000, "idle");
    await s.sessions.remove(st.id);
    const n = (s.deps.db.prepare("SELECT COUNT(*) AS n FROM checkpoints").get() as { n: number }).n;
    assert.equal(n, 0);
  } finally { await s.sessions.close(); }
});
