import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep, join } from "node:path";
import { lstatSync, realpathSync, writeFileSync, unlinkSync } from "node:fs";
import type { CreateKernelRequest, ExecuteCellRequest, NotebookCell, NotebookExecution, NotebookKernel, NotebookNotice, NotebookOutput, NotebookVariable, NotebookDataFrame, DataFrameQuery, NotebookComm } from "@odin/shared/notebooks";
import type { Deps, NotebooksService, Services } from "../services.ts";
import type { HostTool, HostToolResult } from "../harness/types.ts";
import { HttpError } from "../http/util.ts";
import { createNotebookStorage, type IpynbCell } from "./storage.ts";
import { createNotebookRuntime, type JupyterOutput } from "./runtime.ts";
import { detectNotebookEnvironment } from "./environment.ts";

type Row = { id: string; project: string; name: string; cwd: string; interpreter: string; location: string; state: NotebookKernel["state"]; editor: "odin" | "jupyterlab"; error: string | null; created_at: string; updated_at: string };
export interface ServiceRuntime {
  start(): Promise<void>;
  createKernel(input: { id: string; cwd: string; interpreter: string }): Promise<string>;
  execute(kernelId: string, code: string, onOutput: (output: JupyterOutput) => void): Promise<void>;
  interrupt(kernelId: string): Promise<void>;
  stop(kernelId: string): Promise<void>;
  close(): Promise<void>;
  openLab?(options: { notebookPath: string; kernelId: string }): Promise<{ url: string }>;
  closeLab?(): Promise<void>;
  subscribeComms?(kernelId: string, listener: (message: NotebookComm) => void): () => void;
  sendComm?(kernelId: string, message: NotebookComm): Promise<void>;
}
export interface NotebookServiceOptions {
  runtimeFactory?: (kernel: NotebookKernel) => ServiceRuntime;
  idleTimeoutMs?: number;
  detectEnvironment?: typeof detectNotebookEnvironment;
}
const terminal = (value: NotebookExecution) => !["queued", "running"].includes(value.state);
const text = (value: unknown) => typeof value === "string" ? value : "";
const mimeText = (value: unknown) => Array.isArray(value) && value.every(line => typeof line === "string") ? value.join("") : text(value);
const scrub = (value: string) => value.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,})\b/g, "[redacted]")
  .replace(/((?:api[_-]?key|access[_-]?token|authorization|password|secret)\s*[=:]\s*)([^\s,;]+)/gi, "$1[redacted]");
function scrubData(value: unknown, depth = 0): unknown {
  if (depth > 20) return "[nested value omitted]";
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.slice(0, 10000).map(item => scrubData(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 10000).map(([key, item]) => [key, key.startsWith("image/") ? item : scrubData(item, depth + 1)]));
  return value;
}
function outputFromRaw(raw: { type?: unknown; msg_type?: unknown; content?: unknown; [key: string]: unknown } | JupyterOutput): NotebookOutput | null {
  const kind = raw.type ?? ("msg_type" in raw ? raw.msg_type : undefined);
  const content = raw.content && typeof raw.content === "object" ? raw.content as Record<string, unknown> : raw as Record<string, unknown>;
  if (kind === "stream") return { type: "stream", name: content.name === "stderr" ? "stderr" : "stdout", text: scrub(mimeText(content.text)) };
  if (kind === "error") return { type: "error", name: text(content.ename ?? content.name), message: scrub(text(content.evalue ?? content.message)), traceback: Array.isArray(content.traceback) ? content.traceback.map(line => scrub(text(line))) : [] };
  if (["display", "display_data", "execute_result", "update_display_data"].includes(String(kind))) {
    const data = content.data && typeof content.data === "object" ? content.data as Record<string, unknown> : {};
    return { type: "display", data: scrubData(data) as Record<string, unknown>, metadata: content.metadata && typeof content.metadata === "object" ? content.metadata as Record<string, unknown> : {} };
  }
  return null;
}
function asOutput(output: NotebookOutput): Record<string, unknown> {
  if (output.type === "stream") return { output_type: "stream", name: output.name, text: output.text };
  if (output.type === "error") return { output_type: "error", ename: output.name, evalue: output.message, traceback: output.traceback };
  return { output_type: "display_data", data: output.data, metadata: output.metadata ?? {} };
}
function asCell(cell: IpynbCell): NotebookCell {
  const author = cell.metadata?.odin_author;
  return { id: cell.id, kind: cell.cell_type === "code" ? "code" : "markdown", source: Array.isArray(cell.source) ? cell.source.join("") : cell.source,
    executionCount: cell.execution_count ?? null,
    author: author && typeof author === "object" && (author as { kind?: string }).kind === "agent" && typeof (author as { sessionId?: unknown }).sessionId === "string" ? { kind: "agent", sessionId: (author as { sessionId: string }).sessionId } : { kind: "human" },
    outputs: (cell.outputs ?? []).map(raw => outputFromRaw({ ...raw, type: raw.output_type })).filter((output): output is NotebookOutput => output !== null) };
}
function persistedCell(cell: NotebookCell): IpynbCell {
  return { id: cell.id, cell_type: cell.kind, source: cell.source, metadata: { odin_author: cell.author },
    ...(cell.kind === "code" ? { execution_count: cell.executionCount, outputs: cell.outputs.map(asOutput) } : {}) };
}

