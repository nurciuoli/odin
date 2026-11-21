import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NotebookExecution, NotebookKernel, NotebookSnapshot } from "@odin/shared/notebooks";
import { startApp } from "../test-helpers.ts";
import { createNotebooksService } from "./service.ts";

test("notebook HTTP routes open files by path and round-trip revisions and execution handles", async () => {
  const t = await startApp();
  try {
    const path = join(t.config.home, "..", "project"); mkdirSync(path, { recursive: true });
    await t.app.services.projects.create({ path, name: "data" });
    await t.app.services.notebooks.close();
    t.app.services.notebooks = createNotebooksService(t.app.deps, t.app.services, { idleTimeoutMs: 0, runtimeFactory: () => ({ async start() {}, async createKernel(input) { return input.id; }, async execute(_id, _source, output) { output({ type: "stream", content: { text: "hello\n" } }); output({ type: "display_data", content: { data: { "text/html": "<script>parent.document.cookie</script><p>Untrusted</p>" } } }); }, async interrupt() {}, async stop() {}, async close() {} }) });
    assert.equal((await t.api("/api/projects/data/notebooks", { method: "POST", body: JSON.stringify({ name: "Analysis" }) })).status, 405, "old create route is gone");
    assert.equal((await t.api("/api/projects/data/notebooks/open", { method: "POST", body: JSON.stringify({ path: "analysis.ipynb", interpreter: "python" }) })).status, 404, "missing file without create");
    assert.equal((await t.api("/api/projects/data/notebooks/open", { method: "POST", body: JSON.stringify({ path: "../escape.ipynb", create: true }) })).status, 400);
    const k = await t.json<NotebookKernel>("/api/projects/data/notebooks/open", { method: "POST", body: JSON.stringify({ path: "sub/analysis.ipynb", create: true, interpreter: "python" }) });
    assert.equal(k.path, "sub/analysis.ipynb"); assert.ok(existsSync(join(path, "sub", "analysis.ipynb")));
    assert.equal((await t.json<NotebookKernel>("/api/projects/data/notebooks/open", { method: "POST", body: JSON.stringify({ path: "sub/analysis.ipynb" }) })).id, k.id);
    assert.equal((await t.json<NotebookKernel[]>("/api/projects/data/notebooks")).length, 1);
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
    for (const gone of ["handoff", "reclaim", "save-to-project"]) assert.ok([404, 405].includes((await t.api(`/api/notebooks/${k.id}/${gone}`, { method: "POST", body: "{}" })).status), gone);
    assert.equal((await t.api(`/api/notebooks/${k.id}`, { method: "DELETE" })).status, 204);
    assert.equal((await t.api(`/api/notebooks/${k.id}`)).status, 404);
    assert.ok(existsSync(join(path, "sub", "analysis.ipynb")), "DELETE keeps the file");
  } finally { await t.close(); }
});

test("large Plotly results stay portable and load on demand in a sandboxed page", async () => {
  const t = await startApp();
  const mime = "application/vnd.plotly.v1+json";
  const trace = {
    type: "scattergl",
    y: Array.from({ length: 12_000 }, (_, index) => index),
    customdata: Array.from({ length: 12_000 }, () => "a".repeat(450)),
  };
  const title = '</script><script id="injected">throw "bad"</script>';
  const figure = { data: [trace], layout: { title: { text: title } } };
  const metadata = { [mime]: { width: 640 } };
  assert.ok(Buffer.byteLength(JSON.stringify(figure)) > 5 * 1024 * 1024);
  try {
    const path = join(t.config.home, "..", "project");
    mkdirSync(path, { recursive: true });
    await t.app.services.projects.create({ path, name: "data" });
    await t.app.services.notebooks.close();
    const streamed: unknown[] = [];
    const unsubscribe = t.app.deps.bus.subscribe(event => {
      if (event.type === "notebook.output") streamed.push(event);
    });
    t.app.services.notebooks = createNotebooksService(t.app.deps, t.app.services, {
      idleTimeoutMs: 0,
      runtimeFactory: () => ({
        async start() {},
        async createKernel(input) { return input.id; },
        async execute(_id, _source, output) {
          output({ type: "execute_result", content: { execution_count: 5, data: { [mime]: figure }, metadata } });
          return 5;
        },
        async interrupt() {},
        async stop() {},
        async close() {},
      }),
    });
    const open = { path: "large.ipynb", create: true, interpreter: "python" };
    const k = await t.json<NotebookKernel>("/api/projects/data/notebooks/open", { method: "POST", body: JSON.stringify(open) });
    const api = "/api/notebooks/" + k.id;
    const initial = await t.json<NotebookSnapshot>(api);
    const run = await t.json<NotebookExecution>(api + "/execute", { method: "POST", body: JSON.stringify({ revision: initial.revision, source: "figure" }) });
    const done = await t.json<NotebookExecution>("/api/notebook-executions/" + run.id + "/wait", { method: "POST", body: JSON.stringify({ timeoutMs: 5000 }) });
    assert.equal(done.state, "completed");
    unsubscribe();
    assert.equal(streamed.length, 1);
    const wire = JSON.stringify(streamed[0]);
    assert.ok(wire.length < 1024);
    assert.match(wire, /"outputIndex":0/);
    assert.match(wire, /"type":"reference"/);

    const snapshot = await t.json<NotebookSnapshot>(api);
    assert.equal(snapshot.cells[0].executionCount, 5);
    assert.equal(snapshot.cells[0].outputs[0].type, "reference");
    const sourceOnly = snapshot.cells.map(({ id, kind, source }) => ({ id, kind, source }));
    sourceOnly.push({ id: "notes", kind: "markdown", source: "Imported chart" });
    const saved = await t.json<NotebookSnapshot>(api, { method: "PUT", body: JSON.stringify({ revision: snapshot.revision, cells: sourceOnly }) });
    assert.deepEqual(saved.cells[0].outputs[0], snapshot.cells[0].outputs[0]);

    const persisted = JSON.parse(readFileSync(join(path, "large.ipynb"), "utf8")).cells[0].outputs[0];
    assert.equal(persisted.output_type, "execute_result");
    assert.equal(persisted.execution_count, 5);
    assert.deepEqual(persisted.metadata, metadata);
    assert.equal(persisted.data[mime].data[0].customdata.length, trace.customdata.length);

    assert.equal((await t.api(api, { method: "DELETE" })).status, 204);
    const reopened = await t.json<NotebookKernel>("/api/projects/data/notebooks/open", { method: "POST", body: JSON.stringify(open) });
    const view = await t.api("/a/notebooks/" + reopened.id + "/" + run.cellId + "/0");
    assert.equal(view.status, 200);
    assert.match(view.headers.get("content-security-policy")!, /script-src 'unsafe-inline'.*sandbox allow-scripts allow-forms/);
    const html = await view.text();
    assert.match(html, /Plotly\.newPlot/);
    assert.doesNotMatch(html, /<script id="injected">/);
    assert.match(html, /\\u003c\/script>/);
  } finally { await t.close(); }
});
