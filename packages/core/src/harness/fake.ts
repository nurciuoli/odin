// A scriptable in-memory harness for tests and for running the app without credentials (ODIN_FAKE_HARNESS=1).
// It behaves like a driver: start/resume/fork, per-turn scripts, permission prompts that block until answered,
// host tools, usage, and a store so list()/messages() return what ran (plus seeded "external" sessions).
//
//   const harness = fakeHarness({
//     script: (msg, turn) => turn === 0
//       ? [{ text: "Let me look." }, { tool: "Write", input: { file_path: "a.txt" }, ask: true }, { text: "Done." }]
//       : [{ text: `You said: ${msg.text}` }],
//   });
import { EventQueue as Channel } from "./queue.ts";
import { randomUUID } from "node:crypto";
import type { ModelInfo, PermissionAnswer, PermissionMode, TokenUsage, Todo, UserMessage } from "@odin/shared/api";
import type { HarnessEvent, PermissionRequest, TranscriptEntry } from "@odin/shared/harness";
import { ODIN_MCP_SERVER } from "@odin/shared";
import { applyHarnessEvent, toolResult } from "@odin/shared/transcript";
import type { Harness, HarnessSessionInfo, SessionHandle, StartOptions } from "./types.ts";
import { boundHostToolResult, hostResultSummary } from "./host-result.ts";

export type FakeStep =
  | { text: string; /** Stream it as this many deltas first. */ deltas?: number }
  | { thinking: string }
  /**
   * A tool call. `ask` raises a permission prompt first and waits for the answer: deny → an error result and the
   * script goes on (or stops the turn when the answer says `interrupt`). `kind` picks plan/question prompts.
   */
  | { tool: string; input?: Record<string, unknown>; result?: string; ok?: boolean; ask?: boolean; kind?: PermissionRequest["kind"]; title?: string }
  /** Call one of the start options' host tools (e.g. post_artifact) as the model would. */
  | { hostTool: string; input: Record<string, unknown> }
  | { usage: Partial<TokenUsage>; model?: string; costUsd?: number; contextTokens?: number }
  | { todos: Todo[] }
  | { emit: HarnessEvent }
  /** Wait this many ms (real time) or for a promise; lets tests interleave. */
  | { wait: number | Promise<unknown> }
  /** The harness dies: `exit` failed. */
  | { fail: string };

export type FakeScript = (message: UserMessage, turn: number, options: StartOptions) => FakeStep[];

export interface FakeHarnessOptions {
  id?: string;
  /** Per-turn steps. Default: one assistant reply echoing the message, with a little usage. */
  script?: FakeScript;
  model?: string;
  now?: () => Date;
  available?: boolean;
}

interface StoredSession {
  info: HarnessSessionInfo;
  entries: TranscriptEntry[];
}

export interface FakeHarness extends Harness {
  /** Every start() call's options, in order. */
  readonly starts: StartOptions[];
  /** Live handles by session id. */
  readonly handles: Map<string, FakeHandle>;
  /** Every answer given, in order. */
  readonly answers: { sessionId: string; requestId: string; answer: PermissionAnswer }[];
  /** Replace the script for later turns. */
  setScript(script: FakeScript): void;
  /** Add a stored session as if another client (a terminal `claude`) had made it. */
  seed(info: Partial<HarnessSessionInfo> & { sessionId: string; cwd: string }, entries?: TranscriptEntry[]): void;
  /** The stored transcript (what messages() returns). */
  stored(sessionId: string): TranscriptEntry[] | null;
}

export interface FakeHandle extends SessionHandle {
  readonly options: StartOptions;
  readonly sent: UserMessage[];
  /** Open permission requests. */
  readonly pending: Map<string, PermissionRequest>;
  readonly closed: boolean;
  model: string;
  permissionMode: PermissionMode;
}

const DEFAULT_MODEL = "claude-fake-1";

const defaultScript: FakeScript = (message) => [
  { text: `ok: ${message.text}` },
  { usage: { input: 10, output: 5 } },
];

const DEMO_ARTIFACT = `<!doctype html><html><head><meta charset="utf-8"><title>Choose</title></head><body>
<p>Which option?</p><button onclick="odin.submit({ choice: 'A' })">A</button>
<button onclick="odin.submit({ choice: 'B' })">B</button></body></html>`;

/**
 * The script `ODIN_FAKE_HARNESS=1` runs: enough to exercise every path by hand. A message containing "run" asks
 * to run a Bash command; "edit" asks to write a file; "plan" asks to approve a plan; "artifact" posts an artifact
 * through the host tool; "fail" kills the session; anything else gets an echo. Every turn reports some usage.
 */
