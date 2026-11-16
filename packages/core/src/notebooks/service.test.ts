import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "@odin/shared/api";
import type { JupyterOutput } from "./runtime.ts";
import type { NotebookComm } from "@odin/shared/notebooks";
import { createNotebooksService, type ServiceRuntime } from "./service.ts";
import { stubServices, testDeps } from "../test-helpers.ts";
import { HttpError } from "../http/util.ts";

function setup(execute?: ServiceRuntime["execute"]) {
  const deps = testDeps();
  const path = join(deps.config.home, "..", "project"); mkdirSync(path, { recursive: true });
  const at = deps.now().toISOString();
  deps.db.prepare("INSERT INTO projects(name, path, created_at, updated_at) VALUES ('demo', ?, ?, ?)").run(path, at, at);
  for (const id of ["a", "b"]) deps.db.prepare("INSERT INTO sessions(id, project, title, harness, origin, state, cwd, created_at, updated_at, metrics) VALUES (?, 'demo', 'test', 'claude', 'odin', 'idle', ?, ?, ?, '{}')").run(id, path, at, at);
  const calls: string[] = [];
  let interrupted = 0, stopped = 0;
  const runtime: ServiceRuntime = { async start() {}, async createKernel(input) { calls.push("create:" + input.cwd); return input.id; }, async execute(id, source, output) { calls.push(source); if (execute) await execute(id, source, output); else output({ type: "stream", content: { name: "stdout", text: "42\n" } }); }, async interrupt() { interrupted++; }, async stop() { stopped++; }, async close() {} };
  const services = stubServices({ projects: { get: (name: string) => name === "demo" ? { name, path } : null, resolveCwd: (value: string) => value === path ? "demo" : null, noteWritten() {} } as never, sessions: { get: (id: string) => ["a", "b"].includes(id) ? { id, project: "demo", cwd: path, harness: "claude" } as Session : null } as never });
  const notebooks = createNotebooksService(deps, services, { runtimeFactory: () => runtime, idleTimeoutMs: 0, detectEnvironment: async () => ({ kind: "venv", interpreter: join(path, ".venv", "python"), managedHostPython: "managed-python", needsSetup: false }) }); services.notebooks = notebooks;
  return { deps, path, notebooks, calls, runtime, services, interrupted: () => interrupted, stopped: () => stopped, async close() { await notebooks.close(); deps.db.close(); rmSync(join(deps.config.home, ".."), { recursive: true, force: true }); } };
}
const status = (n: number) => (error: unknown) => error instanceof HttpError && error.status === n;

test("persisted notebook execution retains state across session attachments, attribution and notices", async () => {
  const s = setup();
  try {
    const kernel = await s.notebooks.create("demo", { name: "Analysis" });
    s.notebooks.attach("a", kernel.id); s.notebooks.attach("b", kernel.id);
    const run = await s.notebooks.execute(kernel.id, { revision: s.notebooks.snapshot(kernel.id).revision, source: "print(42)", sessionId: "a" });
    assert.equal((await s.notebooks.wait(run.id, 1000)).state, "completed");
    const snapshot = s.notebooks.snapshot(kernel.id);
    assert.deepEqual(snapshot.cells[0].outputs, [{ type: "stream", name: "stdout", text: "42\n" }]);
    assert.deepEqual(snapshot.cells[0].author, { kind: "agent", sessionId: "a" });
    const ipynb = JSON.parse(readFileSync(join(s.deps.config.home, "notebooks", `${kernel.id}.ipynb`), "utf8"));
    assert.equal(ipynb.nbformat, 4); assert.equal(ipynb.cells[0].outputs[0].output_type, "stream");
    assert.equal(s.notebooks.forSession("b")[0].cwd, s.path);
    assert.equal(s.calls.filter(value => value.startsWith("create:")).length, 1);
    assert.equal(s.notebooks.notices("a").length, 1); assert.equal(s.notebooks.notices("b").length, 1);
    s.notebooks.acknowledgeNotices("a", s.notebooks.notices("b").map(value => value.id)); assert.equal(s.notebooks.notices("b").length, 1);
  } finally { await s.close(); }
});

