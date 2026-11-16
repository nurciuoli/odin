// Scripted Electron smoke run (docs/desktop.md#testing). Manual, not part of `yarn test`:
//   yarn build:desktop && node apps/desktop/smoke/smoke.ts [path/to/Odin.exe]
// Launches the unpacked app with a temp ODIN_HOME, the fake harness and port 8797; checks the window loads the web
// app, a session starts, the tray count changes, and `Odin.exe --quit` stops core. No network, no model calls.
import { _electron as electron } from "playwright";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { startHostBridge } from "../../../packages/core/src/harness/grok/bridge.ts";

const exe = resolve(process.argv[2] ?? join(import.meta.dirname, "../dist/win-unpacked/Odin.exe"));
const port = 8797;
const origin = `http://127.0.0.1:${port}`;
const home = mkdtempSync(join(tmpdir(), "odin-smoke-home-"));
const project = mkdtempSync(join(tmpdir(), "odin-smoke-proj-"));
const profileArg = `--user-data-dir=${join(home, "electron")}`;
const env = { ...process.env, GITHUB_TOKEN: "fake-smoke-no-github", ODIN_HOME: home, ODIN_FAKE_HARNESS: "1", ODIN_PORT: String(port) } as Record<string, string>;

function step(msg: string) {
  console.log(`smoke: ${msg}`);
}

async function until<T>(what: string, fn: () => Promise<T | undefined | false> | T | undefined | false, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      // not yet
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function api(path: string, body?: unknown) {
  const res = await fetch(origin + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

const log = () => readFileSync(join(home, "desktop.log"), "utf8");
const healthy = async () => (await fetch(`${origin}/api/health`)).ok;

async function childOutput(command: string, args: string[], input: string, childEnv: Record<string, string>, verbatim = false) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { env: childEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: verbatim });
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("packaged helper timed out")); }, 15_000);
    child.stdout.setEncoding("utf8").on("data", data => { output += data; });
    child.stderr.resume();
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("exit", code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(`packaged helper exited ${code}`)); });
    child.stdin.end(input);
  });
}

async function checkPackagedHelpers() {
  const resources = join(dirname(exe), "resources");
  const bridge = await startHostBridge([{ name: "smoke_tool", description: "Smoke fixture", params: {}, handler: async () => ({ text: "packaged bridge works" }) }]);
  try {
    const output = await childOutput(exe, [join(resources, "core", "host-mcp.js"), "--port", String(bridge.port)], [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "smoke_tool", arguments: {} } },
    ].map(message => JSON.stringify(message)).join("\n") + "\n", { ...env, ELECTRON_RUN_AS_NODE: "1" });
    const messages = output.trim().split(/\r?\n/).map(line => JSON.parse(line));
    if (messages.find(message => message.id === 3)?.result?.content?.[0]?.text !== "packaged bridge works") throw new Error("packaged MCP tool did not reply");
  } finally { await bridge.close(); }

  const transcript = join(project, "smoke-transcript.jsonl");
  const stamp = new Date().toISOString();
  writeFileSync(transcript, [
    { type: "user", timestamp: stamp, message: { role: "user", content: "terminal smoke" } },
    { type: "assistant", timestamp: stamp, message: { id: "smoke-reply", role: "assistant", model: "claude-fake", content: [{ type: "text", text: "done" }], usage: { input_tokens: 10, output_tokens: 5 } } },
  ].map(line => JSON.stringify(line)).join("\n"));
  // The command is static; the helper path is an environment value inside quotes, not interpolated shell code.
  await childOutput(join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe"), ["/d", "/s", "/c", '""%ODIN_SMOKE_WRAPPER%" Stop"'],
    JSON.stringify({ hook_event_name: "Stop", session_id: "smoke-terminal", cwd: project, transcript_path: transcript }),
    { ...env, ODIN_URL: origin, ODIN_SMOKE_WRAPPER: join(resources, "adapter", "odin-hook.cmd") }, true);
  await until("packaged hook ingest", async () => (await api("/api/sessions?origin=external") as { id: string }[]).some(session => session.id === "smoke-terminal"));
  step("packaged Grok MCP bridge and terminal hook wrapper passed");
}

