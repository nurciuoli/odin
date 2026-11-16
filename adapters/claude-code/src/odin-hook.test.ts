import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IngestEvent } from "@odin/shared/ingest";
import { coreUrl, runHook, toolTarget } from "./odin-hook.ts";
import { FIXTURE } from "./test-fixtures.ts";

const TOKEN = "secret-token-123";
const HOOK = join(import.meta.dirname, "odin-hook.ts");

interface Captured {
  url: string;
  auth: string | undefined;
  events: IngestEvent[];
}

async function fakeServer(status = 200) {
  const calls: Captured[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      calls.push({ url: req.url ?? "", auth: req.headers.authorization, events: JSON.parse(Buffer.concat(chunks).toString()) });
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ accepted: 1, duplicates: 0, rejected: [], sessionIds: ["s"] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { calls, url, close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }) };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "odin-hook-"));
  const home = join(dir, "home");
  mkdirSync(home);
  const transcript = join(dir, "t.jsonl");
  writeFileSync(transcript, FIXTURE);
  return { dir, home, transcript, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const branchOf = async () => "feature/thing";
const base = (transcript: string) => ({ session_id: "s1", transcript_path: transcript, cwd: "/work/proj" });

test("SessionStart posts session.started with the branch, model and bearer token", async () => {
  const srv = await fakeServer();
  const t = setup();
  try {
    const input = { ...base(t.transcript), hook_event_name: "SessionStart", model: "claude-sonnet-5-5" };
    await runHook("SessionStart", JSON.stringify(input), { env: { ODIN_URL: srv.url, ODIN_INGEST_TOKEN: TOKEN, ODIN_HOME: t.home }, branchOf });
    assert.equal(srv.calls.length, 1);
    assert.equal(srv.calls[0]!.url, "/api/ingest");
    assert.equal(srv.calls[0]!.auth, `Bearer ${TOKEN}`);
    const [e] = srv.calls[0]!.events;
    assert.deepEqual({ ...e, ts: undefined }, {
      id: "cc:s1:start", ts: undefined, harness: "claude-code", session: "s1", cwd: "/work/proj", branch: "feature/thing",
      kind: "session.started", data: { model: "claude-sonnet-5-5" },
    });
  } finally {
    t.cleanup();
    await srv.close();
  }
});

test("a Grok hook process posts nothing", async () => {
  const srv = await fakeServer();
  const t = setup();
  try {
    const input = { ...base(t.transcript), hook_event_name: "PostToolUse", tool_name: "read_file", tool_use_id: "call-1" };
    await runHook("PostToolUse", JSON.stringify(input), {
      env: { ODIN_URL: srv.url, ODIN_INGEST_TOKEN: TOKEN, ODIN_HOME: t.home, GROK_SESSION_ID: "native-1" },
      branchOf,
    });
    assert.equal(srv.calls.length, 0);
  } finally {
    t.cleanup();
    await srv.close();
  }
});

test("SessionStart maps Claude Code's source (resume, clear, compact) into the event data", async () => {
  const srv = await fakeServer();
  const t = setup();
  try {
    const input = { ...base(t.transcript), hook_event_name: "SessionStart", source: "resume" };
    await runHook("SessionStart", JSON.stringify(input), { env: { ODIN_URL: srv.url, ODIN_INGEST_TOKEN: TOKEN, ODIN_HOME: t.home }, branchOf });
    assert.deepEqual(srv.calls[0]!.events[0]!.data, { source: "resume" });
  } finally {
    t.cleanup();
    await srv.close();
  }
});

test("PostToolUse posts a tool event with a target and no contents; ids are stable across re-runs", async () => {
  const srv = await fakeServer();
  const t = setup();
  try {
    const input = {
      ...base(t.transcript), hook_event_name: "PostToolUse", tool_name: "Edit",
      tool_input: { file_path: "src/a.ts", old_string: "SECRET BODY", new_string: "x" }, tool_response: { filePath: "src/a.ts" },
    };
    const env = { ODIN_URL: srv.url, ODIN_INGEST_TOKEN: TOKEN, ODIN_HOME: t.home };
    await runHook("PostToolUse", JSON.stringify(input), { env, branchOf });
    await runHook("PostToolUse", JSON.stringify(input), { env, branchOf });
    const [a, b] = srv.calls.map((c) => c.events[0]!);
    assert.equal(a!.id, b!.id);
    assert.match(a!.id, /^cc:s1:tool:[0-9a-f]{16}$/);
    assert.equal(a!.kind, "tool");
    assert.deepEqual(a!.data, { name: "Edit", target: "src/a.ts", ok: true });
    assert.ok(!JSON.stringify(srv.calls).includes("SECRET BODY"));

    await runHook("PostToolUse", JSON.stringify({ ...input, tool_use_id: "toolu_9", tool_response: { is_error: true } }), { env, branchOf });
    const last = srv.calls[2]!.events[0]!;
    assert.equal(last.id, "cc:s1:tool:toolu_9");
    assert.equal((last.data as any).ok, false);
  } finally {
    t.cleanup();
    await srv.close();
  }
});

test("toolTarget keeps only a path, a URL without query, or a command's first word", () => {
  assert.equal(toolTarget({ command: "FOO=bar npm run build --silent" }), "npm");
  assert.equal(toolTarget({ command: "FOO=bar" }), undefined);
  assert.equal(toolTarget({ pattern: "**/*.ts", path: "src" }), "src");
  assert.equal(toolTarget({ url: "https://example.com/a/b?token=abc#x" }), "https://example.com/a/b");
  assert.equal(toolTarget({ file_path: "x".repeat(500) })!.length, 200);
  assert.equal(toolTarget("nope"), undefined);
});

test("Stop posts cumulative usage per model and one turn per reply, and does not end the session", async () => {
  const srv = await fakeServer();
  const t = setup();
  try {
    await runHook("Stop", JSON.stringify({ ...base(t.transcript), hook_event_name: "Stop" }), {
      env: { ODIN_URL: srv.url, ODIN_INGEST_TOKEN: TOKEN, ODIN_HOME: t.home }, branchOf,
    });
    const events = srv.calls[0]!.events;
    const usage = events.filter((e) => e.kind === "usage");
    assert.equal(usage.length, 2);
    const sonnet = usage.find((e) => (e.data as any).model === "claude-sonnet-5-5")!;
    assert.deepEqual(sonnet.data, { model: "claude-sonnet-5-5", input: 300, output: 100, cacheRead: 2200, cacheWrite: 50, cumulative: true });
    const turns = events.filter((e) => e.kind === "turn");
    assert.deepEqual(turns.map((e) => e.id), ["cc:s1:turn:1", "cc:s1:turn:2", "cc:s1:turn:3"]);
    assert.deepEqual(turns[0]!.data, { index: 1, durationMs: 4000, model: "claude-sonnet-5-5" });
    assert.equal(turns[0]!.ts, "2026-10-17T10:00:04.000Z");
    assert.ok(!events.some((e) => e.kind === "session.ended"));
  } finally {
    t.cleanup();
    await srv.close();
  }
});

test("SessionEnd posts usage, turns and session.ended; only an abnormal reason becomes error", async () => {
  const srv = await fakeServer();
  const t = setup();
  try {
    const env = { ODIN_URL: srv.url, ODIN_INGEST_TOKEN: TOKEN, ODIN_HOME: t.home };
    for (const reason of ["logout", "other", "bypass_permissions_disabled", undefined]) {
      await runHook("SessionEnd", JSON.stringify({ ...base(t.transcript), hook_event_name: "SessionEnd", reason }), { env, branchOf });
    }
    const ends = srv.calls.map((c) => c.events.at(-1)!);
    assert.ok(ends.every((e) => e.id === "cc:s1:end" && e.kind === "session.ended"));
    assert.deepEqual(ends.map((e) => e.data), [
      { outcome: "completed" }, { outcome: "completed" }, { outcome: "completed", error: "bypass_permissions_disabled" }, { outcome: "completed" },
    ]);
    const first = srv.calls[0]!.events;
    assert.equal(first.filter((e) => e.kind === "usage").length, 2);
    assert.equal(first.filter((e) => e.kind === "turn").length, 3);
  } finally {
    t.cleanup();
    await srv.close();
  }
});

test("PostToolUseFailure posts a tool event with ok:false, and SessionStart re-fires with the same id", async () => {
  const srv = await fakeServer();
  const t = setup();
  try {
    const env = { ODIN_URL: srv.url, ODIN_INGEST_TOKEN: TOKEN, ODIN_HOME: t.home };
    await runHook("PostToolUseFailure", JSON.stringify({ ...base(t.transcript), hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "npm test" }, error: "exit 1" }), { env, branchOf });
    assert.deepEqual(srv.calls[0]!.events[0]!.data, { name: "Bash", target: "npm", ok: false });
    const start = JSON.stringify({ ...base(t.transcript), hook_event_name: "SessionStart", source: "resume" });
    await runHook("SessionStart", start, { env, branchOf });
    await runHook("SessionStart", start, { env, branchOf });
    assert.equal(srv.calls[1]!.events[0]!.id, srv.calls[2]!.events[0]!.id);
  } finally {
    t.cleanup();
    await srv.close();
  }
});