test("optimistic revisions reject stale edits and unknown cell execution", async () => {
  const s = setup();
  try {
    const k = await s.notebooks.create("demo", { name: "Analysis" }); const snapshot = s.notebooks.snapshot(k.id);
    const cells = [{ id: "cell-1", kind: "code" as const, source: "x = 1", outputs: [], executionCount: null, author: { kind: "human" as const } }];
    s.notebooks.save(k.id, snapshot.revision, cells);
    assert.throws(() => s.notebooks.save(k.id, snapshot.revision, []), status(409));
    await assert.rejects(s.notebooks.execute(k.id, { revision: s.notebooks.snapshot(k.id).revision, cellId: "missing" }), status(404));
    assert.equal(s.notebooks.snapshot(k.id).cells[0].source, "x = 1");
  } finally { await s.close(); }
});

test("long execution returns a handle, serializes runs and supports interrupt", async () => {
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  let running = 0, max = 0;
  const s = setup(async () => { running++; max = Math.max(max, running); await blocked; running--; });
  try {
    const k = await s.notebooks.create("demo", { name: "Analysis" });
    const first = await s.notebooks.execute(k.id, { revision: s.notebooks.snapshot(k.id).revision, source: "long()" });
    const second = await s.notebooks.execute(k.id, { revision: s.notebooks.snapshot(k.id).revision, source: "later()" });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await s.notebooks.wait(first.id, 1)).state, "running"); assert.equal(s.notebooks.execution(second.id).state, "queued");
    assert.throws(() => s.notebooks.save(k.id, s.notebooks.snapshot(k.id).revision, []), status(409));
    await s.notebooks.interrupt(k.id); release();
    assert.equal((await s.notebooks.wait(first.id, 1000)).state, "interrupted");
    assert.equal((await s.notebooks.wait(second.id, 1000)).state, "interrupted"); assert.equal(max, 1);
    assert.equal(s.interrupted(), 1);
  } finally { release(); await s.close(); }
});

test("errors and large outputs are bounded and secret previews are scrubbed", async () => {
  const s = setup(async (_id, _source, output) => {
    output({ type: "stream", content: { text: "api_key=secretvalue hello sk-1234567890123456789" } });
    output({ type: "display_data", content: { data: { "text/plain": 'password="value"', "image/png": "AAAA" } } });
    output({ type: "stream", content: { text: "x".repeat(5 * 1024 * 1024) } });
    throw new Error("password=hidden failure");
  });
  try {
    const k = await s.notebooks.create("demo", { name: "Analysis" }); const run = await s.notebooks.execute(k.id, { revision: s.notebooks.snapshot(k.id).revision, source: "bad()" });
    const done = await s.notebooks.wait(run.id, 1000); assert.equal(done.state, "failed");
    assert.equal(done.error?.includes("hidden"), false);
    const snapshot = JSON.stringify(s.notebooks.snapshot(k.id)); assert.equal(snapshot.includes("secretvalue"), false); assert.equal(snapshot.includes("1234567890123456789"), false); assert.ok(snapshot.includes("truncated"));
    assert.ok(snapshot.length < 10000);
  } finally { await s.close(); }
});

test("save-to-project refuses traversal and overwrites; remove releases project reference", async () => {
  const s = setup();
  try {
    const k = await s.notebooks.create("demo", { name: "Analysis" });
    await assert.rejects(s.notebooks.exportToProject(k.id, "../bad.ipynb"), status(400));
    assert.deepEqual(await s.notebooks.exportToProject(k.id, "analysis.ipynb"), { path: "analysis.ipynb" });
    await assert.rejects(s.notebooks.exportToProject(k.id, "analysis.ipynb"), status(409));
    assert.equal(s.notebooks.usesPath(s.path), true); await s.notebooks.remove(k.id); assert.equal(s.notebooks.usesPath(s.path), false);
    assert.equal(s.notebooks.list("demo").length, 0);
  } finally { await s.close(); }
});

test("restart leaves interrupted runs and stopped kernels, without code replay", async () => {
  const s = setup();
  try {
    const k = await s.notebooks.create("demo", { name: "Analysis" });
    s.deps.db.prepare("UPDATE notebook_kernels SET state = 'busy', editor = 'jupyterlab' WHERE id = ?").run(k.id);
    s.deps.db.prepare("INSERT INTO notebook_executions(id,kernel_id,cell_id,state) VALUES('old',?,'cell','running')").run(k.id);
    const recovered = createNotebooksService(s.deps, stubServices({ projects: { get: () => ({ path: s.path }) } as never }), { runtimeFactory: () => { throw new Error("must not start"); } });
    assert.equal(recovered.snapshot(k.id).kernel.state, "stopped"); assert.equal(recovered.snapshot(k.id).editor, "odin"); assert.equal(recovered.execution("old").state, "interrupted"); assert.equal(s.calls.length, 0);
    await recovered.close();
  } finally { await s.close(); }
});

