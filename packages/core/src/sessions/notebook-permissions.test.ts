import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./test-setup.ts";

async function until(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) { if (Date.now() > deadline) throw new Error("session did not reach expected state"); await new Promise(resolve => setTimeout(resolve, 5)); }
}
test("notebook host approval is visible in session detail and denial never runs the handler", async () => {
  const s = setup({ harness: { script: () => [{ hostTool: "test_notebook_execute", input: { source: "print(1)" } }] } });
  let executed = 0;
  s.services.notebooks.hostTools = () => [{ name: "test_notebook_execute", effect: "execute", params: {}, description: "Run Python", handler: async () => { executed++; return { text: "done" }; } }];
  try {
    const session = await s.sessions.start({ project: "demo", prompt: { text: "run a cell" } });
    await until(() => s.sessions.get(session.id)?.state === "waiting");
    const detail = await s.sessions.detail(session.id);
    assert.equal(detail!.pending.length, 1);
    assert.equal(detail!.pending[0]!.toolName, "test_notebook_execute");
    s.sessions.answer(session.id, detail!.pending[0]!.id, { behavior: "deny" });
    await until(() => s.sessions.get(session.id)?.state === "idle");
    assert.equal(executed, 0);
    await s.sessions.send(session.id, { text: "run with approval" });
    await until(() => s.sessions.get(session.id)?.state === "waiting");
    const next = await s.sessions.detail(session.id);
    s.sessions.answer(session.id, next!.pending[0]!.id, { behavior: "allow", scope: "once" });
    await until(() => s.sessions.get(session.id)?.state === "idle");
    assert.equal(executed, 1);
  } finally { await s.sessions.close(); await s.services.notebooks.close(); await s.services.library.close(); s.deps.db.close(); }
});
test("session interruption cancels a core notebook approval without execution", async () => {
  const s = setup({ harness: { script: () => [{ hostTool: "test_notebook_execute", input: {} }] } });
  let executed = 0;
  s.services.notebooks.hostTools = () => [{ name: "test_notebook_execute", effect: "execute", params: {}, description: "Run Python", handler: async () => { executed++; return { text: "done" }; } }];
  try {
    const session = await s.sessions.start({ project: "demo", prompt: { text: "run" } });
    await until(() => s.sessions.get(session.id)?.state === "waiting");
    await s.sessions.interrupt(session.id);
    await until(() => s.sessions.get(session.id)?.state === "idle");
    assert.equal(executed, 0);
    assert.equal((await s.sessions.detail(session.id))!.pending.length, 0);
  } finally { await s.sessions.close(); await s.services.notebooks.close(); await s.services.library.close(); s.deps.db.close(); }
});
test("a session goes back to running when its last prompt closes, even if the harness sends no running state", async () => {
  const request = { id: "perm-1", sessionId: "x", kind: "plan", toolName: "ExitPlanMode", toolUseId: "t1", input: { plan: "1. do it" }, title: "Plan", description: null, canAlwaysAllow: false, defaultToDeny: true, createdAt: new Date().toISOString() } as const;
  const s = setup({ harness: { script: () => [
    { emit: { type: "permission.request", request } },
    { emit: { type: "state", state: "waiting" } },
    { wait: 80 },
    { emit: { type: "permission.resolved", requestId: "perm-1", behavior: "deny" } },
    { wait: 400 },
  ] } });
  try {
    const session = await s.sessions.start({ project: "demo", prompt: { text: "plan" } });
    await until(() => s.sessions.get(session.id)?.state === "waiting");
    assert.equal(s.sessions.get(session.id)?.waitingFor, "permission");
    await until(() => s.sessions.get(session.id)?.state === "running");
    assert.equal(s.sessions.get(session.id)?.waitingFor, null);
  } finally { await s.sessions.close(); await s.services.library.close(); s.deps.db.close(); }
});
