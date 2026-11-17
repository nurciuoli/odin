import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import type { KernelLocation, NotebookComm } from "@odin/shared/notebooks";
export type { NotebookComm } from "@odin/shared/notebooks";
import { managedNotebookPython, notebookChildEnv, notebookCommand, notebookWslPath } from "./environment.ts";

export interface JupyterOutput extends Record<string, unknown> {
  type: "stream" | "display_data" | "execute_result" | "error" | "clear_output" | "update_display_data";
  content: Record<string, unknown>;
}
export interface NotebookRuntime {
  start(): Promise<void>;
  createKernel(options: { id: string; cwd: string; interpreter: string }): Promise<string>;
  execute(kernelId: string, code: string, onOutput: (output: JupyterOutput) => void): Promise<void>;
  interrupt(kernelId: string): Promise<void>;
  stop(kernelId: string): Promise<void>;
  close(): Promise<void>;
  subscribeComms(kernelId: string, listener: (message: NotebookComm) => void): () => void;
  sendComm(kernelId: string, message: NotebookComm): Promise<void>;
}
export interface NotebookSocket {
  readyState: number;
  binaryType?: string;
  send(data: string | Uint8Array): void;
  close(): void;
  addEventListener(type: string, listener: (event: any) => void, options?: { once?: boolean }): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
}
export interface NotebookRuntimeOptions {
  home: string;
  project: string;
  location: KernelLocation;
  hostPython?: string;
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  fetch?: typeof fetch;
  webSocket?: (url: string) => NotebookSocket;
  port?: number;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxMessageBytes?: number;
  /** Native kernel IDs invalidated by host shutdown/crash/idle; never automatically replay cells. */
  onStopped?: (kernelIds: string[]) => void;
  onStatus?: (kernelId: string, state: "busy" | "idle") => void;
}
const OUTPUT_TYPES = new Set(["stream", "display_data", "execute_result", "error", "clear_output", "update_display_data"]);
const COMM_TYPES = new Set(["comm_open", "comm_msg", "comm_close"]);
/** Default Jupyter WebSocket protocol: big-endian offset table followed by JSON and raw buffers. */
export function encodeKernelMessage(message: Record<string, unknown>, buffers: string[] = [], limit = 8 * 1024 * 1024): string | Uint8Array {
  const json = JSON.stringify(message);
  if (!buffers.length) { if (Buffer.byteLength(json) > limit) throw new Error("Notebook message is too large"); return json; }
  if (buffers.length > 128 || buffers.some(value => typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))) throw new Error("Invalid notebook binary buffers");
  const parts = [Buffer.from(json), ...buffers.map(value => Buffer.from(value, "base64"))];
  const headerBytes = 4 * (parts.length + 1);
  const total = headerBytes + parts.reduce((sum, part) => sum + part.length, 0);
  if (total > limit) throw new Error("Notebook message is too large");
  const wire = Buffer.allocUnsafe(total); wire.writeUInt32BE(parts.length, 0);
  let offset = headerBytes;
  parts.forEach((part, index) => { wire.writeUInt32BE(offset, 4 * (index + 1)); part.copy(wire, offset); offset += part.length; });
  return wire;
}
export function decodeKernelMessage(data: unknown, limit = 8 * 1024 * 1024): Record<string, any> {
  if (typeof data === "string") {
    if (Buffer.byteLength(data) > limit) throw new Error("Notebook message is too large");
    const message = JSON.parse(data);
    if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("Invalid notebook message");
    return message;
  }
  const raw = data instanceof ArrayBuffer ? Buffer.from(data) : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : null;
  if (!raw || raw.length < 8 || raw.length > limit) throw new Error("Invalid notebook binary message");
  const count = raw.readUInt32BE(0);
  if (count < 1 || count > 129 || (count + 1) * 4 > raw.length) throw new Error("Invalid notebook offset table");
  const offsets = Array.from({ length: count }, (_, index) => raw.readUInt32BE(4 * (index + 1)));
  if (offsets[0] !== (count + 1) * 4 || offsets.some((offset, index) => offset > raw.length || (index > 0 && offset < offsets[index - 1]!))) throw new Error("Invalid notebook offsets");
  const message = JSON.parse(raw.subarray(offsets[0], offsets[1] ?? raw.length).toString("utf8"));
  if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("Invalid notebook message");
  message.buffers = offsets.slice(1).map((offset, index) => raw.subarray(offset, offsets[index + 2] ?? raw.length).toString("base64"));
  return message;
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function freePort(): Promise<number> {
  const server = createNetServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { server.close(); reject(new Error("Could not allocate notebook port")); return; }
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

/** One private server per project and execution location; kernels retain their own cwd/interpreter. */
export function createNotebookRuntime(options: NotebookRuntimeOptions): NotebookRuntime {
  const token = randomBytes(32).toString("hex");
  const key = createHash("sha256").update(JSON.stringify([options.project, options.location])).digest("hex").slice(0, 20);
  const directory = join(options.home, "jupyter-runtime", `${key}-${randomUUID()}`);
  const specDirectory = join(directory, "kernels");
  const notebookRoot = join(options.home, "notebooks");
  const configPath = join(directory, "server.json");
  const executeFetch = options.fetch ?? fetch;
  const executeSpawn = options.spawn ?? spawn;
  const socketFactory = options.webSocket ?? (url => new WebSocket(url));
  const nativePath = (path: string) => options.location.kind === "wsl" ? notebookWslPath(path) : path;
  let child: ChildProcess | null = null;
  let base = "";
  let closed = false;
  let starting: Promise<void> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const kernels = new Set<string>();
  const sockets = new Map<string, { socket: NotebookSocket; reject: (error: Error) => void }>();
  const comms = new Map<string, { socket: NotebookSocket; listeners: Set<(message: NotebookComm) => void>; ready: Promise<void>; sessionId: string }>();
  const commWaits = new Map<string, { kernelId: string; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  function rejectCommWaits(kernelId?: string) {
    for (const [id, pending] of commWaits) if (!kernelId || pending.kernelId === kernelId) {
      clearTimeout(pending.timer); pending.reject(new Error("Notebook widget channel closed")); commWaits.delete(id);
    }
  }
  function clearIdle() { if (idleTimer) clearTimeout(idleTimer); idleTimer = null; }
  function armIdle() {
    clearIdle();
    if (!closed && sockets.size === 0 && (options.idleTimeoutMs ?? 3_600_000) > 0) {
      idleTimer = setTimeout(() => {
        // Kernels may be executing outside Odin-tracked sockets.
        void request("/api/kernels").then((active: unknown) => {
          if (Array.isArray(active) && active.some(kernel => kernel?.execution_state === "busy")) armIdle();
          else void shutdown();
        }, () => { void shutdown(); });
      }, options.idleTimeoutMs ?? 3_600_000);
      idleTimer.unref?.();
    }
  }
  async function request(path: string, init: RequestInit = {}): Promise<any> {
    if (!base || !child) throw new Error("Notebook host is not running");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.requestTimeoutMs ?? 10_000);
    try {
      const response = await executeFetch(base + path, {
        ...init, signal: controller.signal,
        headers: { "content-type": "application/json", authorization: `token ${token}`, ...init.headers },
      });
      if (!response.ok) throw new Error("Notebook host rejected request");
      if (response.status === 204) return undefined;
      return await response.json();
    } catch { throw new Error("Notebook host request failed"); }
    finally { clearTimeout(timer); }
  }
  async function start() {
    if (closed) throw new Error("Notebook runtime is closed");
    if (starting) return starting;
    if (child) return;
    starting = (async () => {
      mkdirSync(specDirectory, { recursive: true, mode: 0o700 });
      mkdirSync(notebookRoot, { recursive: true, mode: 0o700 });
      const port = options.port ?? await freePort();
      base = `http://127.0.0.1:${port}`;
      writeFileSync(configPath, JSON.stringify({
        IdentityProvider: { token },
        ServerApp: {
          ip: "127.0.0.1", port, port_retries: 0, open_browser: false, allow_root: true,
          root_dir: nativePath(notebookRoot), runtime_dir: nativePath(directory),
          show_banner: false, log_level: "CRITICAL",
        },
        KernelSpecManager: { kernel_dirs: [nativePath(specDirectory)], ensure_native_kernel: false },
      }), { mode: 0o600 });
      const python = options.hostPython ?? managedNotebookPython(options.home, options.location);
      // Jupyter connection files require real POSIX mode 0600. DrvFS mounts may report 0777
      // even after chmod, so WSL uses a private Linux temporary runtime directory.
      const wslBootstrap = "import os,runpy,shutil,sys,tempfile\n" +
        "directory=tempfile.mkdtemp(prefix='odin-jupyter-')\nos.chmod(directory,0o700)\n" +
        // KernelSpecManager.kernel_dirs is not configurable; Jupyter finds specs under JUPYTER_PATH/<dir>/kernels.
        "os.environ['JUPYTER_PATH']=os.path.dirname(os.path.abspath(sys.argv[1]))\n" +
        "sys.argv=['jupyter_server','--config',sys.argv[1],'--ServerApp.runtime_dir='+directory]\n" +
        "try:\n runpy.run_module('jupyter_server',run_name='__main__')\nfinally:\n shutil.rmtree(directory,ignore_errors=True)\n";
      const args = options.location.kind === "wsl" ? ["-c", wslBootstrap, nativePath(configPath)] : ["-m", "jupyter_server", "--config", nativePath(configPath)];
      const spec = notebookCommand(options.location, python, args);
      const proc = executeSpawn(spec.command, spec.args, {
        env: { ...notebookChildEnv(), JUPYTER_PATH: directory }, windowsHide: true, stdio: ["ignore", "ignore", "ignore"],
      });
      child = proc;
      let exited = false;
      const onExit = () => {
        exited = true;
        if (child !== proc) return;
        child = null;
        for (const pending of sockets.values()) pending.reject(new Error("Notebook host exited"));
        sockets.clear();
        for (const connection of comms.values()) connection.socket.close();
        comms.clear();
        rejectCommWaits();
        const stopped = [...kernels]; kernels.clear(); clearIdle();
        if (stopped.length) options.onStopped?.(stopped);
      };
      proc.once("error", onExit); proc.once("exit", onExit);
      const deadline = Date.now() + (options.startupTimeoutMs ?? 30_000);
      while (!exited && !closed && Date.now() < deadline) {
        try { await request("/api/kernels"); armIdle(); return; } catch { await delay(100); }
      }
      proc.kill();
      if (child === proc) child = null;
      throw new Error("Notebook host did not start; set up the managed Jupyter environment first");
    })();
    try { await starting; } finally { starting = null; }
  }
  async function shutdown() {
    clearIdle();
    for (const pending of [...sockets.values()]) pending.reject(new Error("Notebook runtime stopped"));
    sockets.clear();
    for (const comm of comms.values()) comm.socket.close();
    comms.clear();
    rejectCommWaits();
    const proc = child;
    if (proc) {
      try { await request("/api/shutdown", { method: "POST", body: "{}" }); } catch { /* Force stop below. */ }
      if (child === proc) {
        proc.kill();
        await Promise.race([new Promise<void>(resolve => proc.once("exit", () => resolve())), delay(2000)]);
        if (child === proc) { proc.kill("SIGKILL"); child = null; }
      }
    }
    const stopped = [...kernels]; kernels.clear();
    if (stopped.length) options.onStopped?.(stopped);
  }
  return {
    start,
    subscribeComms(kernelId, listener) {
      if (!kernels.has(kernelId)) throw new Error("Notebook kernel is stopped");
      let connection = comms.get(kernelId);
      if (!connection) {
        const sessionId = randomUUID();
        const socket = socketFactory(`${base.replace(/^http/, "ws")}/api/kernels/${encodeURIComponent(kernelId)}/channels?session_id=${sessionId}&token=${token}`);
        socket.binaryType = "arraybuffer";
        const listeners = new Set<(message: NotebookComm) => void>();
        let rejectOpen: (error: Error) => void = () => {};
        const ready = new Promise<void>((resolve, reject) => {
          rejectOpen = reject;
          if (socket.readyState === 1) { resolve(); return; }
          const timer = setTimeout(() => { reject(new Error("Notebook widget connection timed out")); socket.close(); }, options.requestTimeoutMs ?? 10_000);
          socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
          socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Notebook widget connection failed")); }, { once: true });
          socket.addEventListener("close", () => { clearTimeout(timer); reject(new Error("Notebook widget connection closed")); }, { once: true });
        });
        void ready.catch(() => {});
        connection = { socket, listeners, ready, sessionId };
        comms.set(kernelId, connection);
        socket.addEventListener("message", event => {
          try {
            const wire = decodeKernelMessage(event.data, options.maxMessageBytes);
            const type = wire.header?.msg_type ?? wire.msg_type;
            if (type === "status" && (wire.content?.execution_state === "busy" || wire.content?.execution_state === "idle")) {
              const state = wire.content.execution_state;
              try { options.onStatus?.(kernelId, state); } catch { /* A closed service cannot break the channel. */ }
              if (state === "busy") clearIdle(); else armIdle();
              const parentId = wire.parent_header?.msg_id;
              const pending = commWaits.get(parentId);
              if (state === "idle" && pending?.kernelId === kernelId) {
                clearTimeout(pending.timer); commWaits.delete(parentId); pending.resolve();
              }
            }
            if (!COMM_TYPES.has(type) || !wire.content || typeof wire.content !== "object") return;
            if (typeof wire.content.comm_id !== "string") return;
            const message: NotebookComm = { type, commId: wire.content.comm_id, targetName: wire.content.target_name, data: wire.content.data ?? {}, buffers: wire.buffers ?? [], ...("metadata" in wire ? { metadata: wire.metadata } : {}) };
            for (const subscriber of listeners) { try { subscriber(message); } catch { /* A disconnected consumer cannot break other subscribers. */ } }
          } catch { socket.close(); }
        });
        socket.addEventListener("close", () => { rejectOpen(new Error("Notebook widget connection closed")); rejectCommWaits(kernelId); if (comms.get(kernelId)?.socket === socket) comms.delete(kernelId); });
      }
      connection.listeners.add(listener);
      const captured = connection;
      return () => {
        captured.listeners.delete(listener);
        if (!captured.listeners.size) { captured.socket.close(); if (comms.get(kernelId) === captured) comms.delete(kernelId); }
      };
    },
    async sendComm(kernelId, message) {
      if (!COMM_TYPES.has(message?.type) || !message.data || typeof message.data !== "object" || Array.isArray(message.data) || typeof message.commId !== "string" || message.commId.length > 200) throw new Error("Invalid notebook widget message");
      const connection = comms.get(kernelId);
      if (!connection || !kernels.has(kernelId)) throw new Error("Notebook widget channel is not connected");
      if (commWaits.size >= 128 || [...commWaits.values()].filter(value => value.kernelId === kernelId).length >= 32) throw new Error("Too many pending notebook widget callbacks");
      await connection.ready;
      if (connection.socket.readyState !== 1) throw new Error("Notebook widget channel is not connected");
      const wire = {
        header: { msg_id: randomUUID(), username: "odin", session: connection.sessionId, msg_type: message.type, version: "5.3", date: new Date().toISOString() },
        parent_header: {}, metadata: (message as NotebookComm & { metadata?: Record<string, unknown> }).metadata ?? {}, channel: "shell", content: { comm_id: message.commId, data: message.data, ...(message.targetName ? { target_name: message.targetName } : {}) },
      };
      const encoded = encodeKernelMessage(wire, message.buffers, options.maxMessageBytes);
      await new Promise<void>((resolve, reject) => {
        const id = wire.header.msg_id;
        const timer = setTimeout(() => {
          commWaits.delete(id);
          reject(new Error("Widget callback is still running; wait for the kernel to become idle"));
        }, options.requestTimeoutMs ?? 10_000);
        commWaits.set(id, { kernelId, resolve, reject, timer });
        try { connection.socket.send(encoded); }
        catch { clearTimeout(timer); commWaits.delete(id); reject(new Error("Notebook widget send failed")); }
      });
    },
    async createKernel({ id, cwd, interpreter }) {
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || !interpreter || !cwd) throw new Error("Invalid notebook kernel configuration");
      await start();
      const name = `odin-${id}`;
      const root = join(specDirectory, name);
      mkdirSync(root, { recursive: true, mode: 0o700 });
      // cwd is immutable and independent of Jupyter's contents root, including Windows drives.
      const code = `import os,runpy;os.chdir(${JSON.stringify(nativePath(cwd))});runpy.run_module('ipykernel_launcher',run_name='__main__')`;
      writeFileSync(join(root, "kernel.json"), JSON.stringify({
        argv: [interpreter, "-c", code, "-f", "{connection_file}"], display_name: name, language: "python",
      }), { mode: 0o600 });
      const result = await request("/api/kernels", { method: "POST", body: JSON.stringify({ name }) });
      if (!result || typeof result.id !== "string") throw new Error("Notebook host returned an invalid kernel");
      kernels.add(result.id); armIdle(); return result.id;
    },
    async execute(kernelId, code, onOutput) {
      if (!kernels.has(kernelId)) throw new Error("Notebook kernel is stopped");
      if (sockets.has(kernelId)) throw new Error("Notebook kernel is already executing");
      const comm = comms.get(kernelId);
      if (comm) {
        await comm.ready;
        if (!kernels.has(kernelId)) throw new Error("Notebook kernel is stopped");
        if (sockets.has(kernelId)) throw new Error("Notebook kernel is already executing");
      }
      clearIdle();
      const messageId = randomUUID();
      const sessionId = randomUUID();
      const url = `${base.replace(/^http/, "ws")}/api/kernels/${encodeURIComponent(kernelId)}/channels?session_id=${sessionId}&token=${token}`;
      let socket: NotebookSocket;
      try { socket = socketFactory(url); } catch { armIdle(); throw new Error("Could not connect to notebook kernel"); }
      socket.binaryType = "arraybuffer";
      await new Promise<void>((resolve, reject) => {
        let idle = false, reply = false, finished = false, executionError = false;
        const openTimer = setTimeout(() => finish(new Error("Notebook kernel connection timed out")), options.requestTimeoutMs ?? 10_000);
        const finish = (error?: Error) => {
          if (finished) return;
          finished = true; clearTimeout(openTimer);
          socket.removeEventListener("open", onOpen); socket.removeEventListener("message", onMessage);
          socket.removeEventListener("error", onError); socket.removeEventListener("close", onClose);
          sockets.delete(kernelId); socket.close(); armIdle();
          if (error) reject(error); else if (executionError) reject(new Error("Python execution failed")); else resolve();
        };
        const onOpen = () => {
          clearTimeout(openTimer);
          try { socket.send(JSON.stringify({
            header: { msg_id: messageId, username: "odin", session: sessionId, msg_type: "execute_request", version: "5.3", date: new Date().toISOString() },
            parent_header: {}, metadata: {}, channel: "shell", buffers: [],
            content: { code, silent: false, store_history: true, user_expressions: {}, allow_stdin: false, stop_on_error: true },
          })); } catch { finish(new Error("Notebook kernel send failed")); }
        };
        const onMessage = (event: { data: unknown }) => {
          let message: any;
          try { message = decodeKernelMessage(event.data, options.maxMessageBytes); } catch { finish(new Error("Invalid notebook protocol message or output exceeded transport limits")); return; }
          if (message.parent_header?.msg_id !== messageId) return;
          const type = message.header?.msg_type ?? message.msg_type;
          if (type === "execute_reply") { reply = true; if (message.content?.status === "error" || message.content?.status === "abort") executionError = true; }
          if (type === "status" && message.content?.execution_state === "idle") idle = true;
          if (OUTPUT_TYPES.has(type)) {
            try { onOutput({ type, content: message.content ?? {} }); }
            catch { finish(new Error("Notebook output could not be stored")); return; }
          }
          if (idle && reply) finish();
        };
        const onError = () => finish(new Error("Notebook kernel connection failed"));
        const onClose = () => finish(new Error("Notebook kernel disconnected before completion"));
        sockets.set(kernelId, { socket, reject: error => finish(error) });
        socket.addEventListener("open", onOpen); socket.addEventListener("message", onMessage);
        socket.addEventListener("error", onError); socket.addEventListener("close", onClose);
        if (socket.readyState === 1) onOpen();
      });
    },
    async interrupt(kernelId) {
      if (!kernels.has(kernelId)) return;
      await request(`/api/kernels/${encodeURIComponent(kernelId)}/interrupt`, { method: "POST", body: "{}" });
    },
    async stop(kernelId) {
      rejectCommWaits(kernelId);
      comms.get(kernelId)?.socket.close(); comms.delete(kernelId);
      sockets.get(kernelId)?.reject(new Error("Notebook kernel stopped"));
      if (!kernels.has(kernelId)) return;
      try { await request(`/api/kernels/${encodeURIComponent(kernelId)}`, { method: "DELETE" }); }
      finally { kernels.delete(kernelId); armIdle(); }
    },
    async close() {
      closed = true;
      if (starting) { try { await starting; } catch { /* Startup failure still needs cleanup. */ } }
      await shutdown();
      // directory is generated beneath the configured home, never a request-derived path.
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
