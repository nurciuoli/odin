import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:http";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { KernelLocation } from "@odin/shared/notebooks";
import { createNotebookRuntime, decodeKernelMessage, encodeKernelMessage, type NotebookSocket, type JupyterOutput, type NotebookComm } from "./runtime.ts";

class Socket extends EventEmitter implements NotebookSocket {
  readyState = 1;
  wire: any;
  send(data: string | Uint8Array) { this.wire = decodeKernelMessage(data); }
  close() { this.readyState = 3; }
  addEventListener(type: string, listener: (event: any) => void) { this.on(type, listener); }
  removeEventListener(type: string, listener: (event: any) => void) { this.off(type, listener); }
  message(type: string, content: unknown, parent?: string) {
    this.emit("message", { data: JSON.stringify({ header: { msg_type: type }, parent_header: { msg_id: parent ?? this.wire.header.msg_id }, content }) });
  }
}
function setup(location: KernelLocation = { kind: "native" }) {
  const home = mkdtempSync(join(tmpdir(), "odin-notebook-runtime-"));
  const requests: { path: string; init?: RequestInit }[] = [];
  const launches: { command: string; args: string[]; options: SpawnOptions }[] = [];
  const statuses: { id: string; state: string }[] = [];
  let socket: Socket;
  const child = new EventEmitter() as ChildProcess;
  child.kill = (() => { queueMicrotask(() => child.emit("exit", 0)); return true; }) as ChildProcess["kill"];
  const runtime = createNotebookRuntime({ home, project: "test", location, hostPython: "host-python", port: 8888, idleTimeoutMs: 0,
    spawn: (command, args, options) => { launches.push({ command, args, options }); return child; },
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname; requests.push({ path, init });
      if (path === "/api/kernels" && init?.method === "POST") return Response.json({ id: "native-id" });
      if (path === "/api/kernels") return Response.json([]);
      return new Response(null, { status: 204 });
    }) as typeof fetch,
    webSocket: () => { socket = new Socket(); return socket; }, onStatus: (id, state) => { statuses.push({ id, state }); },
  });
  return { home, requests, launches, statuses, runtime, socket: () => socket!, async cleanup() { await runtime.close(); rmSync(home, { recursive: true, force: true }); } };
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
    const pending = s.runtime.execute("native-id", "print(1)", value => output.push(value)).then(() => { done = true; });
    const socket = s.socket();
    socket.message("stream", { name: "stdout", text: "wrong" }, "another-cell");
    socket.message("stream", { name: "stdout", text: "1" });
    socket.message("status", { execution_state: "idle" });
    await Promise.resolve(); assert.equal(done, false);
    socket.message("execute_reply", { status: "ok" }); await pending;
    assert.deepEqual(output, [{ type: "stream", content: { name: "stdout", text: "1" } }]);
    assert.equal(socket.wire.content.allow_stdin, false);
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
    assert.equal(launch.options.shell, undefined);
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
  } finally { await s.cleanup(); }
});
test("JupyterLab hand-off binds the existing kernel and isolates the token behind a separate origin", async () => {
  const home = mkdtempSync(join(tmpdir(), "odin-notebook-lab-"));
  const upstream = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ token: req.headers.authorization?.slice(6), origin: req.headers.origin }));
  });
  upstream.on("upgrade", (req, socket) => {
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nX-Test-Token: ${req.headers.authorization?.slice(6)}\r\n\r\n`);
  });
  const upstreamSockets = new Set<import("node:net").Socket>();
  upstream.on("connection", socket => { upstreamSockets.add(socket); socket.once("close", () => upstreamSockets.delete(socket)); });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address(); assert.ok(address && typeof address !== "string");
  let sessionBody: any;
  const child = new EventEmitter() as ChildProcess;
  child.kill = (() => { queueMicrotask(() => child.emit("exit", 0)); return true; }) as ChildProcess["kill"];
  const runtime = createNotebookRuntime({ home, project: "test", location: { kind: "native" }, hostPython: "python", port: address.port, idleTimeoutMs: 0,
    spawn: () => child,
    fetch: (async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api/kernels" && init?.method === "POST") return Response.json({ id: "native" });
      if (path === "/api/sessions" && init?.method !== "POST") return Response.json([]);
      if (path === "/api/sessions") { sessionBody = JSON.parse(String(init?.body)); return Response.json({ id: "jupyter-session", kernel: { id: "native" } }); }
      if (path === "/api/kernels") return Response.json([]);
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });
  try {
    await runtime.createKernel({ id: "id", cwd: "/repo", interpreter: "python" });
    const { url } = await runtime.openLab({ notebookPath: "id.ipynb", kernelId: "native" });
    const lab = new URL(url);
    assert.notEqual(lab.port, String(address.port)); assert.equal(lab.search, "");
    assert.deepEqual(sessionBody.kernel, { id: "native" }); assert.equal(sessionBody.path, "id.ipynb");
    const config = await (await fetch(url)).json(); assert.equal(config.token, "");
    assert.equal((await fetch(url, { headers: { origin: "https://attacker.invalid" } })).status, 403);
    await new Promise<void>((resolve, reject) => {
      const req = request(url, { headers: { connection: "Upgrade", upgrade: "websocket" } });
      req.once("upgrade", (res, socket) => { try { assert.equal(res.headers["x-test-token"], ""); socket.destroy(); resolve(); } catch (error) { socket.destroy(); reject(error); } });
      req.once("error", reject); req.end();
    });
    await runtime.closeLab();
    await assert.rejects(fetch(url));
  } finally {
    await runtime.close();
    for (const socket of upstreamSockets) socket.destroy();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
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