test("clear_output and display updates persist Jupyter semantics", async () => {
  const s = setup(async (_id, _source, output) => {
    for (const value of [
      { type: "stream", content: { text: "old" } },
      { type: "clear_output", content: { wait: true } },
      { type: "display_data", content: { data: { "text/plain": "one" }, transient: { display_id: "plot" } } },
      { type: "update_display_data", content: { data: { "text/plain": "two" }, transient: { display_id: "plot" } } },
    ]) output(value as JupyterOutput);
  });
  try {
    const k = await s.notebooks.create("demo", { name: "Analysis" }); const run = await s.notebooks.execute(k.id, { revision: s.notebooks.snapshot(k.id).revision, source: "display()" }); await s.notebooks.wait(run.id, 1000);
    const cells = s.notebooks.snapshot(k.id).cells; assert.equal(cells[0].outputs.length, 1); assert.equal((cells[0].outputs[0] as { data: Record<string, unknown> }).data["text/plain"], "two");
  } finally { await s.close(); }
});

test("inspection serializes bounded JSON without creating cells and rejects invalid queries", async () => {
  const s = setup(async (_id, source, output) => {
    const marker = /print\("(ODIN_INSPECT_[a-z0-9]+:)"/.exec(source)?.[1]; assert.ok(marker);
    output({ type: "stream", content: { text: marker + JSON.stringify(source.includes("frame.iloc") ? { columns: [{ name: "x", type: "int64" }], rows: [[42]], total: 100, offset: 10, limit: 5 } : [{ name: "df", type: "DataFrame", preview: "100 rows", shape: [100, 1] }]) + "\n" } });
  });
  try {
    const k = await s.notebooks.create("demo", { name: "Analysis" });
    assert.equal((await s.notebooks.variables(k.id))[0].name, "df");
    assert.equal((await s.notebooks.dataframe(k.id, "df", { offset: 10, limit: 5, sort: "x" })).rows[0][0], 42);
    assert.equal(s.notebooks.snapshot(k.id).cells.length, 0);
    await assert.rejects(s.notebooks.dataframe(k.id, "df;evil()", {}), status(400));
    await assert.rejects(s.notebooks.dataframe(k.id, "df", { limit: 10000 }), status(400));
    assert.equal(s.notebooks.hostTools("a").find(tool => tool.name === "notebook_variables")?.effect, "execute");
  } finally { await s.close(); }
});

test("exclusive JupyterLab lease blocks Odin writes and reloads external edits on reclaim", async () => {
  const s = setup(); let closed = false;
  s.runtime.openLab = async () => ({ url: "http://127.0.0.1:54321/lab" });
  s.runtime.closeLab = async () => { closed = true; };
  try {
    const k = await s.notebooks.create("demo", { name: "Analysis" });
    await s.notebooks.handoff(k.id); const snapshot = s.notebooks.snapshot(k.id); assert.equal(snapshot.editor, "jupyterlab");
    assert.throws(() => s.notebooks.save(k.id, snapshot.revision, []), status(409));
    await assert.rejects(s.notebooks.execute(k.id, { revision: snapshot.revision, source: "x" }), status(409));
    await assert.rejects(s.notebooks.stop(k.id), status(409));
    const filename = join(s.deps.config.home, "notebooks", `${k.id}.ipynb`);
    const doc = JSON.parse(readFileSync(filename, "utf8")); doc.cells.push({ id: "lab-cell", cell_type: "code", source: "external", metadata: {}, outputs: [], execution_count: null }); writeFileSync(filename, JSON.stringify(doc));
    const returned = await s.notebooks.reclaim(k.id); assert.equal(closed, true); assert.equal(returned.editor, "odin"); assert.equal(returned.cells[0].source, "external");
  } finally { await s.close(); }
});

test("widget state merges bounded known models and rejects unrelated callback targets", async () => {
  const s = setup(); let incoming!: (message: NotebookComm) => void; const sent: NotebookComm[] = [];
  s.runtime.subscribeComms = (_id, listener) => { incoming = listener; return () => {}; };
  s.runtime.sendComm = async (_id, message) => { sent.push(message); };
  try {
    const k = await s.notebooks.create("demo", { name: "Analysis" });
    const run = await s.notebooks.execute(k.id, { revision: s.notebooks.snapshot(k.id).revision, source: "widgets()" }); await s.notebooks.wait(run.id, 1000);
    incoming({ type: "comm_open", commId: "bad", targetName: "arbitrary.target", data: {} }); assert.equal(s.notebooks.widgetState(k.id).length, 0);
    incoming({ type: "comm_open", commId: "slider", targetName: "jupyter.widget", data: { state: { value: 1, min: 0 } } });
    incoming({ type: "comm_msg", commId: "slider", data: { method: "update", state: { value: 2 } } });
    assert.deepEqual(s.notebooks.widgetState(k.id)[0].data.state, { value: 2, min: 0 });
    await assert.rejects(s.notebooks.sendComm(k.id, { type: "comm_msg", commId: "unknown", data: {} }), status(400));
    await assert.rejects(s.notebooks.sendComm(k.id, { type: "comm_open", commId: "slider", targetName: "jupyter.widget", data: {} }), status(400));
    await s.notebooks.sendComm(k.id, { type: "comm_msg", commId: "slider", data: { method: "update", state: { value: 3 } } }); assert.equal(sent.length, 1);
    await s.notebooks.stop(k.id); assert.equal(s.notebooks.widgetState(k.id).length, 0);
  } finally { await s.close(); }
});

test("kernel creation selects detected environment and missing environments require explicit setup", async () => {
  const s = setup();
  try {
    const k = await s.notebooks.create("demo", { name: "Detected" }); assert.equal(k.interpreter, join(s.path, ".venv", "python"));
    const missing = createNotebooksService(s.deps, s.services, { detectEnvironment: async () => ({ kind: "missing", interpreter: null, managedHostPython: "managed-python", needsSetup: true }) });
    await assert.rejects(missing.create("demo", { name: "Missing" }), status(409));
    assert.equal(missing.list("demo").length, 1); await missing.close();
  } finally { await s.close(); }
});

test("hand-off reserves its lease before asynchronous startup and duplicate cell runs are refused", async () => {
  const s = setup(); let open!: () => void;
  s.runtime.openLab = () => new Promise(resolve => { open = () => resolve({ url: "http://127.0.0.1:54321/lab" }); });
  try {
    const k = await s.notebooks.create("demo", { name: "Lease" });
    const handingOff = s.notebooks.handoff(k.id);
    await assert.rejects(s.notebooks.execute(k.id, { revision: s.notebooks.snapshot(k.id).revision, source: "race()" }), status(409));
    await new Promise(resolve => setImmediate(resolve)); open(); await handingOff; await s.notebooks.reclaim(k.id);
    let release!: () => void; s.runtime.execute = async () => new Promise<void>(resolve => { release = resolve; });
    const run = await s.notebooks.execute(k.id, { revision: s.notebooks.snapshot(k.id).revision, source: "long()" });
    await assert.rejects(s.notebooks.execute(k.id, { revision: s.notebooks.snapshot(k.id).revision, cellId: run.cellId, source: "changed()" }), status(409));
    await new Promise(resolve => setImmediate(resolve)); release(); await s.notebooks.wait(run.id, 1000);
  } finally { await s.close(); }
});

test("agent output paging exposes large output tails without oversized tool messages", async () => {
  const s = setup(async (_id, _source, output) => { output({ type: "stream", content: { text: "x".repeat(100000) + "THE END" } }); });
  try {
    const k = await s.notebooks.create("demo", { name: "Output" });
    const run = await s.notebooks.execute(k.id, { revision: s.notebooks.snapshot(k.id).revision, source: "large()", sessionId: "a" }); await s.notebooks.wait(run.id, 1000);
    const tool = s.notebooks.hostTools("a").find(value => value.name === "notebook_output")!;
    const first = JSON.parse((await tool.handler({ kernel_id: k.id, cell_id: run.cellId, limit: 1000 })).text); assert.equal(first.hasMore, true); assert.equal(first.total, 100007);
    const tail = JSON.parse((await tool.handler({ kernel_id: k.id, cell_id: run.cellId, offset: 100000, limit: 1000 })).text); assert.equal(tail.text, "THE END"); assert.equal(tail.hasMore, false);
  } finally { await s.close(); }
});