export function createNotebooksService(deps: Deps, services: Services, options: NotebookServiceOptions = {}): NotebooksService {
  const { db, bus } = deps;
  const now = () => deps.now().toISOString();
  const storage = createNotebookStorage(deps.config.home);
  const hosts = new Map<string, ServiceRuntime>();
  const nativeIds = new Map<string, string>();
  const chains = new Map<string, Promise<void>>();
  const jobs = new Map<string, Promise<void>>();
  const interrupted = new Set<string>();
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const widgetModels = new Map<string, Map<string, NotebookComm>>();
  const commSubscriptions = new Map<string, () => void>();
  const transitions = new Set<string>();
  let closed = false;
  db.prepare("UPDATE notebook_kernels SET state = 'stopped', editor = 'odin' WHERE state != 'stopped' OR editor != 'odin'").run();
  db.prepare("UPDATE notebook_executions SET state = 'interrupted', finished_at = ?, error = 'Odin restarted; code was not replayed' WHERE state IN ('running', 'queued')").run(now());
  function row(id: string): Row {
    const value = db.prepare("SELECT * FROM notebook_kernels WHERE id = ?").get(id) as Row | undefined;
    if (!value) throw new HttpError(404, "unknown notebook kernel");
    return value;
  }
  function kernel(value: Row): NotebookKernel {
    return { id: value.id, project: value.project, name: value.name, cwd: value.cwd, interpreter: value.interpreter,
      location: JSON.parse(value.location), state: value.state, error: value.error, createdAt: value.created_at, updatedAt: value.updated_at };
  }
  function state(id: string, value: NotebookKernel["state"], error: string | null = null) {
    db.prepare("UPDATE notebook_kernels SET state = ?, error = ?, updated_at = ? WHERE id = ?").run(value, error, now(), id);
  }
  function publish(id: string) {
    const value = row(id); let revision = "";
    try { revision = storage.read(id).revision; } catch { /* Refetch exposes corrupt/external file errors without losing execution receipts. */ }
    bus.emit({ type: "notebook.updated", kernelId: id, project: value.project, revision });
  }
  function available(id: string) {
    if (closed) throw new HttpError(409, "notebook service is closing");
    if (transitions.has(id)) throw new HttpError(409, "a notebook lifecycle operation is in progress");
    if (row(id).editor !== "odin") throw new HttpError(409, "return the notebook from JupyterLab before editing or running");
  }
  function validateSession(sessionId: string, id: string) {
    const session = services.sessions.get(sessionId);
    if (!session) throw new HttpError(404, "unknown session");
    if (session.project !== row(id).project) throw new HttpError(403, "kernel belongs to another project");
    return session;
  }
  function notify(id: string, message: string, except?: string) {
    const links = db.prepare("SELECT session_id FROM notebook_session_links WHERE kernel_id = ?").all(id) as { session_id: string }[];
    for (const link of links) if (link.session_id !== except) {
      db.prepare("INSERT INTO notebook_notices(id, session_id, kernel_id, text, created_at) VALUES (?, ?, ?, ?, ?)").run(randomUUID(), link.session_id, id, message, now());
      db.prepare("DELETE FROM notebook_notices WHERE session_id = ? AND id NOT IN (SELECT id FROM notebook_notices WHERE session_id = ? ORDER BY rowid DESC LIMIT 1000)").run(link.session_id, link.session_id);
    }
  }
  function runtime(id: string) {
    const value = kernel(row(id));
    const key = `${value.project}:${JSON.stringify(value.location)}`;
    let host = hosts.get(key);
    if (!host) {
      host = options.runtimeFactory?.(value) ?? createNotebookRuntime({ home: deps.config.home, project: value.project, location: value.location, idleTimeoutMs: 0, onStopped: ids => {
        for (const [id, nativeId] of nativeIds) if (ids.includes(nativeId)) {
          nativeIds.delete(id);
          commSubscriptions.get(id)?.(); commSubscriptions.delete(id); widgetModels.delete(id);
          if (!closed) { state(id, "stopped"); db.prepare("UPDATE notebook_kernels SET editor = 'odin' WHERE id = ?").run(id); publish(id); }
        }
      }, onStatus: (nativeId, status) => {
        for (const [id, current] of nativeIds) if (current === nativeId && !closed) {
          state(id, status);
          if (status === "busy") clearIdle(id);
          else if (!chains.has(id) && row(id).editor === "odin") armIdle(id);
        }
      } });
      hosts.set(key, host);
    }
    return host;
  }
  async function ensureStarted(id: string) {
    const host = runtime(id);
    if (!nativeIds.has(id)) {
      state(id, "starting");
      await host.start();
      const value = row(id);
      nativeIds.set(id, await host.createKernel({ id, cwd: value.cwd, interpreter: value.interpreter }));
      if (host.subscribeComms) commSubscriptions.set(id, host.subscribeComms(nativeIds.get(id)!, message => {
        if (!validComm(message)) return;
        let models = widgetModels.get(id);
        if (!models) { models = new Map(); widgetModels.set(id, models); }
        if (message.type === "comm_open") {
          if (message.targetName !== "jupyter.widget" || (!models.has(message.commId) && models.size >= 256)) return;
          models.set(message.commId, structuredClone(message));
        } else {
          const previous = models.get(message.commId);
          if (!previous) return;
          if (message.type === "comm_close") models.delete(message.commId);
          else {
            const priorState = previous.data.state && typeof previous.data.state === "object" ? previous.data.state : {};
            const nextState = message.data.state && typeof message.data.state === "object" ? message.data.state : {};
            const next = { ...previous, data: { ...previous.data, ...message.data, state: { ...priorState, ...nextState } }, ...(message.buffers ? { buffers: message.buffers } : {}) };
            if (Buffer.byteLength(JSON.stringify(next)) > 1024 * 1024) return;
            models.set(message.commId, next);
          }
        }
        bus.emit({ type: "notebook.comm", kernelId: id, message: structuredClone(message) });
      }));
    }
    return { host, nativeId: nativeIds.get(id)! };
  }
  function validComm(message: NotebookComm): boolean {
    return !!message && ["comm_open", "comm_msg", "comm_close"].includes(message.type) && typeof message.commId === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(message.commId) &&
      !!message.data && typeof message.data === "object" && !Array.isArray(message.data) && Buffer.byteLength(JSON.stringify(message)) <= 1024 * 1024 &&
      (message.buffers === undefined || Array.isArray(message.buffers) && message.buffers.every(buffer => typeof buffer === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(buffer)));
  }
  async function inspect(id: string, expression: string): Promise<unknown> {
    available(id);
    if (chains.has(id) || row(id).state === "busy") throw new HttpError(409, "wait for kernel execution before inspection");
    const marker = `ODIN_INSPECT_${randomUUID().replaceAll("-", "")}:`;
    let captured = "", outputError = false, finished = false;
    const code = `def _odin_inspect_helper():\n import json, sys, math\n def clean(v):\n  if v is None or type(v) in (str, int, bool): return v\n  if type(v) is float: return v if math.isfinite(v) else str(v)\n  return str(v)[:500] if type(v).__module__.startswith('numpy') else '<' + type(v).__name__ + '>'\n ${expression.split("\n").join("\n ")}\n print(${JSON.stringify(marker)} + json.dumps(result, ensure_ascii=True, allow_nan=False))\ntry:\n _odin_inspect_helper()\nfinally:\n del _odin_inspect_helper\n`;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    chains.set(id, pending); clearIdle(id);
    let host: ServiceRuntime | undefined, nativeId: string | undefined;
    try {
      ({ host, nativeId } = await ensureStarted(id)); state(id, "busy");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([host.execute(nativeId, code, output => {
          if (output.type === "error") outputError = true;
          if (output.type === "stream") { captured += text(output.content.text); if (captured.length > 1024 * 1024) throw new Error("inspection output is too large"); }
        }), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new HttpError(408, "inspection timed out")), 10000); })]);
        finished = true;
      } finally { if (timer) clearTimeout(timer); }
      const start = captured.indexOf(marker);
      if (outputError || start < 0) throw new HttpError(400, "variable inspection failed");
      try { return scrubData(JSON.parse(captured.slice(start + marker.length).split("\n")[0])); }
      catch { throw new HttpError(400, "variable inspection returned invalid data"); }
    } catch (error) {
      if (error instanceof HttpError && error.status === 408 && host && nativeId) await host.interrupt(nativeId);
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "variable inspection failed");
    } finally {
      if (nativeIds.has(id) && finished) state(id, "idle");
      release(); if (chains.get(id) === pending) chains.delete(id); armIdle(id); publish(id);
    }
  }
  function clearIdle(id: string) { const timer = idleTimers.get(id); if (timer) clearTimeout(timer); idleTimers.delete(id); }
  function armIdle(id: string) {
    clearIdle(id);
    const timeout = options.idleTimeoutMs ?? 60 * 60 * 1000;
    if (closed || timeout <= 0 || row(id).state === "busy") return;
    const timer = setTimeout(() => { idleTimers.delete(id); if (!chains.has(id) && row(id).state !== "busy") void service.stop(id).catch(() => undefined); }, timeout);
    timer.unref(); idleTimers.set(id, timer);
  }
  function execution(id: string): NotebookExecution {
    const value = db.prepare("SELECT * FROM notebook_executions WHERE id = ?").get(id) as { id: string; kernel_id: string; cell_id: string; session_id: string | null; state: NotebookExecution["state"]; started_at: string | null; finished_at: string | null; error: string | null } | undefined;
    if (!value) throw new HttpError(404, "unknown notebook execution");
    return { id: value.id, kernelId: value.kernel_id, cellId: value.cell_id, sessionId: value.session_id, state: value.state, startedAt: value.started_at, finishedAt: value.finished_at, error: value.error };
  }
  function executionState(id: string, value: NotebookExecution["state"], error: string | null = null) {
    db.prepare("UPDATE notebook_executions SET state = ?, error = ?, started_at = CASE WHEN ? = 'running' THEN ? ELSE started_at END, finished_at = CASE WHEN ? IN ('completed','failed','interrupted') THEN ? ELSE finished_at END WHERE id = ?").run(value, error, value, now(), value, now(), id);
    bus.emit({ type: "notebook.execution", execution: execution(id) });
  }
  async function stopKernel(id: string) {
    clearIdle(id); await service.interrupt(id); await chains.get(id);
    const nativeId = nativeIds.get(id); if (nativeId) { await runtime(id).stop(nativeId); nativeIds.delete(id); }
    commSubscriptions.get(id)?.(); commSubscriptions.delete(id); widgetModels.delete(id);
    state(id, "stopped"); publish(id);
  }
  const service: NotebooksService = {
    list(project) {
      if (!services.projects.get(project)) throw new HttpError(404, "unknown project");
      return (db.prepare("SELECT * FROM notebook_kernels WHERE project = ? ORDER BY created_at, id").all(project) as Row[]).map(kernel);
    },
    async create(project, request: CreateKernelRequest) {
      if (closed) throw new HttpError(409, "notebook service is closing");
      const ref = services.projects.get(project);
      if (!ref) throw new HttpError(404, "unknown project");
      if (!request || typeof request.name !== "string" || !request.name.trim() || request.name.length > 100) throw new HttpError(400, "kernel name must contain 1 to 100 characters");
      const cwd = request.cwd ?? ref.path;
      if (typeof cwd !== "string" || (cwd !== ref.path && services.projects.resolveCwd(cwd) !== project)) throw new HttpError(400, "kernel directory must belong to the project");
      const location = request.location ?? { kind: "native" };
      if (!location || !["native", "wsl"].includes(location.kind) || (location.kind === "wsl" && (typeof location.distro !== "string" || !/^[A-Za-z0-9_.-]{1,100}$/.test(location.distro)))) throw new HttpError(400, "invalid execution location");
      if (request.interpreter !== undefined && (typeof request.interpreter !== "string" || !request.interpreter.trim() || request.interpreter.includes("\0"))) throw new HttpError(400, "invalid interpreter");
      if (db.prepare("SELECT id FROM notebook_kernels WHERE project = ? AND name = ?").get(project, request.name.trim())) throw new HttpError(409, "kernel name already exists");
      const interpreter = request.interpreter ?? (await (options.detectEnvironment ?? detectNotebookEnvironment)({ home: deps.config.home, cwd, location })).interpreter;
      if (!interpreter) throw new HttpError(409, "No Python project environment found. Set up a notebook environment or choose an interpreter before creating a kernel.");
      if (closed) throw new HttpError(409, "notebook service is closing");
      if (db.prepare("SELECT id FROM notebook_kernels WHERE project = ? AND name = ?").get(project, request.name.trim())) throw new HttpError(409, "kernel name already exists");
      const id = randomUUID();
      storage.write(id, { nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { name: `odin-${id}`, display_name: request.name.trim(), language: "python" }, language_info: { name: "python" } }, cells: [] }, null);
      db.prepare("INSERT INTO notebook_kernels(id, project, name, cwd, interpreter, location, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'stopped', ?, ?)").run(id, project, request.name.trim(), cwd, interpreter, JSON.stringify(location), now(), now());
      publish(id);
      return kernel(row(id));
    },
    snapshot(id) {
      const value = row(id), snapshot = storage.read(id);
      return { kernel: kernel(value), revision: snapshot.revision, cells: snapshot.document.cells.map(asCell), editor: value.editor };
    },
    save(id, revision, cells, sessionId) {
      available(id);
      if (sessionId) validateSession(sessionId, id);
      if (chains.has(id) || row(id).state === "busy") throw new HttpError(409, "wait for queued executions before editing");
      if (!Array.isArray(cells) || cells.length > 10000) throw new HttpError(400, "invalid cells");
      const ids = new Set<string>();
      for (const cell of cells) {
        if (!cell || typeof cell.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(cell.id) || ids.has(cell.id) || !["code", "markdown"].includes(cell.kind) || typeof cell.source !== "string" || Buffer.byteLength(cell.source) > 1024 * 1024) throw new HttpError(400, "invalid or duplicate cell");
        ids.add(cell.id);
      }
      const previous = storage.read(id);
      const old = new Map(previous.document.cells.map(cell => [cell.id, cell]));
      previous.document.cells = cells.map(cell => {
        const prior = old.get(cell.id);
        const unchanged = prior && asCell(prior).source === cell.source && asCell(prior).kind === cell.kind;
        if (unchanged) return prior;
        return persistedCell({ ...cell, author: sessionId ? { kind: "agent", sessionId } : { kind: "human" }, outputs: [], executionCount: null });
      });
      storage.write(id, previous.document, revision);
      db.prepare("UPDATE notebook_kernels SET updated_at = ? WHERE id = ?").run(now(), id);
      notify(id, `${sessionId ? "Another agent" : "You"} edited notebook ${row(id).name}. Reload the notebook before your next change.`, sessionId);
      publish(id);
      return service.snapshot(id);
    },
    attach(sessionId, id) { validateSession(sessionId, id); db.prepare("INSERT OR IGNORE INTO notebook_session_links(session_id, kernel_id) VALUES (?, ?)").run(sessionId, id); },
    forSession(sessionId) {
      if (!services.sessions.get(sessionId)) throw new HttpError(404, "unknown session");
      return (db.prepare("SELECT k.* FROM notebook_kernels k JOIN notebook_session_links l ON k.id = l.kernel_id WHERE l.session_id = ? ORDER BY k.created_at, k.id").all(sessionId) as Row[]).map(kernel);
    },
    async execute(id, request: ExecuteCellRequest) {
      available(id);
      if (!request || typeof request.revision !== "string") throw new HttpError(400, "notebook revision is required");
      if (request.sessionId) service.attach(request.sessionId, id);
      const snapshot = storage.read(id);
      if (snapshot.revision !== request.revision) throw new HttpError(409, "notebook changed; reload before running");
      let cell = request.cellId ? snapshot.document.cells.find(value => value.id === request.cellId) : undefined;
      if (request.cellId && !cell) throw new HttpError(404, "unknown cell");
      if (cell && db.prepare("SELECT id FROM notebook_executions WHERE kernel_id = ? AND cell_id = ? AND state IN ('queued','running')").get(id, cell.id)) throw new HttpError(409, "this cell already has a queued or running execution");
      if (!cell) { cell = persistedCell({ id: randomUUID(), kind: "code", source: "", outputs: [], executionCount: null, author: { kind: "human" } }); snapshot.document.cells.push(cell); }
      if (cell.cell_type !== "code") throw new HttpError(400, "only code cells execute");
      if (request.source !== undefined) {
        if (typeof request.source !== "string" || Buffer.byteLength(request.source) > 1024 * 1024) throw new HttpError(400, "source must be at most 1 MiB");
        cell.source = request.source;
      }
      const source = asCell(cell).source;
      const executionId = randomUUID(), cellId = cell.id;
      cell.metadata.odin_author = request.sessionId ? { kind: "agent", sessionId: request.sessionId } : { kind: "human" };
      storage.write(id, snapshot.document, request.revision);
      db.prepare("INSERT INTO notebook_executions(id, kernel_id, cell_id, session_id, state) VALUES (?, ?, ?, ?, 'queued')").run(executionId, id, cellId, request.sessionId ?? null);
      bus.emit({ type: "notebook.execution", execution: execution(executionId) }); publish(id); clearIdle(id);
      const previous = chains.get(id) ?? Promise.resolve();
      const job = previous.catch(() => undefined).then(async () => {
        if (closed || interrupted.has(executionId)) { executionState(executionId, "interrupted"); interrupted.delete(executionId); notify(id, `Notebook ${row(id).name}: cell ${cellId} interrupted.`); return; }
        let bytes = 0, events = 0, truncated = false, clearOnNextOutput = false;
        let outputCell: IpynbCell | undefined, outputTimer: ReturnType<typeof setTimeout> | undefined, flushError: unknown;
        const flush = () => {
          if (outputTimer) clearTimeout(outputTimer); outputTimer = undefined;
          if (!outputCell) return;
          const next = storage.read(id), target = next.document.cells.find(value => value.id === cellId)!;
          if (!target || asCell(target).source !== source) throw new HttpError(409, "cell changed on disk during execution; outputs were not written");
          target.outputs = outputCell.outputs; target.execution_count = outputCell.execution_count;
          storage.write(id, next.document, next.revision); publish(id);
        };
        const scheduleFlush = () => { if (!outputTimer) outputTimer = setTimeout(() => { try { flush(); } catch (error) { flushError = error; } }, 100); };
        try {
          const { host, nativeId } = await ensureStarted(id);
          state(id, "busy"); executionState(executionId, "running");
          const latest = storage.read(id), target = latest.document.cells.find(value => value.id === cellId)!;
          target.outputs = []; target.execution_count = (target.execution_count ?? 0) + 1;
          storage.write(id, latest.document, latest.revision);
          outputCell = target;
          await host.execute(nativeId, source, raw => {
            if (closed || interrupted.has(executionId)) return;
            if (flushError) throw flushError;
            if (truncated) return;
            const content = raw.content && typeof raw.content === "object" ? raw.content as Record<string, unknown> : raw;
            if (raw.type === "clear_output") {
              if (content.wait) clearOnNextOutput = true;
              else {
                outputCell!.outputs = []; scheduleFlush();
              }
              return;
            }
            const output = outputFromRaw(raw);
            if (!output) return;
            const size = Buffer.byteLength(JSON.stringify(output));
            if (bytes + size > 4 * 1024 * 1024 || ++events > 1000) {
              truncated = true;
              const note: NotebookOutput = { type: "stream", name: "stderr", text: "\n[Odin truncated execution output at 4 MiB or 1000 output events]\n" };
              outputCell!.outputs!.push(asOutput(note)); scheduleFlush();
              bus.emit({ type: "notebook.output", kernelId: id, executionId, cellId, output: note }); return;
            }
            bytes += size;
            const targetCell = outputCell!;
            if (clearOnNextOutput) { targetCell.outputs = []; clearOnNextOutput = false; }
            const transient = content.transient as { display_id?: string } | undefined;
            const persisted = asOutput(output);
            if (transient?.display_id) persisted.metadata = { ...(output.type === "display" ? output.metadata : {}), odin_display_id: transient.display_id };
            const existing = raw.type === "update_display_data" && transient?.display_id ? targetCell.outputs!.findIndex(value => (value.metadata as { odin_display_id?: string } | undefined)?.odin_display_id === transient.display_id) : -1;
            if (existing !== -1) targetCell.outputs![existing] = persisted;
            else {
              const last = targetCell.outputs!.at(-1);
              if (output.type === "stream" && last?.output_type === "stream" && last.name === output.name) last.text = text(last.text) + output.text;
              else targetCell.outputs!.push(persisted);
            }
            scheduleFlush();
            bus.emit({ type: "notebook.output", kernelId: id, executionId, cellId, output });
          });
          flush(); if (flushError) throw flushError;
          executionState(executionId, interrupted.has(executionId) ? "interrupted" : "completed");
          state(id, "idle");
        } catch (error) {
          try { flush(); } catch { /* Keep the failed receipt even when an external file edit prevents output persistence. */ }
          const message = scrub(error instanceof Error ? error.message : "notebook execution failed").slice(0, 2048);
          executionState(executionId, interrupted.has(executionId) || closed ? "interrupted" : "failed", message);
          state(id, nativeIds.has(id) ? "idle" : "failed", message);
        } finally {
          if (outputTimer) clearTimeout(outputTimer);
          interrupted.delete(executionId); publish(id);
          notify(id, `Notebook ${row(id).name}: cell ${cellId} ${execution(executionId).state}.`);
        }
      });
      chains.set(id, job); jobs.set(executionId, job);
      const cleanup = () => { jobs.delete(executionId); if (chains.get(id) === job) { chains.delete(id); armIdle(id); } };
      void job.then(cleanup, cleanup);
      return execution(executionId);
    },
    execution,
    async wait(id, timeoutMs = 1000) {
      const value = execution(id);
      if (terminal(value)) return value;
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 10000) throw new HttpError(400, "wait must be between 0 and 10000 milliseconds");
      const job = jobs.get(id);
      if (job && timeoutMs) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([job, new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); })]); }
        finally { if (timer) clearTimeout(timer); }
      }
      return execution(id);
    },
    async interrupt(id) {
      row(id);
      const active = db.prepare("SELECT id FROM notebook_executions WHERE kernel_id = ? AND state IN ('queued','running')").all(id) as { id: string }[];
      for (const value of active) interrupted.add(value.id);
      const nativeId = nativeIds.get(id); if (nativeId) await runtime(id).interrupt(nativeId);
    },
    async stop(id) {
      available(id); transitions.add(id);
      try { await stopKernel(id); } finally { transitions.delete(id); }
    },
    async remove(id) {
      available(id); transitions.add(id);
      try {
        await stopKernel(id);
        const project = row(id).project;
        const path = storage.path(id);
        try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        db.prepare("DELETE FROM notebook_kernels WHERE id = ?").run(id);
        bus.emit({ type: "project.updated", project });
      } finally { transitions.delete(id); }
    },
    async exportToProject(id, path) {
      const value = row(id), project = services.projects.get(value.project);
      if (!project) throw new HttpError(404, "unknown project");
      if (typeof path !== "string" || !path.endsWith(".ipynb") || path.includes("\0") || path.includes(":") || isAbsolute(path) || path.startsWith("\\")) throw new HttpError(400, "choose a relative .ipynb path");
      const parts = path.replaceAll("\\", "/").split("/");
      if (parts.some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git" || /[. ]$/.test(part))) throw new HttpError(400, "invalid notebook export path");
      let target = realpathSync(project.path);
      for (const part of parts.slice(0, -1)) {
        target = join(target, part);
        const entry = lstatSync(target);
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw new HttpError(403, "export directory must be a regular project directory");
      }
      target = join(target, parts.at(-1)!);
      const document = storage.read(id).document;
      try { writeFileSync(target, JSON.stringify(document, null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new HttpError(409, "export already exists; choose another path"); throw error; }
      services.projects.noteWritten(value.project, [parts.join("/")]);
      return { path: parts.join("/") };
    },
    async variables(id): Promise<NotebookVariable[]> {
      return await inspect(id, `result = []\npd = sys.modules.get('pandas')\nfor name, value in list(globals().items()):\n if name.startswith('_') or name in ('In', 'Out', 'get_ipython', 'exit', 'quit'): continue\n kind = type(value)\n preview = '<' + kind.__name__ + '>'\n shape = None\n if any(word in name.lower() for word in ('secret', 'token', 'password', 'api_key', 'credential')): preview = '[redacted]'\n elif kind in (str, int, float, bool, type(None)): preview = str(clean(value))[:500]\n elif kind in (list, tuple, dict, set): preview = str(len(value)) + ' items'\n elif pd is not None and kind is pd.DataFrame:\n  shape = list(value.shape)\n  preview = str(shape[0]) + ' rows × ' + str(shape[1]) + ' columns'\n item = {'name': name, 'type': kind.__name__, 'preview': preview}\n if shape is not None: item['shape'] = shape\n result.append(item)\n if len(result) >= 1000: break`) as NotebookVariable[];
    },
    async dataframe(id, name, query: DataFrameQuery = {}): Promise<NotebookDataFrame> {
      if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(name)) throw new HttpError(400, "choose a named dataframe variable");
      const offset = query.offset ?? 0, limit = query.limit ?? 50;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200 || (query.sort !== undefined && typeof query.sort !== "string") || (query.descending !== undefined && typeof query.descending !== "boolean")) throw new HttpError(400, "invalid dataframe page");
      return await inspect(id, `pd = sys.modules.get('pandas')\nvalue = globals().get(${JSON.stringify(name)})\nif pd is None or type(value) is not pd.DataFrame: raise ValueError('choose a pandas DataFrame')\nif value.shape[1] > 200: raise ValueError('dataframe has too many columns')\nframe = value\nsort = ${query.sort === undefined ? "None" : JSON.stringify(query.sort)}\nif sort is not None:\n if sort not in frame.columns: raise ValueError('unknown sort column')\n frame = frame.sort_values(sort, ascending=${query.descending ? "False" : "True"}, kind='stable')\nrows = [[clean(item) for item in row] for row in frame.iloc[${offset}:${offset + limit}].itertuples(index=False, name=None)]\nresult = {'columns': [{'name': str(name), 'type': str(dtype)} for name, dtype in zip(frame.columns, frame.dtypes)], 'rows': rows, 'total': len(frame), 'offset': ${offset}, 'limit': ${limit}}`) as NotebookDataFrame;
    },
    async handoff(id) {
      available(id);
      if (chains.has(id) || row(id).state === "busy") throw new HttpError(409, "wait for notebook executions before hand-off");
      const value = row(id);
      if (db.prepare("SELECT id FROM notebook_kernels WHERE project = ? AND location = ? AND editor = 'jupyterlab'").get(value.project, value.location)) throw new HttpError(409, "return the other notebook from JupyterLab first");
      transitions.add(id);
      db.prepare("UPDATE notebook_kernels SET editor = 'jupyterlab' WHERE id = ?").run(id);
      try {
        const { host, nativeId } = await ensureStarted(id);
        if (!host.openLab) throw new HttpError(501, "JupyterLab hand-off is unavailable");
        const result = await host.openLab({ notebookPath: `${id}.ipynb`, kernelId: nativeId });
        clearIdle(id); state(id, "idle");
        notify(id, `Notebook ${value.name} is open in JupyterLab; Odin editing and running are paused.`); publish(id);
        return result;
      } catch (error) { db.prepare("UPDATE notebook_kernels SET editor = 'odin' WHERE id = ?").run(id); throw error; }
      finally { transitions.delete(id); }
    },
    async reclaim(id) {
      if (transitions.has(id)) throw new HttpError(409, "a notebook lifecycle operation is in progress");
      const value = row(id);
      transitions.add(id);
      try {
        if (value.editor === "jupyterlab") await runtime(id).closeLab?.();
        db.prepare("UPDATE notebook_kernels SET editor = 'odin' WHERE id = ?").run(id);
        const snapshot = service.snapshot(id);
        notify(id, `Notebook ${value.name} returned from JupyterLab. Reload its latest cells before editing.`); publish(id); armIdle(id);
        return snapshot;
      } finally { transitions.delete(id); }
    },
    widgetState(id) { row(id); return structuredClone([...(widgetModels.get(id)?.values() ?? [])]); },
    async sendComm(id, message) {
      available(id);
      if (chains.has(id) || row(id).state === "busy") throw new HttpError(409, "wait for kernel execution before sending widget messages");
      if (!validComm(message) || message.type === "comm_open" || !widgetModels.get(id)?.has(message.commId)) throw new HttpError(400, "invalid or unknown widget model");
      const host = runtime(id), nativeId = nativeIds.get(id);
      if (!nativeId || !host.sendComm) throw new HttpError(409, "widget kernel is stopped");
      await host.sendComm(nativeId, message); armIdle(id);
    },
    hostTools(sessionId) {
      const requireKernel = (input: Record<string, unknown>) => {
        const id = text(input.kernel_id); validateSession(sessionId, id); service.attach(sessionId, id); return id;
      };
      const result = (value: unknown): HostToolResult => ({ text: JSON.stringify(value) });
      const executionResult = (value: NotebookExecution): HostToolResult => {
        const cell = service.snapshot(value.kernelId).cells.find(cell => cell.id === value.cellId);
        const parts: string[] = [JSON.stringify(value)];
        const images: NonNullable<HostToolResult["content"]> = [];
        let imageBytes = 0;
        for (const output of cell?.outputs ?? []) {
          if (output.type === "stream") parts.push(output.text);
          else if (output.type === "error") parts.push(`${output.name}: ${output.message}\n${output.traceback.join("\n")}`);
          else {
            if (output.data["text/plain"] !== undefined) parts.push(mimeText(output.data["text/plain"]));
            for (const mimeType of ["image/png", "image/jpeg"] as const) {
              const data = output.data[mimeType];
              if (typeof data === "string" && images.length < 4 && imageBytes + data.length < 4 * 1024 * 1024) { images.push({ type: "image", mimeType, data }); imageBytes += data.length; }
            }
          }
        }
        const preview = scrub(parts.join("\n")).slice(0, 16000);
        return { text: preview, ...(images.length ? { content: [{ type: "text", text: preview }, ...images] } : {}) };
      };
      const kernelParam = { kernel_id: { type: "string" as const, description: "Odin kernel ID" } };
      const tools: HostTool[] = [
        { name: "notebook_list", description: "List named Python kernels in this session's project, with their actual cwd and environment.", params: {}, async handler() { const s = services.sessions.get(sessionId); if (!s?.project) throw new HttpError(400, "session has no project"); return result(service.list(s.project)); } },
        { name: "notebook_create", effect: "execute", description: "Create and attach a named Python notebook kernel. Does not install packages.", params: { name: { type: "string", description: "Unique project kernel name" }, interpreter: { type: "string", description: "Python interpreter path", optional: true }, distro: { type: "string", description: "WSL distribution; required for WSL sessions unless the cwd identifies it", optional: true } }, async handler(input) {
          const s = services.sessions.get(sessionId); if (!s?.project) throw new HttpError(400, "session has no project");
          const distro = input.distro === undefined ? /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\/i.exec(s.cwd)?.[1] : text(input.distro);
          if (s.harness === "codex-wsl" && !distro) throw new HttpError(400, "specify this session's WSL distribution");
          const k = await service.create(s.project, { name: text(input.name), cwd: s.cwd, interpreter: input.interpreter === undefined ? undefined : text(input.interpreter), ...(distro ? { location: { kind: "wsl" as const, distro } } : {}) }); service.attach(sessionId, k.id); return result(k);
        } },
        { name: "notebook_read", description: "Read notebook cells and bounded outputs; use offset/limit for paging.", params: { ...kernelParam, offset: { type: "number", description: "Cell offset", optional: true }, limit: { type: "number", description: "Cell count, up to 50", optional: true } }, async handler(input) { const snapshot = service.snapshot(requireKernel(input)); const offset = Math.max(0, Math.floor(Number(input.offset) || 0)); const cells = snapshot.cells.slice(offset, offset + Math.min(50, Math.max(1, Number(input.limit) || 10))); let preview = JSON.stringify({ ...snapshot, cells }); if (preview.length > 64000) preview = preview.slice(0, 64000) + "\n[Truncated; request fewer cells]"; return { text: preview }; } },
        { name: "notebook_output", description: "Page through a cell's persisted text/error output. Up to 16000 characters per page; raster plots accompany the first page.", params: { ...kernelParam, cell_id: { type: "string", description: "Cell ID" }, offset: { type: "number", description: "Character offset", optional: true }, limit: { type: "number", description: "Character count, at most 16000", optional: true } }, async handler(input) {
          const id = requireKernel(input), cell = service.snapshot(id).cells.find(value => value.id === input.cell_id);
          if (!cell) throw new HttpError(404, "unknown cell");
          const offset = input.offset === undefined ? 0 : Number(input.offset), limit = input.limit === undefined ? 16000 : Number(input.limit);
          if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 16000) throw new HttpError(400, "invalid output page");
          const flattened = scrub(cell.outputs.map(output => output.type === "stream" ? output.text : output.type === "error" ? `${output.name}: ${output.message}\n${output.traceback.join("\n")}` : Array.isArray(output.data["text/plain"]) ? output.data["text/plain"].join("") : text(output.data["text/plain"])).join("\n"));
          const summary = JSON.stringify({ kernelId: id, cellId: cell.id, offset, total: flattened.length, hasMore: offset + limit < flattened.length, text: flattened.slice(offset, offset + limit) });
          const content: NonNullable<HostToolResult["content"]> = [{ type: "text", text: summary }]; let imageBytes = 0;
          if (!offset) for (const output of cell.outputs) if (output.type === "display") for (const mimeType of ["image/png", "image/jpeg"] as const) {
            const data = output.data[mimeType]; if (typeof data === "string" && content.length <= 4 && imageBytes + data.length < 4 * 1024 * 1024) { content.push({ type: "image", mimeType, data }); imageBytes += data.length; }
          }
          return { text: summary, ...(content.length > 1 ? { content } : {}) };
        } },
        { name: "notebook_execute", effect: "execute", description: "Execute Python in shared kernel state. Returns quickly with an execution handle; wait/status tools track long cells.", params: { ...kernelParam, revision: { type: "string", description: "Current notebook revision" }, source: { type: "string", description: "Python source" }, cell_id: { type: "string", description: "Existing code cell ID; omit to append", optional: true } }, async handler(input) { const value = await service.execute(requireKernel(input), { revision: text(input.revision), source: text(input.source), cellId: input.cell_id === undefined ? undefined : text(input.cell_id), sessionId }); return executionResult(await service.wait(value.id, 1000)); } },
        { name: "notebook_edit", effect: "edit", description: "Edit a notebook cell using the current revision. Outputs clear when source changes.", params: { ...kernelParam, revision: { type: "string", description: "Current revision" }, cell_id: { type: "string", description: "Cell ID" }, source: { type: "string", description: "Replacement source" } }, async handler(input) { const id = requireKernel(input), snapshot = service.snapshot(id), target = snapshot.cells.find(cell => cell.id === input.cell_id); if (!target) throw new HttpError(404, "unknown cell"); target.source = text(input.source); return result(service.save(id, text(input.revision), snapshot.cells, sessionId)); } },
        { name: "notebook_status", description: "Get a notebook execution's status, output preview and plot images.", params: { execution_id: { type: "string", description: "Execution handle" } }, async handler(input) { const value = execution(text(input.execution_id)); validateSession(sessionId, value.kernelId); return executionResult(value); } },
        { name: "notebook_wait", description: "Wait up to ten seconds for an execution. Safe to call repeatedly.", params: { execution_id: { type: "string", description: "Execution handle" }, timeout_ms: { type: "number", description: "Wait milliseconds, at most 10000", optional: true } }, async handler(input) { const value = execution(text(input.execution_id)); validateSession(sessionId, value.kernelId); return executionResult(await service.wait(value.id, input.timeout_ms === undefined ? 1000 : Number(input.timeout_ms))); } },
        { name: "notebook_interrupt", effect: "execute", description: "Interrupt running Python and cancel queued executions for this shared kernel.", params: kernelParam, async handler(input) { await service.interrupt(requireKernel(input)); return { text: "Interrupt requested" }; } },
        { name: "notebook_variables", effect: "execute", description: "Inspect bounded Python variable names, types, previews and dataframe shapes.", params: kernelParam, async handler(input) { return result(await service.variables(requireKernel(input))); } },
        { name: "notebook_dataframe", effect: "execute", description: "Read a bounded, sortable page from a named pandas DataFrame.", params: { ...kernelParam, name: { type: "string", description: "Dataframe variable name" }, offset: { type: "number", description: "Row offset", optional: true }, limit: { type: "number", description: "Row count, up to 200", optional: true }, sort: { type: "string", description: "Sort column name", optional: true }, descending: { type: "boolean", description: "Descending sort", optional: true } }, async handler(input) { return result(await service.dataframe(requireKernel(input), text(input.name), { offset: input.offset === undefined ? undefined : Number(input.offset), limit: input.limit === undefined ? undefined : Number(input.limit), sort: input.sort === undefined ? undefined : text(input.sort), descending: input.descending === undefined ? undefined : input.descending === true })); } },
      ];
      return tools;
    },
    notices(sessionId) { return (db.prepare("SELECT * FROM notebook_notices WHERE session_id = ? ORDER BY created_at, id").all(sessionId) as { id: string; session_id: string; kernel_id: string; text: string; created_at: string }[]).map(value => ({ id: value.id, sessionId: value.session_id, kernelId: value.kernel_id, text: value.text, createdAt: value.created_at } satisfies NotebookNotice)); },
    acknowledgeNotices(sessionId, ids) { for (const id of ids) db.prepare("DELETE FROM notebook_notices WHERE id = ? AND session_id = ?").run(id, sessionId); },
    usesPath(path) {
      return (db.prepare("SELECT cwd FROM notebook_kernels").all() as { cwd: string }[]).some(value => { const part = relative(resolve(path), resolve(value.cwd)); return !part || (!part.startsWith(`..${sep}`) && part !== ".." && !isAbsolute(part)); });
    },
    async close() {
      closed = true;
      for (const id of idleTimers.keys()) clearIdle(id);
      for (const value of db.prepare("SELECT id FROM notebook_executions WHERE state IN ('queued','running')").all() as { id: string }[]) interrupted.add(value.id);
      await Promise.allSettled([...hosts.values()].map(host => host.close()));
      await Promise.allSettled([...jobs.values()]);
      await Promise.allSettled([...chains.values()]);
      db.prepare("UPDATE notebook_kernels SET state = 'stopped'").run(); nativeIds.clear();
      for (const unsubscribe of commSubscriptions.values()) unsubscribe(); commSubscriptions.clear(); widgetModels.clear();
    },
  };
  return service;
}