test("SubagentStop reports usage including subagent transcripts, tagged with the agent type, and no session.ended", async () => {
  const srv = await fakeServer();
  const t = setup();
  try {
    const subDir = join(t.dir, "s1", "subagents");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(subDir, "agent-a1.jsonl"),
      JSON.stringify({ type: "assistant", timestamp: "2026-10-17T10:01:00.000Z", isSidechain: true, message: { id: "sub_1", model: "claude-haiku-4-5", usage: { input_tokens: 5, output_tokens: 3 } } }),
    );
    await runHook("SubagentStop", JSON.stringify({ ...base(t.transcript), hook_event_name: "SubagentStop", agent_type: "reviewer" }), {
      env: { ODIN_URL: srv.url, ODIN_INGEST_TOKEN: TOKEN, ODIN_HOME: t.home }, branchOf,
    });
    const events = srv.calls[0]!.events;
    assert.ok(events.every((e) => e.agent === "reviewer"));
    assert.ok(!events.some((e) => e.kind === "session.ended"));
    const haiku = events.find((e) => e.kind === "usage" && (e.data as any).model === "claude-haiku-4-5")!;
    assert.equal((haiku.data as any).input, 15);
  } finally {
    t.cleanup();
    await srv.close();
  }
});

test("the token is read from <ODIN_HOME>/env when the variable is not set", async () => {
  const srv = await fakeServer();
  const t = setup();
  try {
    writeFileSync(join(t.home, "env"), `OTHER=1\nODIN_INGEST_TOKEN=${TOKEN}\n`);
    await runHook("SessionStart", JSON.stringify({ ...base(t.transcript), hook_event_name: "SessionStart" }), { env: { ODIN_URL: srv.url, ODIN_HOME: t.home }, branchOf });
    assert.equal(srv.calls[0]!.auth, `Bearer ${TOKEN}`);
  } finally {
    t.cleanup();
    await srv.close();
  }
});

