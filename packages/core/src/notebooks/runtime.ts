import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import type { KernelLocation, NotebookComm } from "@odin/shared/notebooks";
export type { NotebookComm } from "@odin/shared/notebooks";
import { managedNotebookPython, notebookChildEnv, notebookCommand, notebookEnvironmentBootstrap, notebookWslPath, type NotebookProjectEnvironment } from "./environment.ts";

export interface JupyterOutput extends Record<string, unknown> {
  type: "stream" | "display_data" | "execute_result" | "error" | "clear_output" | "update_display_data";
  content: Record<string, unknown>;
}
export interface NotebookRuntime {
  start(): Promise<void>;
  createKernel(options: { id: string; cwd: string; interpreter: string; environment?: NotebookProjectEnvironment }): Promise<string>;
  execute(kernelId: string, code: string, onOutput: (output: JupyterOutput) => void): Promise<number | void>;
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
  kernelReadyTimeoutMs?: number;
  /** Native kernel IDs invalidated by host or channel loss; never automatically replay cells. */
  onStopped?: (kernelIds: string[]) => void;
  onStatus?: (kernelId: string, state: "busy" | "idle") => void;
}
const OUTPUT_TYPES = new Set(["stream", "display_data", "execute_result", "error", "clear_output", "update_display_data"]);
const COMM_TYPES = new Set(["comm_open", "comm_msg", "comm_close"]);
type KernelMessage = ReturnType<typeof decodeKernelMessage>;
interface KernelOperation {
  receive(message: KernelMessage, type: string): void;
  fail(error: Error): void;
}
interface KernelChannel {
  socket: NotebookSocket;
  sessionId: string;
  dispose(): void;
  busy: boolean;
  execution?: { watchCompletion(): void; omitOversizedOutput(): void };
  pending: Map<string, KernelOperation>;
  listeners: Set<(message: NotebookComm) => void>;
}
class KernelMessageLimitError extends Error {
  constructor() { super("Notebook message is too large"); }
}
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
    if (Buffer.byteLength(data) > limit) throw new KernelMessageLimitError();
    const message = JSON.parse(data);
    if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("Invalid notebook message");
    return message;
  }
  const raw = data instanceof ArrayBuffer ? Buffer.from(data) : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : null;
  if (raw && raw.length > limit) throw new KernelMessageLimitError();
  if (!raw || raw.length < 8) throw new Error("Invalid notebook binary message");
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
function waitForExit(proc: ChildProcess, timeout: number, terminate?: () => void): Promise<void> {
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); proc.off("exit", finish); resolve(); };
    const timer = setTimeout(finish, timeout);
    proc.once("exit", finish);
    terminate?.();
  });
}
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
  let stopping: Promise<void> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let startingKernels = 0;
  let pendingWidgets = 0;
  const channels = new Map<string, KernelChannel>();
  const requestTimeout = options.requestTimeoutMs ?? 10_000;
  const kernelPath = (id: string) => `/api/kernels/${encodeURIComponent(id)}`;
  function clearIdle() { if (idleTimer) clearTimeout(idleTimer); idleTimer = null; }
  function activeKernel() {
    return startingKernels > 0 || [...channels.values()].some(channel => channel.busy || channel.pending.size > 0);
  }
  function armIdle() {
    clearIdle();
    const proc = child;
    if (proc && !closed && !stopping && !activeKernel() && (options.idleTimeoutMs ?? 3_600_000) > 0) {
      idleTimer = setTimeout(() => {
        if (child === proc && !activeKernel()) void shutdown();
      }, options.idleTimeoutMs ?? 3_600_000);
      idleTimer.unref?.();
    }
  }
  async function request(path: string, init: RequestInit = {}): Promise<any> {
    if (!base || !child) throw new Error("Notebook host is not running");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeout);
    try {
      const failed = () => new Error(controller.signal.aborted ? "Notebook host request timed out" : "Notebook host request failed");
      const response = await executeFetch(base + path, {
        ...init, signal: controller.signal,
        headers: { "content-type": "application/json", authorization: `token ${token}`, ...init.headers },
      }).catch(() => { throw failed(); });
      if (!response.ok) throw new Error(`Notebook host rejected request (HTTP ${response.status})`);
      if (response.status === 204) return undefined;
      return await response.json().catch(() => { throw failed(); });
    }
    finally { clearTimeout(timer); }
  }
  function dropChannel(id: string, error: Error) {
    const channel = channels.get(id);
    if (!channel) return false;
    channels.delete(id);
    for (const operation of channel.pending.values()) operation.fail(error);
    channel.dispose();
    return true;
  }
  function resetChannels(error: Error) {
    const stopped = [...channels.keys()];
    for (const id of stopped) dropChannel(id, error);
    if (stopped.length) options.onStopped?.(stopped);
    clearIdle();
  }
  function invalidateKernel(id: string, error: Error) {
    if (!dropChannel(id, error)) return;
    // A disconnected request may still be running. Shut down that kernel and never replay its code.
    void request(kernelPath(id), { method: "DELETE" }).catch(() => {});
    options.onStopped?.([id]);
    armIdle();
  }
  async function start() {
    if (closed) throw new Error("Notebook runtime is closed");
    if (stopping) await stopping;
    if (closed) throw new Error("Notebook runtime is closed");
    if (starting) return starting;
    if (child) return;
    starting = (async () => {
      mkdirSync(specDirectory, { recursive: true, mode: 0o700 });
      mkdirSync(notebookRoot, { recursive: true, mode: 0o700 });
      const port = options.port ?? await freePort();
      if (closed) throw new Error("Notebook runtime is closed");
      base = `http://127.0.0.1:${port}`;
      writeFileSync(configPath, JSON.stringify({
        IdentityProvider: { token },
        ServerApp: {
          ip: "127.0.0.1", port, port_retries: 0, open_browser: false, allow_root: true,
          root_dir: nativePath(notebookRoot), runtime_dir: nativePath(directory),
          show_banner: false, log_level: "CRITICAL", websocket_ping_interval: 30, websocket_ping_timeout: 30,
        },
        KernelSpecManager: { kernel_dirs: [nativePath(specDirectory)], ensure_native_kernel: false },
      }), { mode: 0o600 });
      const python = options.hostPython ?? managedNotebookPython(options.home, options.location);
      // Jupyter connection files require real POSIX mode 0600. DrvFS mounts may report 0777
      // even after chmod, so WSL uses a private Linux temporary runtime directory.
      const wslBootstrap = "import os,runpy,shutil,sys,tempfile\n" +
        "directory=tempfile.mkdtemp(prefix='odin-jupyter-')\nos.chmod(directory,0o700)\n" +
        "os.environ['JUPYTER_RUNTIME_DIR']=directory\n" +
        // KernelSpecManager.kernel_dirs is not configurable; Jupyter finds specs under JUPYTER_PATH/<dir>/kernels.
        "os.environ['JUPYTER_PATH']=os.path.dirname(os.path.abspath(sys.argv[1]))\n" +
        "sys.argv=['jupyter_server','--config',sys.argv[1],'--ServerApp.runtime_dir='+directory]\n" +
        "try:\n runpy.run_module('jupyter_server',run_name='__main__')\nfinally:\n shutil.rmtree(directory,ignore_errors=True)\n";
      const args = options.location.kind === "wsl" ? ["-c", wslBootstrap, nativePath(configPath)] : ["-m", "jupyter_server", "--config", nativePath(configPath)];
      const spec = notebookCommand(options.location, python, args);
      const proc = executeSpawn(spec.command, spec.args, {
        env: { ...notebookChildEnv(), JUPYTER_PATH: directory, JUPYTER_RUNTIME_DIR: directory },
        windowsHide: true, stdio: ["ignore", "ignore", "ignore"],
      });
      child = proc;
      let exited = false;
      let launchFailed = false;
      const onExit = () => {
        exited = true;
        if (child !== proc) return;
        child = null;
        resetChannels(new Error("Managed Jupyter host exited"));
      };
      proc.once("error", () => { launchFailed = true; onExit(); });
      proc.once("exit", onExit);
      const deadline = Date.now() + (options.startupTimeoutMs ?? 30_000);
      while (!exited && !closed && Date.now() < deadline) {
        try {
          const kernels: unknown = await request("/api/kernels");
          if (child === proc && !closed && Array.isArray(kernels)) { armIdle(); return; }
        } catch { /* A private host may still be starting. */ }
        if (!exited && !closed) await delay(100);
      }
      if (child === proc) { child = null; proc.kill(); }
      if (closed) throw new Error("Notebook runtime is closed");
      if (launchFailed) throw new Error("Managed Jupyter host Python could not be launched");
      if (exited) throw new Error("Managed Jupyter host exited before becoming ready; check its environment");
      throw new Error("Managed Jupyter host readiness timed out");
    })();
    try { await starting; } finally { starting = null; }
  }
  async function shutdown() {
    if (stopping) return stopping;
    stopping = (async () => {
      const proc = child;
      resetChannels(new Error("Notebook runtime stopped"));
      if (!proc) return;
      try {
        await request("/api/shutdown", { method: "POST", body: "{}" });
        if (child === proc) await waitForExit(proc, 2000);
      } catch { /* Force stop below. */ }
      if (child !== proc) return;
      await waitForExit(proc, 2000, () => { proc.kill(); });
      if (child === proc) {
        proc.kill("SIGKILL");
        child = null;
      }
    })();
    try { await stopping; } finally { stopping = null; }
  }
  function kernelMessage(channel: KernelChannel, type: string, content: Record<string, unknown>, metadata: unknown = {}) {
    return {
      header: { msg_id: randomUUID(), username: "odin", session: channel.sessionId, msg_type: type, version: "5.3", date: new Date().toISOString() },
      parent_header: {}, metadata, channel: "shell", content,
    };
  }

  function openChannel(id: string): Promise<void> {
    const sessionId = randomUUID();
    const url = base.replace(/^http/, "ws") + kernelPath(id) + "/channels?session_id=" + sessionId + "&token=" + token;
    let socket: NotebookSocket;
    try { socket = socketFactory(url); }
    catch { throw new Error("Could not connect to notebook kernel"); }
    socket.binaryType = "arraybuffer";

    const channel: KernelChannel = {
      socket, sessionId, busy: false, pending: new Map(), listeners: new Set(),
      dispose() {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
        socket.close();
      },
    };
    channels.set(id, channel);

    let ready = false;
    let reportedStatus: "busy" | "idle" = "idle";
    function onMessage(event: { data: unknown }) {
      let message: KernelMessage;
      try { message = decodeKernelMessage(event.data, options.maxMessageBytes); }
      catch (error) {
        if (error instanceof KernelMessageLimitError) channel.execution?.omitOversizedOutput();
        else invalidateKernel(id, new Error("Invalid notebook protocol message"));
        return;
      }
      const type: string = message.header?.msg_type ?? message.msg_type;
      const status = type === "status" && message.channel === "iopub" ? message.content?.execution_state : undefined;
      if (status === "dead" || status === "restarting") {
        invalidateKernel(id, new Error("Notebook kernel exited unexpectedly"));
        return;
      }
      if (status === "busy" || status === "idle") channel.busy = status === "busy";
      channel.pending.get(message.parent_header?.msg_id)?.receive(message, type);
      if (channels.get(id) !== channel) return;
      const currentStatus = channel.busy || channel.execution ? "busy" : "idle";
      if (ready && currentStatus !== reportedStatus) {
        reportedStatus = currentStatus;
        try { options.onStatus?.(id, currentStatus); } catch { /* A subscriber cannot break kernel messaging. */ }
      }
      if (status === "busy") clearIdle();
      else if (status === "idle") armIdle();

      if (message.channel !== "iopub" || !COMM_TYPES.has(type) || typeof message.content?.comm_id !== "string") return;
      const comm: NotebookComm = {
        type: type as NotebookComm["type"], commId: message.content.comm_id, targetName: message.content.target_name,
        data: message.content.data ?? {}, buffers: message.buffers ?? [], metadata: message.metadata,
      };
      for (const listener of channel.listeners) {
        try { listener(comm); } catch { /* A subscriber cannot break kernel messaging. */ }
      }
    }
    const onError = () => invalidateKernel(id, new Error("Notebook kernel connection failed"));
    const onClose = () => invalidateKernel(id, new Error("Notebook kernel disconnected before completion"));
    const info = kernelMessage(channel, "kernel_info_request", {});
    let sent = false;
    const onOpen = () => {
      if (sent) return;
      sent = true;
      try { socket.send(encodeKernelMessage(info, [], options.maxMessageBytes)); }
      catch { onError(); }
    };
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => invalidateKernel(id, new Error("Notebook kernel never became ready; check the selected Python and ipykernel")), options.kernelReadyTimeoutMs ?? 30_000);
      const finish = (error?: Error) => {
        clearTimeout(timer);
        channel.pending.delete(info.header.msg_id);
        if (error) reject(error);
        else { ready = true; resolve(); }
      };
      let idle = false;
      let reply = false;
      channel.pending.set(info.header.msg_id, {
        receive(message, type) {
          if (type === "kernel_info_reply" && message.channel === "shell") {
            if (message.content?.status !== "ok" || typeof message.content?.protocol_version !== "string") {
              invalidateKernel(id, new Error("Notebook kernel returned invalid readiness information"));
              return;
            }
            reply = true;
          }
          if (type === "status" && message.channel === "iopub" && message.content?.execution_state === "idle") idle = true;
          if (reply && idle) finish();
        },
        fail: finish,
      });
      socket.addEventListener("open", onOpen);
      socket.addEventListener("message", onMessage);
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose);
      if (socket.readyState === 1) onOpen();
      else if (socket.readyState >= 2) onClose();
    });
  }

  return {
    start,
    subscribeComms(kernelId, listener) {
      const channel = channels.get(kernelId);
      if (!channel) throw new Error("Notebook kernel is stopped");
      channel.listeners.add(listener);
      return () => { channel.listeners.delete(listener); };
    },
    async sendComm(kernelId, message) {
      if (!COMM_TYPES.has(message?.type) || !message.data || typeof message.data !== "object" || Array.isArray(message.data) || typeof message.commId !== "string" || message.commId.length > 200) throw new Error("Invalid notebook widget message");
      const channel = channels.get(kernelId);
      if (!channel?.listeners.size) throw new Error("Notebook widget channel is not connected");
      if (pendingWidgets >= 128 || channel.pending.size >= 32) throw new Error("Too many pending notebook widget callbacks");
      const wire = kernelMessage(channel, message.type, {
        comm_id: message.commId, data: message.data, ...(message.targetName ? { target_name: message.targetName } : {}),
      }, message.metadata);
      const encoded = encodeKernelMessage(wire, message.buffers, options.maxMessageBytes);
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          if (channel.pending.delete(wire.header.msg_id)) pendingWidgets--;
          armIdle();
          if (error) reject(error); else resolve();
        };
        const timer = setTimeout(() => finish(new Error("Widget callback is still running; wait for the kernel to become idle")), requestTimeout);
        pendingWidgets++;
        channel.pending.set(wire.header.msg_id, {
          receive(response, type) {
            if (type === "status" && response.channel === "iopub" && response.content?.execution_state === "idle") finish();
          },
          fail: finish,
        });
        clearIdle();
        try { channel.socket.send(encoded); }
        catch { invalidateKernel(kernelId, new Error("Notebook widget send failed")); }
      });
    },
    async createKernel({ id, cwd, interpreter, environment }) {
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || !interpreter || !cwd) throw new Error("Invalid notebook kernel configuration");
      startingKernels++;
      clearIdle();
      try {
        await start();
        if (closed || !child) throw new Error("Managed Jupyter host is unavailable");
        const proc = child;
        const name = "odin-" + id;
        const root = join(specDirectory, name);
        mkdirSync(root, { recursive: true, mode: 0o700 });
        // cwd is independent of Jupyter's contents root, including across Windows drives.
        const code = [
          "import os,runpy",
          "os.chdir(" + JSON.stringify(nativePath(cwd)) + ")",
          environment ? notebookEnvironmentBootstrap(environment, nativePath) : "",
          "runpy.run_module('ipykernel_launcher',run_name='__main__')",
        ].join("\n");
        writeFileSync(join(root, "kernel.json"), JSON.stringify({
          argv: [interpreter, "-c", code, "-f", "{connection_file}"], display_name: name, language: "python",
        }), { mode: 0o600 });

        const result = await request("/api/kernels", { method: "POST", body: JSON.stringify({ name }) });
        if (closed || child !== proc) throw new Error("Managed Jupyter host stopped while the kernel was starting");
        if (!result || typeof result.id !== "string") throw new Error("Notebook host returned an invalid kernel");
        let ready: Promise<void>;
        try { ready = openChannel(result.id); }
        catch (error) {
          void request(kernelPath(result.id), { method: "DELETE" }).catch(() => {});
          throw error;
        }
        await ready;
        if (!channels.has(result.id)) throw new Error("Notebook kernel stopped before it could be used");
        return result.id;
      } finally { startingKernels--; armIdle(); }
    },
    async execute(kernelId, code, onOutput) {
      const channel = channels.get(kernelId);
      if (!channel) throw new Error("Notebook kernel is stopped");
      if (channel.execution) throw new Error("Notebook kernel is already executing");
      const wire = kernelMessage(channel, "execute_request", {
        code, silent: false, store_history: true, user_expressions: {}, allow_stdin: false, stop_on_error: true,
      });
      const encoded = encodeKernelMessage(wire, [], options.maxMessageBytes);
      return await new Promise<number | void>((resolve, reject) => {
        let idle = false;
        let reply = false;
        let executionCount: number | undefined;
        let executionError: Error | undefined;
        let outputError: Error | undefined;
        let oversized = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deliver = (output: JupyterOutput) => {
          if (outputError) return;
          try { onOutput(output); }
          catch { outputError = new Error("Notebook output could not be stored"); }
        };
        const watchCompletion = () => {
          timer ??= setTimeout(() => invalidateKernel(kernelId, new Error("Notebook kernel did not confirm execution completion")), requestTimeout);
        };
        const finish = (error?: Error) => {
          clearTimeout(timer);
          channel.pending.delete(wire.header.msg_id);
          channel.execution = undefined;
          armIdle();
          const failure = error ?? executionError ?? outputError;
          if (failure) reject(failure); else resolve(executionCount);
        };
        channel.execution = {
          watchCompletion,
          omitOversizedOutput() {
            if (oversized) return;
            oversized = true;
            deliver({ type: "stream", content: { name: "stderr", text: "Odin skipped a kernel message that exceeded its transport limit. Output may be incomplete.\n" } });
          },
        };
        channel.pending.set(wire.header.msg_id, {
          receive(message, type) {
            if (type === "execute_reply" && message.channel === "shell") {
              reply = true;
              const count = message.content?.execution_count;
              if (Number.isSafeInteger(count) && count >= 0) executionCount = count;
              if (message.content?.status !== "ok") executionError = new Error("Python execution failed");
            }
            if (message.channel === "iopub") {
              if (type === "status" && message.content?.execution_state === "idle") idle = true;
              if (type === "execute_input" && executionCount === undefined) {
                const count = message.content?.execution_count;
                if (Number.isSafeInteger(count) && count >= 0) executionCount = count;
              }
              if (OUTPUT_TYPES.has(type)) deliver({ type: type as JupyterOutput["type"], content: message.content ?? {} });
            }
            if (idle && reply) finish();
            else if (idle || reply) watchCompletion();
          },
          fail: finish,
        });
        clearIdle();
        try { channel.socket.send(encoded); }
        catch { invalidateKernel(kernelId, new Error("Notebook kernel send failed")); }
      });
    },
    async interrupt(kernelId) {
      const channel = channels.get(kernelId);
      if (!channel) return;
      await request(kernelPath(kernelId) + "/interrupt", { method: "POST", body: "{}" });
      channel.execution?.watchCompletion();
    },
    async stop(kernelId) {
      if (!dropChannel(kernelId, new Error("Notebook kernel stopped"))) return;
      try { await request(kernelPath(kernelId), { method: "DELETE" }); }
      finally { armIdle(); }
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
