// Claude Code hook → Odin ingest (docs/contracts.md#claude-code-adapter). Run as
//   node odin-hook.ts <HookEvent>
// with the hook JSON on stdin. It must never block or fail the agent: 2s timeout, every error swallowed (appended to
// <ODIN_HOME>/hook.log without secrets), exit 0.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IngestEvent } from "@odin/shared/ingest";
import { TranscriptScan } from "./transcript.ts";

const DEFAULT_URL = "http://127.0.0.1:8790";
const TOKEN_VAR = "ODIN_INGEST_TOKEN";
const POST_TIMEOUT_MS = 2000;
const NORMAL_END_REASONS = new Set(["logout", "prompt_input_exit", "clear", "other"]);
const MAX_TRANSCRIPT_BYTES = 128 * 1024 * 1024;

export interface HookOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Current git branch of a directory; defaults to `git -C <cwd> rev-parse --abbrev-ref HEAD`. */
  branchOf?: (cwd: string) => Promise<string | undefined>;
  timeoutMs?: number;
}

type Input = Record<string, any>;

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);
const isRecord = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

function odinHome(env: NodeJS.ProcessEnv): string {
  const h = env.ODIN_HOME;
  if (!h) return join(homedir(), ".odin");
  return h === "~" ? homedir() : h.startsWith("~/") ? join(homedir(), h.slice(2)) : h;
}

/** ODIN_URL, else the port a running core wrote to <home>/runtime.json, else the default port. */
export function coreUrl(env: NodeJS.ProcessEnv): string {
  const explicit = env.ODIN_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  try {
    const port = (JSON.parse(readFileSync(join(odinHome(env), "runtime.json"), "utf8")) as { port?: unknown }).port;
    if (typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535) return `http://127.0.0.1:${port}`;
  } catch {
    // no running core recorded: fall through
  }
  return DEFAULT_URL;
}

function readToken(env: NodeJS.ProcessEnv): string | undefined {
  const fromEnv = env[TOKEN_VAR]?.trim();
  if (fromEnv) return fromEnv;
  try {
    const m = new RegExp(`^${TOKEN_VAR}=(.+)$`, "m").exec(readFileSync(join(odinHome(env), "env"), "utf8"));
    return m?.[1]?.trim().replace(/^["']|["']$/g, "") || undefined;
  } catch {
    return undefined;
  }
}

function log(env: NodeJS.ProcessEnv, token: string | undefined, now: Date, message: string): void {
  try {
    const safe = (token ? message.split(token).join("[redacted]") : message).replace(/\s+/g, " ").slice(0, 500);
    const home = odinHome(env);
    mkdirSync(home, { recursive: true });
    appendFileSync(join(home, "hook.log"), `${now.toISOString()} ${safe}\n`);
  } catch {
    // nowhere left to report to
  }
}

function gitBranch(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { timeout: 1000, windowsHide: true }, (err, stdout) => {
      const branch = err ? "" : String(stdout).trim();
      resolve(branch && branch !== "HEAD" ? branch : undefined);
    });
  });
}

/** A path, a glob, a URL without its query, or a command's first word. Never contents or output. */
export function toolTarget(toolInput: unknown): string | undefined {
  if (!isRecord(toolInput)) return undefined;
  const direct = str(toolInput.file_path) ?? str(toolInput.notebook_path) ?? str(toolInput.path) ?? str(toolInput.pattern);
  if (direct) return direct.slice(0, 200);
  const url = str(toolInput.url);
  if (url) {
    try {
      const u = new URL(url);
      return (u.origin + u.pathname).slice(0, 200);
    } catch {
      return undefined;
    }
  }
  const command = str(toolInput.command);
  if (command) {
    // Skip leading VAR=value words, which may hold secrets.
    const word = command.trim().split(/\s+/).find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    return word?.slice(0, 200);
  }
  return undefined;
}

function toolOk(response: unknown): boolean {
  if (!isRecord(response)) return true;
  if (response.is_error === true || response.isError === true || response.success === false) return false;
  return !str(response.error);
}