test("never throws: dead server, bad stdin, missing token and non-2xx all just log", async () => {
  const srv = await fakeServer(500);
  const t = setup();
  try {
    const env = { ODIN_URL: "http://127.0.0.1:1", ODIN_INGEST_TOKEN: TOKEN, ODIN_HOME: t.home };
    const start = JSON.stringify({ ...base(t.transcript), hook_event_name: "SessionStart" });
    await runHook("SessionStart", start, { env, branchOf });
    await runHook("SessionStart", "not json", { env, branchOf });
    await runHook("Stop", "", { env, branchOf });
    await runHook("SessionStart", start, { env: { ODIN_HOME: t.home, ODIN_URL: srv.url }, branchOf });
    await runHook("SessionStart", start, { env: { ...env, ODIN_URL: srv.url }, branchOf });
    await runHook("SessionStart", start, { env: { ...env, ODIN_URL: srv.url }, branchOf: async () => { throw new Error("boom"); } });
    const slow = fakeServerHang();
    await runHook("SessionStart", start, { env: { ...env, ODIN_URL: (await slow).url }, branchOf, timeoutMs: 100 });
    await (await slow).close();

    const logText = readFileSync(join(t.home, "hook.log"), "utf8");
    assert.match(logText, /stdin is not JSON/);
    assert.match(logText, /no ODIN_INGEST_TOKEN/);
    assert.match(logText, /ingest answered 500/);
    assert.ok(!logText.includes(TOKEN), "the token never reaches the log");
  } finally {
    t.cleanup();
    await srv.close();
  }
});

async function fakeServerHang() {
  const server = createServer(() => {});
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }) };
}

test("run as a script: reads stdin, posts, exits 0 even when the server is down", async () => {
  const srv = await fakeServer();
  const t = setup();
  try {
    const run = (url: string, event: string) =>
      new Promise<number>((resolve) => {
        const child = execFile(process.execPath, [HOOK, event], { env: { PATH: process.env.PATH, ODIN_URL: url, ODIN_INGEST_TOKEN: TOKEN, ODIN_HOME: t.home } }, (err) => resolve(err ? ((err as any).code ?? 1) : 0));
        child.stdin!.end(JSON.stringify({ ...base(t.transcript), hook_event_name: event, model: "m" }));
      });
    assert.equal(await run(srv.url, "SessionStart"), 0);
    assert.equal(srv.calls.length, 1);
    assert.equal(srv.calls[0]!.events[0]!.kind, "session.started");
    assert.equal(await run("http://127.0.0.1:1", "SessionEnd"), 0);
  } finally {
    t.cleanup();
    await srv.close();
  }
});

test("coreUrl: ODIN_URL, then the port in <home>/runtime.json, then 8790", () => {
  const home = mkdtempSync(join(tmpdir(), "odin-hook-url-"));
  try {
    assert.equal(coreUrl({ ODIN_HOME: home }), "http://127.0.0.1:8790");
    writeFileSync(join(home, "runtime.json"), JSON.stringify({ port: 8812, pid: 1, instance: "abcdefgh" }));
    assert.equal(coreUrl({ ODIN_HOME: home }), "http://127.0.0.1:8812");
    assert.equal(coreUrl({ ODIN_HOME: home, ODIN_URL: "http://127.0.0.1:9000/" }), "http://127.0.0.1:9000");
    writeFileSync(join(home, "runtime.json"), "{not json");
    assert.equal(coreUrl({ ODIN_HOME: home }), "http://127.0.0.1:8790");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