export const demoScript: FakeScript = (message) => {
  const t = message.text.toLowerCase();
  const steps: FakeStep[] = [{ thinking: "Fake harness: deciding what to do." }];
  if (t.includes("fail")) return [{ fail: "fake harness: asked to fail" }];
  if (t.includes("run")) steps.push({ tool: "Bash", input: { command: "npm test", description: "Run the tests" }, ask: true, result: "212 tests passed" });
  if (t.includes("edit")) steps.push({ tool: "Write", input: { file_path: "NOTES.md", content: "Written by the fake harness.\n" }, ask: true, result: "File written (not really)" });
  if (t.includes("plan")) steps.push({ tool: "ExitPlanMode", input: { plan: "1. Read the code\n2. Change it\n3. Test it" }, ask: true, result: "Plan approved" });
  if (t.includes("todo")) steps.push({ tool: "TodoWrite", input: { todos: [{ content: "Read", status: "completed" }, { content: "Write", status: "in_progress", activeForm: "Writing" }] } });
  if (t.includes("artifact")) steps.push({ hostTool: "post_artifact", input: { title: "Pick one", html: DEMO_ARTIFACT, note: "From the fake harness" } });
  steps.push({ text: `Fake reply to: ${message.text}`, deltas: 4 }, { usage: { input: 1200, output: 150, cacheRead: 20_000, cacheWrite: 300 }, contextTokens: 22_000 });
  return steps;
};

