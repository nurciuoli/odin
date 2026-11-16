import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { NotebookExecution, NotebookKernel, NotebookSnapshot } from "@odin/shared/notebooks";
import { startApp } from "../test-helpers.ts";
import { createNotebooksService } from "./service.ts";

test("notebook HTTP routes round-trip revisions, execution handles and project export", async () => {
  const t = await startApp();
  try {
    const path = join(t.config.home, "..", "project"); mkdirSync(path, { recursive: true });
    await t.app.services.projects.create({ path, name: "data" });
    await t.app.services.notebooks.close();
    t.app.services.notebooks = createNotebooksService(t.app.deps, t.app.services, { idleTimeoutMs: 0, runtimeFactory: () => ({ async start() {}, async createKernel(input) { return input.id; }, async execute(_id, _source, output) { output({ type: "stream", content: { text: "hello\n" } }); output({ type: "display_data", content: { data: { "text/html": "<script>parent.document.cookie</script><p>Untrusted</p>" } } }); }, async interrupt() {}, async stop() {}, async close() {} }) });
    const k = await t.json<NotebookKernel>("/api/projects/data/notebooks", { method: "POST", body: JSON.stringify({ name: "Analysis", interpreter: "python" }) });
    assert.equal((await t.json<NotebookKernel[]>("/api/projects/data/notebooks"))[0].id, k.id);
    const snapshot = await t.json<NotebookSnapshot>(`/api/notebooks/${k.id}`);
    assert.equal(snapshot.cells.length, 0);
    const run = await t.json<NotebookExecution>(`/api/notebooks/${k.id}/execute`, { method: "POST", body: JSON.stringify({ revision: snapshot.revision, source: "print('hello')" }) });
    const done = await t.json<NotebookExecution>(`/api/notebook-executions/${run.id}/wait`, { method: "POST", body: JSON.stringify({ timeoutMs: 1000 }) });
    assert.equal(done.state, "completed");
    const rich = await t.api(`/a/notebooks/${k.id}/${run.cellId}/1`);
    assert.equal(rich.status, 200); assert.match(rich.headers.get("content-security-policy")!, /sandbox allow-scripts allow-forms/); assert.doesNotMatch(rich.headers.get("content-security-policy")!, /allow-same-origin/); assert.match(await rich.text(), /Untrusted/);
    assert.equal((await t.api(`/api/notebooks/${k.id}/comm`, { method: "POST", body: JSON.stringify({ type: "comm_open", commId: "evil", targetName: "arbitrary", data: {} }) })).status, 400);
    assert.equal((await t.api(`/api/notebooks/${k.id}/execute`, { method: "POST", headers: { origin: "https://evil.example" }, body: JSON.stringify({ revision: snapshot.revision, source: "forged()" }) })).status, 403);
    const stale = await t.api(`/api/notebooks/${k.id}`, { method: "PUT", body: JSON.stringify({ revision: snapshot.revision, cells: [] }) }); assert.equal(stale.status, 409);
    const forged = await t.api(`/api/notebooks/${k.id}/execute`, { method: "POST", body: JSON.stringify({ revision: snapshot.revision, source: "hi", sessionId: "agent" }) }); assert.equal(forged.status, 400);
    assert.deepEqual(await t.json(`/api/notebooks/${k.id}/save-to-project`, { method: "POST", body: JSON.stringify({ path: "report.ipynb" }) }), { path: "report.ipynb" });
    assert.equal((await t.api(`/api/notebooks/${k.id}`, { method: "DELETE" })).status, 204);
    assert.equal((await t.api(`/api/notebooks/${k.id}`)).status, 404);
  } finally { await t.close(); }
});