function readFileSafe(path: string): string | undefined {
  try {
    if (statSync(path).size > MAX_TRANSCRIPT_BYTES) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Subagent transcripts live beside the main one (<dir>/<session>/subagents/*.jsonl) in current Claude Code. */
function subagentTranscripts(transcriptPath: string, session: string, extra: string | undefined): string[] {
  const paths = new Set<string>();
  if (extra) paths.add(extra);
  try {
    const dir = join(dirname(transcriptPath), session, "subagents");
    for (const f of readdirSync(dir)) if (f.endsWith(".jsonl")) paths.add(join(dir, f));
  } catch {
    // none
  }
  paths.delete(transcriptPath);
  return [...paths];
}

/** The ingest events for one hook call. Ids are deterministic, so re-running a hook never double counts. */
export async function buildEvents(eventName: string, input: Input, raw: string, opts: { now: Date; branchOf: (cwd: string) => Promise<string | undefined> }): Promise<IngestEvent[]> {
  const session = str(input.session_id);
  if (!session) return [];
  const cwd = str(input.cwd);
  const branch = cwd ? await opts.branchOf(cwd).catch(() => undefined) : undefined;
  const agent = eventName === "SubagentStop" ? str(input.agent_type) : undefined;
  const base = (ts = opts.now.toISOString()) => ({
    ts,
    harness: "claude-code",
    session,
    ...(cwd ? { cwd } : {}),
    ...(branch ? { branch } : {}),
    ...(agent ? { agent } : {}),
  });
  const events: IngestEvent[] = [];

  if (eventName === "SessionStart") {
    const model = str(input.model);
    const source = str(input.source)?.slice(0, 40);
    events.push({ ...base(), id: `cc:${session}:start`, kind: "session.started", data: { ...(model ? { model } : {}), ...(source ? { source } : {}) } });
  } else if (eventName === "PostToolUse" || eventName === "PostToolUseFailure") {
    const name = str(input.tool_name);
    if (!name) return [];
    const target = toolTarget(input.tool_input);
    events.push({
      ...base(),
      id: `cc:${session}:tool:${str(input.tool_use_id) ?? hash(raw)}`,
      kind: "tool",
      data: { name, ...(target ? { target } : {}), ok: eventName === "PostToolUse" && toolOk(input.tool_response) },
    });
  } else if (eventName === "SubagentStop" || eventName === "Stop" || eventName === "SessionEnd") {
    const transcript = str(input.transcript_path);
    const text = transcript ? readFileSafe(transcript) : undefined;
    if (transcript && text !== undefined) {
      const scan = new TranscriptScan();
      const turns = scan.add(text, true);
      for (const p of subagentTranscripts(transcript, session, str(input.agent_transcript_path))) {
        const sub = readFileSafe(p);
        if (sub !== undefined) scan.add(sub);
      }
      for (const [model, u] of Object.entries(scan.usage())) {
        events.push({
          ...base(),
          id: `cc:${session}:usage:${hash(`${model}:${u.input}:${u.output}:${u.cacheRead}:${u.cacheWrite}`)}`,
          kind: "usage",
          data: { model, ...u, cumulative: true },
        });
      }
      for (const t of turns) {
        events.push({
          ...base(t.ts),
          id: `cc:${session}:turn:${t.index}`,
          kind: "turn",
          data: { index: t.index, durationMs: t.durationMs, ...(t.model ? { model: t.model } : {}) },
        });
      }
    }
    if (eventName === "SessionEnd") {
      // Stop fires after every reply, so only SessionEnd ends the session.
      const reason = str(input.reason);
      events.push({
        ...base(),
        id: `cc:${session}:end`,
        kind: "session.ended",
        data: { outcome: "completed", ...(reason && !NORMAL_END_REASONS.has(reason) ? { error: reason.slice(0, 200) } : {}) },
      });
    }
  }
  return events;
}

/** Grok Build runs the project's Claude hooks and sets this on every hook process. */
function isGrokHook(env: NodeJS.ProcessEnv): boolean {
  return !!env.GROK_SESSION_ID?.trim();
}

/** Never throws. */
export async function runHook(argvEvent: string | undefined, stdinText: string, opts: HookOptions = {}): Promise<void> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());
  const token = readToken(env);
  // Grok's own session is measured by the harness. Reporting it here creates an empty Claude session
  // under Grok's native id, which is not the Odin session id.
  if (isGrokHook(env)) return;
  try {
    let input: Input = {};
    try {
      const parsed: unknown = JSON.parse(stdinText);
      if (isRecord(parsed)) input = parsed;
    } catch {
      log(env, token, now(), "stdin is not JSON");
      return;
    }
    const eventName = str(input.hook_event_name) ?? argvEvent;
    if (!eventName) return;
    if (!token) {
      log(env, token, now(), `no ${TOKEN_VAR} in the environment or ${join(odinHome(env), "env")}`);
      return;
    }
    const events = await buildEvents(eventName, input, stdinText, { now: now(), branchOf: opts.branchOf ?? gitBranch });
    if (events.length === 0) return;

    const url = `${coreUrl(env)}/api/ingest`;
    const res = await (opts.fetch ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(events),
      signal: AbortSignal.timeout(opts.timeoutMs ?? POST_TIMEOUT_MS),
    });
    if (!res.ok) log(env, token, now(), `${eventName}: ingest answered ${res.status}`);
    else {
      const body: any = await res.json().catch(() => null);
      if (Array.isArray(body?.rejected) && body.rejected.length > 0) log(env, token, now(), `${eventName}: rejected ${JSON.stringify(body.rejected).slice(0, 300)}`);
    }
  } catch (err) {
    log(env, token, now(), `${argvEvent ?? "hook"}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) {
  setTimeout(() => process.exit(0), 5000).unref();
  try {
    await runHook(process.argv[2], await readStdin());
  } catch {
    // never fail the agent
  }
  process.exit(0);
}