export function fakeHarness(options: FakeHarnessOptions = {}): FakeHarness {
  const now = options.now ?? (() => new Date());
  const id = options.id ?? "claude";
  let script = options.script ?? defaultScript;
  const store = new Map<string, StoredSession>();
  const starts: StartOptions[] = [];
  const handles = new Map<string, FakeHandle>();
  const answers: FakeHarness["answers"] = [];

  function startHandle(opts: StartOptions): FakeHandle {
    starts.push(opts);
    const sessionId = opts.fork || !opts.resume ? (opts.sessionId ?? randomUUID()) : opts.resume;
    const source = opts.resume ? store.get(opts.resume) : undefined;
    const stored: StoredSession = store.get(sessionId) ?? {
      info: {
        sessionId,
        title: opts.title ?? source?.info.title ?? opts.prompt?.text.slice(0, 60) ?? "Untitled",
        firstPrompt: source?.info.firstPrompt ?? opts.prompt?.text ?? null,
        cwd: opts.cwd,
        gitBranch: null,
        createdAt: now().toISOString(),
        updatedAt: now().toISOString(),
      },
      entries: source ? source.entries.map((e) => ({ ...e })) : [],
    };
    store.set(sessionId, stored);

    const events = new Channel<HarnessEvent>();
    const inbox: UserMessage[] = [];
    const pending = new Map<string, PermissionRequest>();
    const waiters = new Map<string, (a: PermissionAnswer | null) => void>();
    let turn = 0;
    let busy = false;
    let closed = false;
    let interrupted = false;
    // Ids continue after the stored entries, so a resume never collides with earlier ones.
    let seq = stored.entries.length;
    const nextId = (p: string) => `${p}-${sessionId.slice(0, 8)}-${++seq}`;

    const emit = (e: HarnessEvent) => {
      if (closed && e.type !== "exit") return;
      stored.entries = applyHarnessEvent(stored.entries, e);
      stored.info.updatedAt = now().toISOString();
      events.push(e);
    };
    const at = () => now().toISOString();

    const handle: FakeHandle = {
      sessionId,
      events,
      options: opts,
      sent: [],
      pending,
      get closed() {
        return closed;
      },
      model: opts.model ?? options.model ?? DEFAULT_MODEL,
      permissionMode: opts.permissionMode ?? "default",
      send(message) {
        if (closed) return;
        handle.sent.push(message);
        inbox.push(message);
        void pump();
      },
      answer(requestId, answer) {
        const w = waiters.get(requestId);
        if (!w) return;
        answers.push({ sessionId, requestId, answer });
        waiters.delete(requestId);
        pending.delete(requestId);
        emit({ type: "permission.resolved", requestId, behavior: answer.behavior });
        w(answer);
      },
      async interrupt() {
        interrupted = true;
        for (const [rid, w] of waiters) {
          waiters.delete(rid);
          pending.delete(rid);
          emit({ type: "permission.resolved", requestId: rid, behavior: "cancelled" });
          w(null);
        }
      },
      async setModel(model) {
        handle.model = model;
        emit({ type: "model", model });
      },
      async setPermissionMode(mode) {
        handle.permissionMode = mode;
        emit({ type: "permission.mode", mode });
      },
      async close() {
        if (closed) return;
        await handle.interrupt();
        closed = true;
        handles.delete(sessionId);
        events.push({ type: "exit", outcome: "closed", error: null });
        events.end();
      },
    };

    const fail = (error: string) => {
      if (closed) return;
      closed = true;
      handles.delete(sessionId);
      events.push({ type: "exit", outcome: "failed", error });
      events.end();
    };

    async function runStep(step: FakeStep): Promise<"ok" | "stop"> {
      if ("text" in step) {
        const entryId = nextId("msg");
        const n = step.deltas ?? 0;
        if (n > 0) {
          const size = Math.ceil(step.text.length / n);
          for (let i = 0; i < step.text.length; i += size) {
            emit({ type: "delta", entryId, kind: "assistant", text: step.text.slice(i, i + size), parentToolUseId: null });
          }
        }
        emit({ type: "entry", entry: { kind: "assistant", id: entryId, text: step.text, model: handle.model, at: at(), parentToolUseId: null } });
      } else if ("thinking" in step) {
        emit({ type: "entry", entry: { kind: "thinking", id: nextId("think"), text: step.thinking, at: at(), parentToolUseId: null } });
      } else if ("tool" in step) {
        const toolUseId = nextId("toolu");
        const input = step.input ?? {};
        emit({ type: "entry", entry: { kind: "tool", id: toolUseId, name: step.tool, input, at: at(), parentToolUseId: null } });
        let finalInput = input;
        if (step.ask) {
          const request: PermissionRequest = {
            id: nextId("perm"),
            sessionId,
            kind: step.kind ?? (step.tool === "ExitPlanMode" ? "plan" : step.tool === "AskUserQuestion" ? "question" : "tool"),
            toolName: step.tool,
            toolUseId,
            input,
            title: step.title ?? `Claude wants to use ${step.tool}`,
            description: null,
            canAlwaysAllow: true,
            defaultToDeny: false,
            createdAt: at(),
          };
          pending.set(request.id, request);
          const answered = new Promise<PermissionAnswer | null>((resolve) => waiters.set(request.id, resolve));
          emit({ type: "permission.request", request });
          emit({ type: "state", state: "waiting" });
          const answer = await answered;
          if (closed) return "stop";
          emit({ type: "state", state: "running" });
          if (!answer || answer.behavior === "deny") {
            const msg = answer?.behavior === "deny" && answer.message ? answer.message : "The user denied this.";
            emit({ type: "tool.result", toolUseId, result: toolResult(false, msg) });
            return answer === null || (answer.behavior === "deny" && answer.interrupt) ? "stop" : "ok";
          }
          if (answer.updatedInput) finalInput = answer.updatedInput;
        }
        if (step.tool === "TodoWrite" && Array.isArray(finalInput.todos)) emit({ type: "todos", todos: finalInput.todos as Todo[] });
        emit({ type: "tool.result", toolUseId, result: toolResult(step.ok ?? true, step.result ?? `${step.tool} done`) });
      } else if ("hostTool" in step) {
        const tool = opts.hostTools?.find((t) => t.name === step.hostTool);
        const server = tool?.server ?? ODIN_MCP_SERVER;
        const toolUseId = nextId("toolu");
        emit({
          type: "entry",
          entry: { kind: "tool", id: toolUseId, name: `mcp__${server}__${step.hostTool}`, input: step.input, at: at(), parentToolUseId: null },
        });
        let out: import("./types.ts").HostToolResult;
        try {
          out = tool ? boundHostToolResult(await tool.handler(step.input)) : { text: `no host tool ${step.hostTool}`, isError: true };
        } catch (err) {
          out = { text: "Odin host tool failed", isError: true };
        }
        emit({ type: "tool.result", toolUseId, result: toolResult(!out.isError, hostResultSummary(out)) });
      } else if ("usage" in step) {
        const u = step.usage;
        emit({
          type: "usage",
          model: step.model ?? handle.model,
          usage: { input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0 },
          cumulative: false,
          costUsd: step.costUsd ?? null,
          contextTokens: step.contextTokens ?? null,
        });
      } else if ("todos" in step) {
        emit({ type: "todos", todos: step.todos });
      } else if ("emit" in step) {
        emit(step.emit);
      } else if ("wait" in step) {
        await (typeof step.wait === "number" ? new Promise((r) => setTimeout(r, step.wait as number)) : step.wait);
      } else if ("fail" in step) {
        fail(step.fail);
        return "stop";
      }
      return closed ? "stop" : "ok";
    }

    async function runTurn(message: UserMessage): Promise<void> {
      const started = Date.now();
      interrupted = false;
      emit({ type: "state", state: "running" });
      emit({ type: "entry", entry: { kind: "user", id: nextId("user"), text: message.text, at: at(), parentToolUseId: null } });
      let ok = true;
      for (const step of script(message, turn, opts)) {
        if (interrupted || closed) {
          ok = !interrupted;
          break;
        }
        if ((await runStep(step)) === "stop") {
          ok = false;
          break;
        }
      }
      turn++;
      if (closed) return;
      emit({ type: "turn.end", durationMs: Date.now() - started, ok: ok && !interrupted, error: interrupted ? "interrupted" : null });
      emit({ type: "state", state: "idle" });
    }

    async function pump(): Promise<void> {
      if (busy) return;
      busy = true;
      try {
        while (inbox.length && !closed) await runTurn(inbox.shift()!);
      } finally {
        busy = false;
      }
    }

    handles.set(sessionId, handle);
    // Like a real driver: init comes first, asynchronously.
    queueMicrotask(() => {
      emit({
        type: "init",
        sessionId,
        model: handle.model,
        permissionMode: handle.permissionMode,
        cwd: opts.cwd,
        tools: ["Read", "Write", "Edit", "Bash", ...(opts.hostTools ?? []).map((t) => `mcp__${t.server ?? ODIN_MCP_SERVER}__${t.name}`)],
        slashCommands: [
          { name: "compact", description: "Summarize the conversation so far", argumentHint: "<instructions>", source: "builtin" },
          { name: "review", description: "Review the current changes", argumentHint: "", source: "custom" },
        ],
        agents: Object.keys(opts.agents ?? {}),
      });
      if (opts.prompt) handle.send(opts.prompt);
      else emit({ type: "state", state: "idle" });
    });
    return handle;
  }

  const findStored = (sessionId: string) => store.get(sessionId) ?? null;

  return {
    id,
    name: "Fake harness",
    starts,
    handles,
    answers,
    async check() {
      return options.available === false ? { available: false, note: "fake harness switched off" } : { available: true, note: "fake harness (no model calls)" };
    },
    start: startHandle,
    async list(projectPath) {
      return [...store.values()]
        .filter((s) => s.info.cwd === projectPath || (s.info.cwd ?? "").startsWith(projectPath.replace(/\/$/, "") + "/"))
        .map((s) => ({ ...s.info }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async info(sessionId) {
      const s = findStored(sessionId);
      return s ? { ...s.info } : null;
    },
    async messages(sessionId) {
      return findStored(sessionId)?.entries.map((e) => ({ ...e })) ?? [];
    },
    async taskMessages(sessionId, task) {
      const parent = findStored(sessionId);
      if (!parent?.entries.some(e => e.kind === "task" && e.task.taskId === task.taskId && e.task.runId === task.runId))
        return { status: "unavailable", reason: "Unknown task." };
      const child = task.childSessionId ? findStored(task.childSessionId) : null;
      return child
        ? { status: "available", transcript: child.entries.map(e => ({ ...e })) }
        : { status: "unavailable", reason: "Child history is unavailable." };
    },
    async rename(sessionId, title) {
      const s = findStored(sessionId);
      if (!s) throw new Error(`unknown session ${sessionId}`);
      s.info.title = title;
    },
    async fork(sessionId) {
      const s = findStored(sessionId);
      if (!s) throw new Error(`unknown session ${sessionId}`);
      const newId = randomUUID();
      store.set(newId, { info: { ...s.info, sessionId: newId, createdAt: now().toISOString(), updatedAt: now().toISOString() }, entries: s.entries.map((e) => ({ ...e })) });
      return newId;
    },
    async delete(sessionId) {
      store.delete(sessionId);
    },
    async models(): Promise<ModelInfo[]> {
      return [
        { value: "default", displayName: "Default", description: "The harness default", resolved: options.model ?? DEFAULT_MODEL },
        { value: "fast", displayName: "Fast", description: "A cheaper fake model", resolved: "claude-fake-fast" },
      ];
    },
    setScript(s) {
      script = s;
    },
    seed(info, entries = []) {
      const t = now().toISOString();
      store.set(info.sessionId, {
        info: { title: "External session", firstPrompt: null, gitBranch: null, createdAt: t, updatedAt: t, ...info },
        entries,
      });
    },
    stored(sessionId) {
      return findStored(sessionId)?.entries ?? null;
    },
  };
}

/** Collects a handle's events until `until` matches (inclusive) or the handle exits. For tests. */
export async function eventsUntil(handle: SessionHandle, until: (e: HarnessEvent) => boolean, timeoutMs = 2000): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  const it = handle.events[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`timed out; got ${out.map((e) => e.type).join(",")}`);
    const r = await Promise.race([it.next(), new Promise<"timeout">((res) => setTimeout(() => res("timeout"), left))]);
    if (r === "timeout") throw new Error(`timed out; got ${out.map((e) => e.type).join(",")}`);
    if (r.done) return out;
    out.push(r.value);
    if (until(r.value)) return out;
  }
}