let app: Awaited<ReturnType<typeof electron.launch>> | null = null;
try {
  if (await healthy().catch(() => false)) throw new Error(`port ${port} is already in use`);
  step(`launching ${exe}`);
  app = await electron.launch({ executablePath: exe, args: [profileArg], env });
  const win = await app.firstWindow();
  await until("core healthy", healthy);
  await until("web app in the window", async () => win.url().startsWith(origin) && (await win.title()) === "Odin");
  await win.waitForSelector("#app *", { timeout: 30_000 });
  step(`window loaded ${win.url()}`);

  await api("/api/projects", { path: project, name: "smoke", init: true });
  const s = (await api("/api/sessions", { project: "smoke", prompt: { text: "hello" } })) as { id: string };
  step(`session ${s.id} started`);
  await until("tray count change", () => /tray: Odin: [1-9]\d* running/.test(log()));
  step("tray count changed");
  await until("session idle", async () => ((await api(`/api/sessions/${s.id}`)) as { state: string }).state === "idle");

  await win.goto(`${origin}/s/${s.id}`);
  await win.getByText("Fake reply to: hello", { exact: true }).waitFor();
  await win.getByLabel("Message", { exact: true }).fill("run tests");
  await win.getByRole("button", { name: "Send", exact: true }).click();
  await win.getByRole("button", { name: "Allow once", exact: false }).click();
  await win.getByText("Fake reply to: run tests", { exact: true }).waitFor();
  await until("permission turn idle", async () => ((await api(`/api/sessions/${s.id}`)) as { state: string }).state === "idle");
  await win.reload();
  await win.getByText("Fake reply to: run tests", { exact: true }).waitFor();
  step("browser follow-up, permission answer and reload passed");

  await api(`/api/sessions/${s.id}/messages`, { text: "artifact" });
  const artifact = await until("artifact posted", async () => {
    const detail = await api(`/api/sessions/${s.id}`) as { state: string; artifacts: { id: number; latestVersion: number }[] };
    return detail.state === "idle" && detail.artifacts[0];
  });
  await win.goto(`${origin}/s/${s.id}?artifact=${artifact.id}`);
  const frame = win.frameLocator("iframe").first();
  await frame.getByRole("button", { name: "A", exact: true }).click();
  await win.getByRole("button", { name: "Send answer", exact: true }).click();
  await until("artifact response delivered", async () => {
    const detail = await api(`/api/sessions/${s.id}`) as { state: string; transcript: { kind: string; text?: string }[] };
    return detail.state === "idle" && detail.transcript.some(entry => entry.kind === "user" && /"choice"\s*:\s*"A"/.test(entry.text ?? ""));
  });
  step("artifact deep link and sandboxed submission passed");

  const fork = await api(`/api/sessions/${s.id}/fork`, { title: "Smoke fork", prompt: { text: "fork hello" } }) as { id: string };
  await until("fork idle", async () => ((await api(`/api/sessions/${fork.id}`)) as { state: string }).state === "idle");
  step("fork passed");
  await checkPackagedHelpers();

  const closed = new Promise<void>((r) => app!.process().once("exit", () => r()));
  await new Promise<void>((r, j) => execFile(exe, [profileArg, "--quit"], { env }, (err) => (err ? j(err) : r())));
  await until("core stopped", async () => !(await healthy().catch(() => false)));
  await Promise.race([closed, new Promise((_, j) => setTimeout(() => j(new Error("app did not exit")), 15_000))]);
  app = null;
  if (!/stopping core/.test(log())) throw new Error("desktop.log has no 'stopping core'");
  step("quit stopped core; PASS");
} catch (err) {
  console.error(`smoke: FAIL ${err instanceof Error ? err.message : String(err)}`);
  try {
    console.error(log());
  } catch {
    // no log
  }
  process.exitCode = 1;
} finally {
  await app?.close().catch(() => {});
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
}
