import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { KernelLocation } from "@odin/shared/notebooks";
import { createNotebookRuntime, decodeKernelMessage, encodeKernelMessage, type NotebookRuntimeOptions, type NotebookSocket, type JupyterOutput, type NotebookComm } from "./runtime.ts";
import { tempDir, removeTempDir } from "../test-helpers.ts";

class Socket extends EventEmitter implements NotebookSocket {
  readyState: number;
  readonly autoReady: boolean;
  sent: ReturnType<typeof decodeKernelMessage>[] = [];
  constructor(autoReady: boolean) {
    super();
    this.autoReady = autoReady;
    this.readyState = autoReady ? 1 : 0;
  }
  get wire() { return this.sent.at(-1)!; }
  send(data: string | Uint8Array) {
    const wire = decodeKernelMessage(data);
    this.sent.push(wire);
    if (wire.header.msg_type === "kernel_info_request" && this.autoReady) {
      this.message("kernel_info_reply", { status: "ok", protocol_version: "5.3" });
      this.message("status", { execution_state: "idle" });
    }
  }
  close() { this.readyState = 3; }
  addEventListener(type: string, listener: (event: any) => void) { this.on(type, listener); }
  removeEventListener(type: string, listener: (event: any) => void) { this.off(type, listener); }
  message(type: string, content: unknown, parent?: string, channel = type.endsWith("_reply") ? "shell" : "iopub") {
    this.emit("message", { data: JSON.stringify({ channel, header: { msg_type: type }, parent_header: { msg_id: parent ?? this.wire.header.msg_id }, content }) });
  }
}
function setup(location: KernelLocation = { kind: "native" }, config: Pick<NotebookRuntimeOptions, "requestTimeoutMs" | "kernelReadyTimeoutMs" | "maxMessageBytes"> & { autoReady?: boolean } = {}) {
  const home = tempDir("odin-notebook-runtime-");
  const requests: { path: string; init?: RequestInit }[] = [];
  const launches: { command: string; args: string[]; options: SpawnOptions }[] = [];
  const statuses: { id: string; state: string }[] = [];
  const stopped: string[] = [];
  const sockets: Socket[] = [];
  let nextKernel = 0;
  let child: ChildProcess;
  const runtime = createNotebookRuntime({ home, project: "test", location, hostPython: "host-python", port: 8888, idleTimeoutMs: 0, ...config,
    spawn: (command, args, options) => {
      launches.push({ command, args, options });
      const proc = new EventEmitter() as ChildProcess;
      proc.kill = (() => { queueMicrotask(() => proc.emit("exit", 0)); return true; }) as ChildProcess["kill"];
      child = proc;
      return child;
    },
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname; requests.push({ path, init });
      if (path === "/api/kernels" && init?.method === "POST") {
        nextKernel++;
        return Response.json({ id: nextKernel === 1 ? "native-id" : `native-id-${nextKernel}` });
      }
      if (path === "/api/kernels") return Response.json([]);
      if (path === "/api/shutdown") child.kill();
      return new Response(null, { status: 204 });
    }) as typeof fetch,
    webSocket: () => {
      const socket = new Socket(config.autoReady ?? true);
      sockets.push(socket);
      return socket;
    },
    onStatus: (id, state) => { statuses.push({ id, state }); },
    onStopped: ids => stopped.push(...ids),
  });
  return { home, requests, launches, statuses, stopped, sockets, runtime, socket: () => sockets.at(-1)!, crashHost: () => child.emit("exit", 1),
    async cleanup() { await runtime.close(); removeTempDir(home); } };
}
test("managed host keeps token out of argv/env and kernels retain cwd/interpreter", async () => {
  const s = setup();
  try {
    assert.equal(await s.runtime.createKernel({ id: "id", cwd: "C:\\repo space", interpreter: "project-python" }), "native-id");
    const dir = join(s.home, "jupyter-runtime", readdirSync(join(s.home, "jupyter-runtime"))[0]!);
    const config = JSON.parse(readFileSync(join(dir, "server.json"), "utf8"));
    const token = config.IdentityProvider.token;
    assert.ok(token.length >= 64);
    assert.equal(JSON.stringify(s.launches).includes(token), false);
    assert.deepEqual(s.launches[0]!.args.slice(0, 2), ["-m", "jupyter_server"]);
    assert.equal(s.launches[0]!.options.env?.JUPYTER_RUNTIME_DIR, dir);
    const spec = JSON.parse(readFileSync(join(dir, "kernels", "odin-id", "kernel.json"), "utf8"));
    assert.equal(spec.argv[0], "project-python"); assert.match(spec.argv[2], /repo space/);
    assert.equal(JSON.stringify(spec).includes(token), false);
  } finally { await s.cleanup(); }
});
test("execute attributes messages and waits for both shell reply and idle", async () => {
  const s = setup();
  try {
    await s.runtime.createKernel({ id: "id", cwd: "/repo", interpreter: "python" });
    const output: JupyterOutput[] = [];
    let done = false;
    const pending = s.runtime.execute("native-id", "print(1)", value => output.push(value)).then(count => { done = true; return count; });
    const socket = s.socket();
    socket.message("stream", { name: "stdout", text: "wrong" }, "another-cell");
    socket.message("stream", { name: "stdout", text: "wrong channel" }, undefined, "shell");
    socket.message("stream", { name: "stdout", text: "1" });
    socket.message("status", { execution_state: "idle" });
    await Promise.resolve(); assert.equal(done, false);
    socket.message("execute_reply", { status: "ok", execution_count: 9 });
    assert.equal(await pending, 9);
    assert.deepEqual(output, [{ type: "stream", content: { name: "stdout", text: "1" } }]);
    assert.equal(socket.wire.content.allow_stdin, false);
    const next = s.runtime.execute("native-id", "print(2)", () => {});
    socket.message("execute_reply", { status: "ok" });
    socket.message("status", { execution_state: "idle" });
    await next;
    assert.equal(s.sockets.length, 1);
    assert.deepEqual(socket.sent.map(wire => wire.header.msg_type), ["kernel_info_request", "execute_request", "execute_request"]);
  } finally { await s.cleanup(); }
});
test("WSL launches with distro argv and a private POSIX runtime directory rather than insecure DrvFS connection files", async () => {
  const s = setup({ kind: "wsl", distro: "Ubuntu" });
  try {
    await s.runtime.createKernel({ id: "id", cwd: "C:\\repo space", interpreter: "/env/bin/python" });
    const launch = s.launches[0]!;
    assert.equal(launch.command, "wsl.exe");
    assert.deepEqual(launch.args.slice(0, 5), ["--distribution", "Ubuntu", "--exec", "host-python", "-c"]);
    assert.match(launch.args[5]!, /tempfile\.mkdtemp/);
    assert.match(launch.args[5]!, /runtime_dir/);
    assert.match(launch.args[5]!, /JUPYTER_RUNTIME_DIR/);
    assert.equal(launch.options.shell, undefined);
  } finally { await s.cleanup(); }
});
test("kernel readiness waits for matching shell and IOPub replies after the socket opens", async () => {
  const s = setup(undefined, { autoReady: false });
  try {
    let ready = false;
    const creating = s.runtime.createKernel({ id: "id", cwd: "/repo", interpreter: "python" }).then(id => { ready = true; return id; });
    await new Promise<void>(resolve => setImmediate(resolve));
    const socket = s.socket();
    assert.equal(ready, false);
    assert.deepEqual(socket.sent, []);
    socket.readyState = 1;
    socket.emit("open", {});
    assert.equal(socket.wire.header.msg_type, "kernel_info_request");
    socket.message("kernel_info_reply", { status: "ok", protocol_version: "5.3" });
    socket.message("status", { execution_state: "idle" }, "other-request");
    await Promise.resolve();
    assert.equal(ready, false);
    socket.message("status", { execution_state: "idle" });
    assert.equal(await creating, "native-id");
  } finally { await s.cleanup(); }
});
test("a kernel that never becomes ready is stopped", async () => {
  const s = setup(undefined, { autoReady: false, kernelReadyTimeoutMs: 25 });
  try {
    await assert.rejects(s.runtime.createKernel({ id: "id", cwd: "/repo", interpreter: "python" }), /never became ready/);
    assert.deepEqual(s.stopped, ["native-id"]);
    assert.equal(s.socket().readyState, 3);
    assert.ok(s.requests.some(req => req.path === "/api/kernels/native-id" && req.init?.method === "DELETE"));
  } finally { await s.cleanup(); }
});
test("Python errors preserve output and reject the execution receipt", async () => {
  const s = setup();
  try {
    await s.runtime.createKernel({ id: "id", cwd: "/repo", interpreter: "python" });
    const pending = s.runtime.execute("native-id", "raise Exception()", () => {});
    const rejected = assert.rejects(pending, /Python execution failed/);
    s.socket().message("execute_reply", { status: "error" }); s.socket().message("status", { execution_state: "idle" });
    await rejected;
  } finally { await s.cleanup(); }
});
test("interrupt routes to the selected kernel, stop cancels execution and prevents reuse", async () => {
  const s = setup();
  try {
    await s.runtime.createKernel({ id: "id", cwd: "/repo", interpreter: "python" });
    const pending = s.runtime.execute("native-id", "while True: pass", () => {});
    const rejected = assert.rejects(pending, /stopped/);
    await s.runtime.interrupt("native-id");
    assert.ok(s.requests.some(r => r.path === "/api/kernels/native-id/interrupt"));
    await s.runtime.stop("native-id"); await rejected;
    await assert.rejects(s.runtime.execute("native-id", "1", () => {}), /stopped/);
  } finally { await s.cleanup(); }
});
test("disconnect fails instead of hanging and transport errors never expose URLs or tokens", async () => {
  const s = setup();
  try {
    await s.runtime.createKernel({ id: "id", cwd: "/repo", interpreter: "python" });
    const pending = s.runtime.execute("native-id", "1", () => {});
    const rejected = assert.rejects(pending, /disconnected before completion/);
    s.socket().emit("close", {}); await rejected;
    assert.deepEqual(s.stopped, ["native-id"]);
    assert.ok(s.requests.some(req => req.path === "/api/kernels/native-id" && req.init?.method === "DELETE"));
    assert.equal(await s.runtime.createKernel({ id: "id", cwd: "/repo", interpreter: "python" }), "native-id-2");
    assert.deepEqual(s.socket().sent.map(wire => wire.header.msg_type), ["kernel_info_request"]);
  } finally { await s.cleanup(); }
});
test("a missing completion signal invalidates the kernel without replay", async () => {
  const s = setup(undefined, { requestTimeoutMs: 25 });
  try {
    await s.runtime.createKernel({ id: "id", cwd: "/repo", interpreter: "python" });
    const execution = assert.rejects(s.runtime.execute("native-id", "read_and_mutate()", () => {}), /did not confirm execution completion/);
    s.socket().message("execute_reply", { status: "ok" });
    await execution;
    assert.deepEqual(s.stopped, ["native-id"]);
    assert.equal(s.socket().sent.filter(wire => wire.header.msg_type === "execute_request").length, 1);
  } finally { await s.cleanup(); }
});
test("one kernel exit does not disrupt another, and a managed host exit invalidates all its kernels", async () => {
  const s = setup();
  try {
    const first = await s.runtime.createKernel({ id: "first", cwd: "/repo", interpreter: "python" });
    const second = await s.runtime.createKernel({ id: "second", cwd: "/repo", interpreter: "python" });
    const firstExecution = assert.rejects(s.runtime.execute(first, "crash()", () => {}), /kernel exited unexpectedly/);
    const secondExecution = s.runtime.execute(second, "1", () => {});
    s.sockets[0]!.message("status", { execution_state: "restarting" }, "jupyter-server");
    await firstExecution;
    assert.deepEqual(s.stopped, [first]);
    s.sockets[1]!.message("execute_reply", { status: "ok", execution_count: 1 });
    s.sockets[1]!.message("status", { execution_state: "idle" });
    assert.equal(await secondExecution, 1);
    const next = assert.rejects(s.runtime.execute(second, "other_work()", () => {}), /host exited/);
    s.crashHost();
    await next;
    assert.deepEqual(s.stopped, [first, second]);
    assert.equal(await s.runtime.createKernel({ id: "second", cwd: "/repo", interpreter: "python" }), "native-id-3");
    assert.equal(s.launches.length, 2);
  } finally { await s.cleanup(); }
});
test("a persistence failure waits for Python to finish before releasing the kernel", async () => {
  const s = setup();
  try {
    const id = await s.runtime.createKernel({ id: "id", cwd: "/repo", interpreter: "python" });
    const failure = assert.rejects(s.runtime.execute(id, "print(1)", () => { throw new Error("output conflict"); }), /output could not be stored/);
    s.socket().message("stream", { name: "stdout", text: "1" });
    await assert.rejects(s.runtime.execute(id, "print(2)", () => {}), /already executing/);
    s.socket().message("execute_reply", { status: "ok" });
    s.socket().message("status", { execution_state: "idle" });
    await failure;
    assert.deepEqual(s.stopped, []);
  } finally { await s.cleanup(); }
});
test("oversized outputs produce one warning and leave a healthy kernel connected", async () => {
  const s = setup(undefined, { maxMessageBytes: 1024 });
  try {
    const id = await s.runtime.createKernel({ id: "id", cwd: "/repo", interpreter: "python" });
    const outputs: JupyterOutput[] = [];
    const execution = s.runtime.execute(id, "display_large_plot()", output => outputs.push(output));
    s.socket().message("display_data", { data: { "application/vnd.plotly.v1+json": "x".repeat(1500) } });
    s.socket().message("stream", { name: "stdout", text: "y".repeat(1500) });
    s.socket().message("execute_reply", { status: "ok", execution_count: 1 });
    s.socket().message("status", { execution_state: "idle" });
    assert.equal(await execution, 1);
    assert.equal(outputs.length, 1);
    assert.match(String(outputs[0]?.content.text), /exceeded its transport limit/);
    assert.equal(s.socket().readyState, 1);
    assert.deepEqual(s.stopped, []);
  } finally { await s.cleanup(); }
});
test("Jupyter binary frames round-trip buffers and reject malformed offsets/oversized payloads", () => {
  const binary = encodeKernelMessage({ header: { msg_type: "comm_msg" }, content: { comm_id: "widget" } }, ["AAH/"]);
  assert.ok(binary instanceof Uint8Array);
  assert.deepEqual(decodeKernelMessage(binary).buffers, ["AAH/"]);
  assert.throws(() => decodeKernelMessage(new Uint8Array([0, 0, 0, 2, 0, 0, 0, 8])), /offset table/);
  assert.throws(() => encodeKernelMessage({ content: "large" }, ["AAH/"], 8), /too large/);
  assert.throws(() => encodeKernelMessage({}, ["not!base64"]), /Invalid notebook binary/);
  assert.throws(() => encodeKernelMessage({}, Array.from({ length: 129 }, () => "")), /Invalid notebook binary/);
});
test("persistent widget comms receive broadcasts independently of cell execution and send bounded binary state", async () => {
  const s = setup();
  try {
    await s.runtime.createKernel({ id: "id", cwd: "/repo", interpreter: "python" });
    const messages: NotebookComm[] = [];
    const unsubscribe = s.runtime.subscribeComms("native-id", value => messages.push(value));
    const channel = s.socket();
    channel.message("comm_open", { comm_id: "widget", target_name: "jupyter.widget", data: { state: {} } }, "external");
    assert.equal(messages.length, 1);
    let completed = false;
    const sending = s.runtime.sendComm("native-id", { type: "comm_msg", commId: "widget", data: { method: "update", state: {} }, buffers: ["AAH/"] }).then(() => { completed = true; });
    await Promise.resolve();
    assert.equal(channel.wire.header.msg_type, "comm_msg");
    assert.deepEqual(channel.wire.buffers, ["AAH/"]);
    channel.message("status", { execution_state: "busy" }); await Promise.resolve();
    assert.equal(completed, false);
    channel.message("status", { execution_state: "idle" }); await sending;
    assert.deepEqual(s.statuses, [{ id: "native-id", state: "busy" }, { id: "native-id", state: "idle" }]);
    unsubscribe();
    await assert.rejects(s.runtime.sendComm("native-id", { type: "comm_msg", commId: "widget", data: {} }), /not connected/);
  } finally { await s.cleanup(); }
});
