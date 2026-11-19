import { readRegularFile, resolveInside } from "../library/files.ts";
// SessionsService: session records, live harness handles, discovery of external sessions. docs/contracts.md#sessions.
//
// A record exists for every harness session Odin knows. Live handles sit in a registry (id → handle, open
// prompts, todos, the completed transcript entries since the handle opened); one consumer loop per handle folds each
// harness event into the record, hands it to ingest and listeners, and fans it out as `session.event`.
import { randomUUID } from "node:crypto";
import { resolve, sep } from "node:path";
import type { SQLInputValue } from "node:sqlite";
import type {
  Checkpoint, ForkSessionRequest, HandoffPreview, HandoffRequest, PermissionAnswer, PermissionMode, Session, SessionCounts, SessionDetail, SessionHandoff, SessionFilter, SessionMetrics,
  SessionState, StartSessionRequest, Todo, UpdateSessionRequest, UserMessage, Workspace,
} from "@odin/shared/api";
import type { HarnessEvent, PermissionRequest, SessionGoal, SlashCommand, TranscriptEntry } from "@odin/shared/harness";
import { emptyMetrics, sessionBranch } from "@odin/shared/session";
import { findModel } from "@odin/shared/api";
import { applyHarnessEvent, reconcileTaskHistory } from "@odin/shared/transcript";
import { HttpError } from "../http/util.ts";
import { PERMISSION_MODES } from "../launch/service.ts";
import type { Harness, SessionHandle, StartOptions } from "../harness/types.ts";
import type { Deps, ExternalSessionInput, Services, SessionPatch, SessionsService } from "../services.ts";
import { messageOutbox } from "./message-queue.ts";
import { validateMessage } from "./message.ts";
import { runtimeOptions, nativeAction } from "./native.ts";
import { runShell, SHELL_MAX_COMMAND } from "./shell.ts";
import { hostToolApprovals } from "./host-tools.ts";
import { buildBrief } from "./handoff.ts";
import { git, statusPaths } from "../projects/git.ts";

export const IDLE_CLOSE_MS = 10 * 60_000;
const SESSION_STATES: SessionState[] = ["idle", "running", "waiting", "ended", "failed"];
const ORIGINS = ["odin", "external"] as const;
/** Titles that mean "no name yet": Odin's and the harness drivers' fallbacks. */
const PLACEHOLDER_TITLES = new Set(["Untitled session", "Untitled"]);

export interface SessionsOptions {
  /** Live handles idle this long are closed (the session stays resumable). Default 10 minutes. */
  idleCloseMs?: number;
}

interface SessionRow {
  effort: import("@odin/shared/api").Effort | null;
  id: string;
  harness: string;
  project: string;
  projects: string;
  title: string;
  first_prompt: string | null;
  tags: string;
  pinned: number;
  archived: number;
  origin: "odin" | "external";
  state: SessionState;
  waiting_for: "permission" | "question" | null;
  cwd: string;
  workspace: string;
  branch: string | null;
  model: string | null;
  permission_mode: string | null;
  agent: string | null;
  agent_version: string | null;
  template_id: string | null;
  parent_id: string | null;
  handoff: string | null;
  aside: number;
  pull: string | null;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
  error: string | null;
  metrics: string;
  slash_commands: string | null;
  launch_config: string | null;
}

interface Live {
  id: string;
  harness: Harness;
  handle: SessionHandle;
  pending: Map<string, PermissionRequest>;
  todos: Todo[] | null;
  goal: SessionGoal | null;
  /** From the handle's `init` or `commands` (null until one arrives). */
  slashCommands: SlashCommand[] | null;
  /** Entries since the handle opened, including partial text for clients reconnecting mid-turn. */
  tail: TranscriptEntry[];
  /** How many leading `tail` entries belong to finished turns (for harnesses whose history replaces the tail). */
  settled: number;
  streaming: Set<string>;
  idleTimer: NodeJS.Timeout | null;
  /** close() was called on the handle; it no longer takes messages. */
  closing: boolean;
  /** The close was an explicit end: the record becomes `ended`. */
  ending: boolean;
  turnActive: boolean;
  /** The harness has produced output (reply, tool call, prompt) for the current turn, so the message was acted on. */
  acted: boolean;
  /** This interrupt was a send-now: complete the in-flight receipt and dispatch the next queued message. */
  releaseNext: boolean;
  /** The queue was paused. After one message is handed off, pause again. */
  pauseAfterRelease: boolean;
  done: Promise<void>;
}

function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function toSession(r: SessionRow): Session {
  return {
    runtimeOptions: parseJson<{ runtimeOptions?: import("@odin/shared/api").RuntimeOptions }>(r.launch_config, {}).runtimeOptions,
    id: r.id,
    harness: r.harness,
    project: r.project,
    projects: parseJson<string[]>(r.projects, []).length ? parseJson<string[]>(r.projects, []) : [r.project],
    title: r.title,
    tags: parseJson<string[]>(r.tags, []),
    pinned: !!r.pinned,
    archived: !!r.archived,
    origin: r.origin,
    state: r.state,
    waitingFor: r.waiting_for,
    cwd: r.cwd,
    workspace: parseJson<Workspace>(r.workspace, { kind: "checkout" }),
    branch: r.branch,
    model: r.model,
    effort: r.effort,
    permissionMode: (r.permission_mode as PermissionMode | null) ?? null,
    agent: r.agent,
    agentVersion: r.agent_version,
    templateId: r.template_id,
    parentId: r.parent_id,
    handoff: parseJson<SessionHandoff | null>(r.handoff, null),
    aside: r.aside === 1,
    pull: parseJson(r.pull, null),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    endedAt: r.ended_at,
    error: r.error,
    metrics: { ...emptyMetrics(), ...parseJson<Partial<SessionMetrics>>(r.metrics, {}) },
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function bad(message: string): never {
  throw new HttpError(400, message);
}

/** Stored entries plus the live tail, merged by id (a live entry replaces the stored one; a result already there stays). */
export function mergeTranscript(stored: TranscriptEntry[], tail: TranscriptEntry[]): TranscriptEntry[] {
  let out = stored;
  for (const entry of tail) out = applyHarnessEvent(out, { type: "entry", entry });
  return out;
}

/** Harnesses whose on-disk history has different ids than their live entries (Grok). Their finished turns come from history only. */
const HISTORY_REPLACES_TAIL = new Set(["grok"]);

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** True when stored history already holds the finished-turn live entries (tools by id, assistant text by content). */
export function historyCovers(stored: TranscriptEntry[], finished: TranscriptEntry[]): boolean {
  const toolIds = new Set(stored.flatMap(e => e.kind === "tool" ? [e.id] : []));
  const said = squash(stored.flatMap(e => e.kind === "assistant" ? [e.text] : []).join(" "));
  return finished.every(e => e.kind === "tool" ? toolIds.has(e.id) : e.kind === "assistant" ? squash(e.text) === "" || said.includes(squash(e.text)) : true);
}

/** Stored entries up to and including the last user entry, then the in-flight live entries. */
export function mergeInFlight(stored: TranscriptEntry[], inFlight: TranscriptEntry[]): TranscriptEntry[] {
  if (!inFlight.length) return stored;
  let cut = stored.length;
  for (let i = stored.length - 1; i >= 0; i--) if (stored[i]!.kind === "user") { cut = i + 1; break; }
  return mergeTranscript(stored.slice(0, cut), inFlight);
}

/** The latest todo list in a transcript, or empty. Grok names the tool `todo_write`. */
export function todosFromTranscript(entries: TranscriptEntry[]): Todo[] {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.kind !== "tool" || (e.name !== "TodoWrite" && e.name !== "todo_write") || !Array.isArray(e.input.todos)) continue;
    const rows = e.input.todos;
    const todos = rows.filter((item): item is Todo => {
      if (!item || typeof item !== "object") return false;
      const row = item as { content?: unknown; status?: unknown };
      return typeof row.content === "string" && (row.status === "pending" || row.status === "in_progress" || row.status === "completed");
    });
    // Grok's `todo_write` also sends status-only merges (rows without content): look further back for the list.
    // A genuinely empty TodoWrite list clears the plan, so it ends the search with no todos.
    if (todos.length || rows.length === 0) return todos;
  }
  return [];
}

/** Stored `sessions.slash_commands`: `SlashCommand[]`, or bare names from before commands carried details. */
function parseSlashCommands(list: unknown): SlashCommand[] {
  if (!Array.isArray(list)) return [];
  const out: SlashCommand[] = [];
  for (const c of list) {
    if (typeof c === "string") out.push({ name: c.replace(/^\//, ""), description: "", argumentHint: "", source: "custom" });
    else if (c && typeof c === "object" && typeof (c as SlashCommand).name === "string") out.push(c as SlashCommand);
  }
  return out;
}

/** `Side: <first 60 chars of the prompt>`, on one line, with an ellipsis when cut. */
export function sideTitle(prompt: UserMessage): string {
  const text = prompt.text.replace(/\s+/g, " ").trim();
  if (!text) return "Side question";
  return `Side: ${text.length > 60 ? `${text.slice(0, 60).trimEnd()}…` : text}`;
}

function validateAnswer(answer: unknown): PermissionAnswer {
  const a = answer as PermissionAnswer | null;
  if (!a || typeof a !== "object") bad("invalid answer");
  if (a.behavior === "allow") {
    if (!["once", "session", "project", "local", "user"].includes(a.scope)) bad("invalid scope");
    if (a.updatedInput !== undefined && (typeof a.updatedInput !== "object" || a.updatedInput === null || Array.isArray(a.updatedInput))) bad("updatedInput must be an object");
    return a.updatedInput ? { behavior: "allow", scope: a.scope, updatedInput: a.updatedInput } : { behavior: "allow", scope: a.scope };
  }
  if (a.behavior === "deny") {
    if (a.message !== undefined && typeof a.message !== "string") bad("message must be a string");
    if (a.interrupt !== undefined && typeof a.interrupt !== "boolean") bad("interrupt must be a boolean");
    return { behavior: "deny", ...(a.message !== undefined ? { message: a.message } : {}), ...(a.interrupt !== undefined ? { interrupt: a.interrupt } : {}) };
  }
  bad("behavior must be allow or deny");
}

export function createSessionsService(deps: Deps, services: Services, options: SessionsOptions = {}): SessionsService {
  const { db, bus } = deps;
  const idleCloseMs = options.idleCloseMs ?? IDLE_CLOSE_MS;
  const now = () => deps.now().toISOString();
  const live = new Map<string, Live>();
  const updatedListeners = new Set<(s: Session) => void>();
  const eventListeners = new Set<(id: string, e: HarnessEvent) => void>();
  let closed = false;
  const outbox = messageOutbox(db, now, (sessionId, queue) => bus.emit({ type: "session.queue", sessionId, queue }));
  outbox.recover();
  const pumping = new Set<string>();
  const nativeBusy = new Set<string>();
  const shellBusy = new Set<string>();
  const approvals = hostToolApprovals({
    session: id => get(id),
    request(id, request) {
      const l = live.get(id);
      if (!l || l.closing) { approvals.cancel(id); return; }
      dispatch(l, { type: "permission.request", request });
      patchAndEmit(id, { state: "waiting", waitingFor: "permission" });
    },
    resolved(id, requestId) {
      const l = live.get(id);
      if (!l || l.closing) return;
      dispatch(l, { type: "permission.resolved", requestId, behavior: "cancelled" });
      if (!l.pending.size) patchAndEmit(id, { state: "running", waitingFor: null });
    },
  });

  // Boot recovery: nothing is live after a restart.
  db.prepare("UPDATE sessions SET state = 'idle', waiting_for = NULL WHERE state IN ('running', 'waiting')").run();

  const row = (id: string) => db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  const get = (id: string): Session | null => {
    const r = row(id);
    return r ? toSession(r) : null;
  };
  const mustGet = (id: string): Session => {
    const s = get(id);
    if (!s) throw new HttpError(404, `unknown session ${id}`);
    return s;
  };

  function emitUpdated(s: Session): void {
    bus.emit({ type: "session.updated", session: s });
    for (const l of updatedListeners) {
      try {
        l(s);
      } catch (err) {
        console.error("sessions.onUpdated listener failed:", err);
      }
    }
  }

  function harnessFor(s: { harness: string }): Harness {
    const h = deps.harnesses[s.harness];
    if (!h) throw new HttpError(400, `harness ${s.harness} is not available`);
    return h;
  }

  function messageFor(id: string, message: unknown): UserMessage {
    if (nativeBusy.has(id)) throw new HttpError(409, "a native session operation is in progress");
    const s = mustGet(id);
    const msg = validateMessage(message);
    if (msg.attachments?.length && harnessFor(s).capabilities?.attachments === false) bad(`${s.harness} does not support attachments`);
    return msg;
  }

  async function savedMcp(id: string): Promise<StartOptions["mcpServers"]> {
    const config = parseJson<{ mcpIds?: string[] }>(row(id)?.launch_config ?? null, {});
    return config.mcpIds?.length ? services.launch.resolveMcpServers(config.mcpIds, { skipDisabled: true }) : undefined;
  }

  const COLUMNS: Record<string, string> = {
    effort: "effort", title: "title", state: "state", waitingFor: "waiting_for", model: "model", permissionMode: "permission_mode", agent: "agent",
    branch: "branch", error: "error", endedAt: "ended_at", updatedAt: "updated_at",
  };

  /** Writes record fields (no emit). Returns whether anything changed. */
  function write(id: string, patch: SessionPatch & { tags?: string[]; pinned?: boolean; archived?: boolean; aside?: boolean; projects?: string[] }): boolean {
    const cur = row(id);
    if (!cur) throw new HttpError(404, `unknown session ${id}`);
    const sets: string[] = [];
    const args: SQLInputValue[] = [];
    const set = (col: string, value: SQLInputValue) => {
      if ((cur as unknown as Record<string, unknown>)[col] === value) return;
      sets.push(`${col} = ?`);
      args.push(value);
    };
    for (const [key, col] of Object.entries(COLUMNS)) {
      const v = (patch as Record<string, unknown>)[key];
      if (v !== undefined) set(col, v as SQLInputValue);
    }
    if (patch.pull !== undefined) set("pull", patch.pull === null ? null : JSON.stringify(patch.pull));
    if (patch.tags !== undefined) set("tags", JSON.stringify(patch.tags));
    if (patch.pinned !== undefined) set("pinned", patch.pinned ? 1 : 0);
    if (patch.archived !== undefined) set("archived", patch.archived ? 1 : 0);
    if (patch.aside !== undefined) set("aside", patch.aside ? 1 : 0);
    if (patch.projects !== undefined) set("projects", JSON.stringify(patch.projects));
    if (patch.metrics !== undefined) set("metrics", JSON.stringify({ ...parseJson<object>(cur.metrics, {}), ...patch.metrics }));
    if (!sets.length) return false;
    if (patch.updatedAt === undefined && !sets.some((s) => s.startsWith("metrics"))) {
      sets.push("updated_at = ?");
      args.push(now());
    }
    db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
    return true;
  }

  function patchAndEmit(id: string, patch: Parameters<typeof write>[1]): Session {
    const changed = write(id, patch);
    const s = mustGet(id);
    if (changed) emitUpdated(s);
    return s;
  }

  interface NewRecord {
    id: string;
    harness: string;
    project: string;
    projects?: string[];
    title: string;
    firstPrompt: string | null;
    tags: string[];
    origin: "odin" | "external";
    state: SessionState;
    cwd: string;
    workspace: Workspace;
    branch: string | null;
    model: string | null;
    permissionMode: PermissionMode | null;
    agent: string | null;
    agentVersion: string | null;
    templateId: string | null;
    parentId: string | null;
    /** A side thread (default false). */
    aside?: boolean;
    handoff?: SessionHandoff;
    createdAt: string;
    updatedAt: string;
    launchConfig?: string | null;
  }

  function insert(r: NewRecord & { effort?: import("@odin/shared/api").Effort | null }): Session {
    db.prepare(
      `INSERT INTO sessions (id, harness, project, title, first_prompt, tags, origin, state, cwd, workspace, branch, model, permission_mode,
        agent, agent_version, template_id, parent_id, aside, created_at, updated_at, metrics, projects, launch_config, handoff)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      r.id, r.harness, r.project, r.title, r.firstPrompt, JSON.stringify(r.tags), r.origin, r.state, r.cwd, JSON.stringify(r.workspace), r.branch,
      r.model, r.permissionMode, r.agent, r.agentVersion, r.templateId, r.parentId, r.aside ? 1 : 0, r.createdAt, r.updatedAt, JSON.stringify(emptyMetrics()),
      JSON.stringify(r.projects ?? [r.project]), r.launchConfig ?? null, r.handoff ? JSON.stringify(r.handoff) : null,
    );
    if (r.effort) db.prepare("UPDATE sessions SET effort = ? WHERE id = ?").run(r.effort, r.id);
    const s = mustGet(r.id);
    emitUpdated(s);
    return s;
  }

  function currentBranch(project: string): string | null {
    try {
      return services.projects.detail(project)?.git.branch ?? null;
    } catch {
      return null;
    }
  }

  function workspaceFor(cwd: string, branch: string | null): Workspace {
    const root = resolve(deps.config.worktreesDir) + sep;
    const abs = resolve(cwd);
    return abs.startsWith(root) && branch ? { kind: "worktree", path: abs, branch } : { kind: "checkout" };
  }

  function applyInstructions(s: Session, opts: StartOptions): void {
    opts.runtimeOptions = s.runtimeOptions;
    if (s.projects.length > 1 && harnessFor(s).capabilities?.additionalDirectories === false) bad(`${s.harness} does not support additional project directories`);
    if (opts.prompt?.attachments?.length && harnessFor(s).capabilities?.attachments === false) bad(`${s.harness} does not support attachments`);
    const global = services.library.get("instruction", "global");
    if (global?.error) throw new HttpError(400, "Global AGENTS.md has errors: " + global.error);
    const parts = [global?.enabled === false ? "" : (services.library.files("instruction", "global")?.["AGENTS.md"] ?? "")];
    const additional = s.projects.filter(name => name !== s.project).map(name => {
      const project = services.projects.get(name);
      if (!project || project.missing) throw new HttpError(409, `project ${name} is unavailable`);
      return project;
    });
    opts.additionalDirectories = additional.map(p => p.path);
    if (additional.length) {
      parts.push("Configured repositories (working repository first):\n" +
        [`${s.project}: ${opts.cwd}`, ...additional.map(p => `${p.name}: ${p.path}`)].join("\n"));
      for (const p of additional) {
        const instructions = readRegularFile(resolveInside(p.path, "AGENTS.md"));
        if (instructions) parts.push(`Instructions for ${p.name} (${p.path}):\n${instructions}`);
      }
    }
    // Codex reads project AGENTS.md natively. Claude keeps native CLAUDE.md and receives AGENTS.md as well.
    if (s.harness === "claude") {
      const project = readRegularFile(resolveInside(opts.cwd, "AGENTS.md"));
      if (project) parts.push(project);
    }
    parts.push(
      "Odin analysis instructions: use notebook_list, notebook_open (existing .ipynb) or notebook_create (new .ipynb at a project-relative path) to get a notebook backed by an ordinary project file, " +
      "notebook_execute to run code as persistent notebook cells, and notebook_status/notebook_wait/notebook_interrupt for long runs. " +
      "A shared kernel keeps its original working directory and interpreter even when you attach from a fork or worktree; inspect those before running code. " +
      "Notebook execution and variable/dataframe inspection require execution permission. If its Python environment is missing, ask the user to use the notebook setup action. " +
      "For reports, call post_artifact with self-contained HTML and inline charts. For slides, produce an HTML deck with print CSS and page breaks; Odin exports it to PDF. " +
      "If notebook tools are unavailable in an imported session, state that limitation rather than claiming code ran in a kernel."
    );
    parts.push(
      "Odin preview instructions (host UI): This session runs in Odin/Odin. " +
      "To show an HTML preview, mockup, chart or interactive visualization in the preview panel, call the available post_artifact tool " +
      "with a title and a complete, self-contained HTML document, inlining CSS, JavaScript and images. " +
      "For revisions, reuse the returned artifact_id. These host UI instructions override any skill's output or rendering instructions, " +
      "including the Visualize skill: do not emit visualize content references or rely on a local HTML path to display a preview. " +
      "Use window.odin.submit(data) for user answers and window.odin.theme for theme tokens; external resources cannot load. " +
      "If post_artifact is unavailable, explain that the preview cannot be displayed in this session and provide the saved file path instead."
    );
    opts.instructions = parts.filter(Boolean).join("\n\n");
  }

  function hostTools(id: string) {
    const tools = [];
    try {
      tools.push(...services.artifacts.hostTools(id));
    } catch (err) {
      console.error("artifacts.hostTools failed:", errorMessage(err));
    }
    tools.push(...services.notebooks.hostTools(id));
    return tools.map(tool => approvals.wrap(id, tool));
  }

  /** The session's last reported slash commands, else the newest ones reported in its project. */
  function storedSlashCommands(id: string, project: string): SlashCommand[] {
    const own = db.prepare("SELECT slash_commands FROM sessions WHERE id = ?").get(id) as { slash_commands: string | null } | undefined;
    const text = own?.slash_commands
      ?? (db.prepare("SELECT slash_commands FROM sessions WHERE project = ? AND slash_commands IS NOT NULL ORDER BY updated_at DESC LIMIT 1")
        .get(project) as { slash_commands: string } | undefined)?.slash_commands
      ?? null;
    return parseSlashCommands(parseJson<unknown>(text, []));
  }

  // ── live handles ─────────────────────────────────────────────────────────

  function clearIdle(l: Live): void {
    if (l.idleTimer) clearTimeout(l.idleTimer);
    l.idleTimer = null;
  }

  function armIdle(l: Live): void {
    clearIdle(l);
    if (closed) return;
    l.idleTimer = setTimeout(() => {
      l.idleTimer = null;
      void closeHandle(l, false);
    }, idleCloseMs);
    l.idleTimer.unref?.();
  }

  async function closeHandle(l: Live, ending: boolean): Promise<void> {
    approvals.cancel(l.id);
    if (ending) outbox.pause(l.id);
    if (ending) l.ending = true;
    clearIdle(l);
    if (!l.closing) {
      l.closing = true;
      try {
        await l.handle.close();
      } catch (err) {
        console.error(`closing session ${l.id} failed:`, errorMessage(err));
      }
    }
    await l.done;
  }

  /** Record-level effects of one harness event. */
  function applyToRecord(l: Live, e: HarnessEvent): void {
    const cur = row(l.id);
    if (!cur) return;
    switch (e.type) {
      case "commands":
        l.slashCommands = e.slashCommands;
        db.prepare("UPDATE sessions SET slash_commands = ? WHERE id = ?").run(JSON.stringify(e.slashCommands), l.id);
        break;
      case "init": {
        l.slashCommands = e.slashCommands;
        db.prepare("UPDATE sessions SET slash_commands = ? WHERE id = ?").run(JSON.stringify(e.slashCommands), l.id);
        const p: SessionPatch = {};
        if (e.model) p.model = e.model;
        if (e.permissionMode) p.permissionMode = e.permissionMode;
        patchAndEmit(l.id, p);
        break;
      }
      case "state": {
        if (e.state === "running" && l.pending.size) e = { ...e, state: "waiting" };
        if (e.state === "idle") armIdle(l);
        else clearIdle(l);
        let waitingFor: Session["waitingFor"] = null;
        if (e.state === "waiting") {
          const open = [...l.pending.values()];
          waitingFor = open.some((r) => r.kind === "question") ? "question" : "permission";
        }
        patchAndEmit(l.id, { state: e.state, waitingFor, error: e.state === "running" ? null : cur.error, endedAt: null });
        if (e.state === "idle" && !l.turnActive) queueMicrotask(() => { void pumpQueue(l.id); });
        break;
      }
      case "permission.request":
        l.acted = true;
        l.pending.set(e.request.id, e.request);
        break;
      case "permission.resolved":
        l.pending.delete(e.requestId);
        // The last prompt closed: the session is working again, whether or not the driver's own `running` follows
        // (a harness that doesn't send one, or one dropped as unchanged, must not leave "needs you" showing).
        if (!l.pending.size && cur.state === "waiting") patchAndEmit(l.id, { state: "running", waitingFor: null });
        else if (cur.state === "waiting" && l.pending.size) patchAndEmit(l.id, { waitingFor: [...l.pending.values()].some((r) => r.kind === "question") ? "question" : "permission" });
        break;
      case "todos":
        l.todos = e.todos;
        break;
      case "goal":
        l.goal = e.goal;
        break;
      case "delta":
        l.acted = true;
        l.streaming.add(e.entryId);
        l.tail = applyHarnessEvent(l.tail, e);
        patchAndEmit(l.id, { updatedAt: now() });
        break;
      case "entry":
        if (e.entry.kind !== "user") l.acted = true;
        else if (!e.entry.parentToolUseId) void services.checkpoints.capture(l.id, "turn.start", e.entry.id);
        l.streaming.delete(e.entry.id);
        l.tail = applyHarnessEvent(l.tail, e);
        patchAndEmit(l.id, { updatedAt: now() });
        break;
      case "task":
        l.acted = true;
        l.tail = applyHarnessEvent(l.tail, e);
        patchAndEmit(l.id, { updatedAt: now() });
        break;
      case "tool.result":
        l.tail = applyHarnessEvent(l.tail, e);
        break;
      case "model":
        patchAndEmit(l.id, { model: e.model });
        break;
      case "permission.mode":
        patchAndEmit(l.id, { permissionMode: e.mode });
        break;
      case "turn.end":
        void services.checkpoints.capture(l.id, "turn.end", null);
        l.streaming.clear();
        l.turnActive = false;
        l.settled = l.tail.length;
        if (HISTORY_REPLACES_TAIL.has(l.harness.id)) void trimSettled(l);
        if (l.releaseNext && (e.ok || e.error === "interrupted")) {
          l.releaseNext = false;
          outbox.settle(l.id, true);
        } else if (e.error === "interrupted") {
          // A stop. If the agent already acted on the message it is part of the conversation: done, not uncertain.
          // If the stop beat the agent, the message goes back to the queue (paused) to edit, resend or cancel.
          l.releaseNext = false;
          l.pauseAfterRelease = false;
          if (l.acted) outbox.settle(l.id, true);
          else { outbox.requeue(l.id); outbox.pause(l.id); }
        } else {
          l.releaseNext = false;
          l.pauseAfterRelease = false;
          outbox.settle(l.id, e.ok);
          if (!e.ok) outbox.pause(l.id);
        }
        patchAndEmit(l.id, { updatedAt: now(), error: e.ok || e.error === "interrupted" ? null : e.error });
        void services.metrics.refreshOutput(l.id).catch((err: unknown) => console.error(`metrics.refreshOutput(${l.id}) failed:`, errorMessage(err)));
        break;
      case "exit":
        finish(l, e.outcome === "failed" ? (e.error ?? "the harness exited") : null);
        break;
      default:
        break;
    }
  }

  /** Drop finished-turn entries from the tail once history holds them, so only the in-flight turn stays live. */
  async function trimSettled(l: Live): Promise<void> {
    const count = l.settled;
    if (!count) return;
    try {
      const stored = await l.harness.messages(l.id, get(l.id)?.cwd ?? "");
      if (l.settled === count && l.tail.length >= count && stored.length && historyCovers(stored, l.tail.slice(0, count))) {
        l.tail = l.tail.slice(count);
        l.settled = 0;
      }
    } catch {
      // History unreadable: the tail stays and detail() falls back to merging it.
    }
  }

  /** The handle is gone: unregister it and settle the record. */
  function finish(l: Live, failure: string | null): void {
    approvals.cancel(l.id);
    l.releaseNext = false;
    l.pauseAfterRelease = false;
    outbox.settle(l.id, false);
    if (failure || l.turnActive || l.ending) outbox.pause(l.id);
    clearIdle(l);
    l.pending.clear();
    l.streaming.clear();
    if (live.get(l.id) === l) live.delete(l.id);
    const cur = row(l.id);
    if (!cur) return;
    if (failure !== null) {
      patchAndEmit(l.id, { state: "failed", waitingFor: null, error: failure });
    } else if (l.ending) {
      if (cur.state !== "failed") patchAndEmit(l.id, { state: "ended", waitingFor: null, endedAt: now() });
    } else if (cur.state === "running" || cur.state === "waiting") {
      patchAndEmit(l.id, { state: "idle", waitingFor: null });
    }
  }

  function dispatch(l: Live, e: HarnessEvent): void {
    if (e.type === "delta") {
      const entryId = e.entryId;
      const entry = l.tail.find(entry => entry.id === entryId);
      const offset = entry?.kind === "assistant" || entry?.kind === "thinking" ? entry.text.length : 0;
      e = { ...e, offset };
    }
    try {
      applyToRecord(l, e);
    } catch (err) {
      console.error(`session ${l.id}: applying ${e.type} failed:`, errorMessage(err));
    }
    if (!row(l.id)) return; // deleted meanwhile
    try {
      services.ingest.recordHarnessEvent(l.id, e);
    } catch (err) {
      console.error(`ingest.recordHarnessEvent(${l.id}, ${e.type}) failed:`, errorMessage(err));
    }
    for (const listener of eventListeners) {
      try {
        listener(l.id, e);
      } catch (err) {
        console.error("sessions.onEvent listener failed:", err);
      }
    }
    bus.emit({ type: "session.event", sessionId: l.id, event: e });
  }

  function attach(id: string, harness: Harness, handle: SessionHandle, turnActive: boolean): Live {
    const l: Live = {
      id, harness, handle, pending: new Map(), todos: null, goal: null, slashCommands: null, tail: [], settled: 0, streaming: new Set(), idleTimer: null, closing: false, ending: false,
      done: Promise.resolve(),
      turnActive,
      acted: false,
      releaseNext: false,
      pauseAfterRelease: false,
    };
    live.set(id, l);
    l.done = (async () => {
      let exited = false;
      try {
        for await (const e of handle.events) {
          if (e.type === "exit") exited = true;
          dispatch(l, e);
          if (exited) break;
        }
        if (!exited) dispatch(l, { type: "exit", outcome: l.closing ? "closed" : "failed", error: l.closing ? null : "the harness stopped without exiting" });
      } catch (err) {
        if (!exited) dispatch(l, { type: "exit", outcome: "failed", error: errorMessage(err) });
      } finally {
        clearIdle(l);
        if (live.get(id) === l) live.delete(id);
      }
    })();
    return l;
  }

  /** The open handle for a session, after any handle that is closing has finished. */
  async function openHandle(id: string): Promise<Live | null> {
    const l = live.get(id);
    if (!l) return null;
    if (l.closing) {
      await l.done;
      return live.get(id) ?? null;
    }
    return l;
  }

  function startHandle(id: string, harness: Harness, opts: StartOptions): Live {
    let handle: SessionHandle;
    try {
      applyInstructions(mustGet(id), opts);
      handle = harness.start(opts);
    } catch (err) {
      const message = errorMessage(err);
      patchAndEmit(id, { state: "failed", waitingFor: null, error: message });
      throw new HttpError(502, `the harness failed to start: ${message}`);
    }
    return attach(id, harness, handle, !!opts.prompt);
  }

  async function pumpQueue(id: string): Promise<void> {
    if (closed || pumping.has(id) || nativeBusy.has(id)) return;
    pumping.add(id);
    try {
      const l = await openHandle(id);
      const s = get(id);
      if (!s || s.state === "waiting" || (l && (l.closing || l.turnActive || s.state !== "idle"))) return;
      let mcpServers: StartOptions["mcpServers"];
      const queue = outbox.snapshot(id);
      if (!l && !queue.paused && queue.messages.length && queue.messages.every(message => message.state === "queued")) {
        try { mcpServers = await savedMcp(id); }
        catch (err) {
          outbox.pause(id);
          patchAndEmit(id, { state: "failed", waitingFor: null, error: errorMessage(err) });
          return;
        }
      }
      const next = outbox.reserve(id);
      if (!next) {
        if (l) l.pauseAfterRelease = false;
        return;
      }
      const repause = !!l?.pauseAfterRelease;
      if (l) l.pauseAfterRelease = false;
      try {
        await services.checkpoints.capture(id, "turn.prepare", null);
        if (l) {
          l.turnActive = true;
          l.acted = false;
          clearIdle(l);
          patchAndEmit(id, { state: "running", waitingFor: null });
          l.handle.send(next.message);
        } else {
          const opts: StartOptions = { cwd: s.cwd, resume: id, prompt: next.message, hostTools: hostTools(id), mcpServers };
          if (s.model) opts.model = s.model;
          opts.effort = s.effort;
          if (s.permissionMode) opts.permissionMode = s.permissionMode;
          write(id, { state: "running", waitingFor: null, error: null, endedAt: null });
          startHandle(id, harnessFor(s), opts);
          emitUpdated(mustGet(id));
        }
        if (repause) outbox.pause(id);
      } catch {
        outbox.settle(id, false);
        outbox.pause(id);
        if (l) await closeHandle(l, false);
      }
    } finally { pumping.delete(id); }
  }

  // ── external sessions ────────────────────────────────────────────────────

  async function validateEffort(harness: import("../harness/types.ts").Harness, model: string | null | undefined, effort: unknown) {
    if (effort === undefined || effort === null) return;
    const models = await harness.models();
    const selected = findModel(models, model) ?? (!model ? models[0] : undefined);
    if (typeof effort !== "string" || !selected?.effortLevels?.includes(effort as import("@odin/shared/api").Effort)) bad(harness.id + " does not support effort " + String(effort) + " for this model");
  }

  function projectExists(name: string): boolean {
    return !!db.prepare("SELECT 1 FROM projects WHERE name = ?").get(name);
  }

  function importExternal(input: ExternalSessionInput & { createdAt?: string }): Session {
    const existing = get(input.id);
    if (existing) return existing;
    if (!projectExists(input.project)) throw new HttpError(404, `unknown project ${input.project}`);
    const branch = input.branch ?? null;
    const s = insert({
      id: input.id,
      harness: input.harness,
      project: input.project,
      title: input.title?.trim() || "Untitled session",
      firstPrompt: null,
      tags: [],
      origin: "external",
      state: "idle",
      cwd: input.cwd,
      workspace: workspaceFor(input.cwd, branch),
      branch,
      model: input.model ?? null,
      permissionMode: null,
      agent: input.agent ?? null,
      agentVersion: null,
      templateId: null,
      parentId: null,
      createdAt: input.createdAt ?? input.at,
      updatedAt: input.at,
    });
    return s;
  }

  async function discover(project: string): Promise<number> {
    const p = services.projects.get(project);
    if (!p) throw new HttpError(404, `unknown project ${project}`);
    let added = 0;
    for (const [harnessId, harness] of Object.entries(deps.harnesses)) {
      let infos;
      try {
        infos = await harness.list(p.path);
      } catch (err) {
        console.error(`${harnessId}: listing sessions in ${project} failed:`, errorMessage(err));
        continue;
      }
      for (const info of infos) {
        const known = get(info.sessionId);
        if (known) {
          // Hook-created sessions start untitled; adopt the harness's generated name once it has one, unless
          // the user renamed the session (only placeholder or first-prompt fallback titles are replaced).
          const next = info.title?.trim().slice(0, 200);
          const placeholder = (t: string) => PLACEHOLDER_TITLES.has(t) || (!!info.firstPrompt && t === info.firstPrompt.trim().slice(0, 200));
          if (known.origin === "external" && next && !PLACEHOLDER_TITLES.has(next) && next !== known.title && placeholder(known.title)) {
            try {
              patchAndEmit(known.id, { title: next });
            } catch (err) {
              console.error(`retitling session ${known.id} failed:`, errorMessage(err));
            }
          }
          continue;
        }
        try {
          importExternal({
            id: info.sessionId,
            harness: harnessId,
            project,
            cwd: info.cwd ?? p.path,
            title: info.title,
            branch: info.gitBranch,
            at: info.updatedAt,
            createdAt: info.createdAt ?? info.updatedAt,
          });
          added++;
        } catch (err) {
          console.error(`importing session ${info.sessionId} failed:`, errorMessage(err));
        }
      }
    }
    return added;
  }

  const rescanTimer = deps.config.projectsRescanMs > 0
    ? setInterval(() => {
        void (async () => {
          for (const p of services.projects.list()) {
            if (closed) return;
            try {
              await discover(p.name);
            } catch (err) {
              console.error(`discovering sessions in ${p.name} failed:`, errorMessage(err));
            }
          }
        })();
      }, deps.config.projectsRescanMs)
    : null;
  rescanTimer?.unref?.();

  // ── handoff helpers ──────────────────────────────────────────────────────

  function handoffTarget(s: Session, harnessId: unknown): Harness {
    if (typeof harnessId !== "string" || !Object.hasOwn(deps.harnesses, harnessId)) bad(`unknown harness ${String(harnessId)}`);
    if (harnessId === s.harness) bad("choose a different harness than the session's own");
    return deps.harnesses[harnessId]!;
  }

  /** Changed paths and the diff summary of a working directory; empty outside git or when git fails. */
  async function gitFacts(cwd: string): Promise<{ files: string[]; diffStat: string }> {
    const [files, diffStat] = await Promise.all([
      statusPaths(cwd).catch(() => [] as string[]),
      git(cwd, ["diff", "--stat", "HEAD"]).catch(() => ""),
    ]);
    return { files, diffStat };
  }

  // ── the service ──────────────────────────────────────────────────────────

  const service: SessionsService = {
    list(filter: SessionFilter = {}) {
      const where: string[] = [];
      const args: SQLInputValue[] = [];
      if (filter.project) {
        where.push("(project = ? OR EXISTS (SELECT 1 FROM json_each(sessions.projects) WHERE value = ?))");
        args.push(filter.project);
        args.push(filter.project);
      }
      if (filter.state?.length) {
        where.push(`state IN (${filter.state.map(() => "?").join(", ")})`);
        args.push(...filter.state);
      }
      if (filter.tag) {
        where.push("EXISTS (SELECT 1 FROM json_each(sessions.tags) WHERE value = ?)");
        args.push(filter.tag);
      }
      if (filter.model) {
        where.push("model = ?");
        args.push(filter.model);
      }
      if (filter.origin) {
        where.push("origin = ?");
        args.push(filter.origin);
      }
      if (filter.q) {
        const like = `%${filter.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        where.push("(lower(title) LIKE ? ESCAPE '\\' OR lower(coalesce(first_prompt, '')) LIKE ? ESCAPE '\\')");
        args.push(like, like);
      }
      if (filter.archived !== undefined) {
        where.push("archived = ?");
        args.push(filter.archived ? 1 : 0);
      }
      if (filter.pinned !== undefined) {
        where.push("pinned = ?");
        args.push(filter.pinned ? 1 : 0);
      }
      if (filter.parentId !== undefined) {
        // Children of one session, side threads included.
        where.push("parent_id = ?");
        args.push(filter.parentId);
      } else {
        where.push(filter.aside === true ? "aside = 1" : "aside = 0");
      }
      if (filter.since) {
        where.push("updated_at >= ?");
        args.push(filter.since);
      }
      let sql = `SELECT * FROM sessions${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC, created_at DESC, id`;
      if (filter.limit !== undefined && filter.limit > 0) {
        sql += " LIMIT ?";
        args.push(Math.floor(filter.limit));
      }
      return (db.prepare(sql).all(...args) as unknown as SessionRow[]).map(toSession);
    },

    get,

    async taskMessages(id, key) {
      const detail = await this.detail(id);
      if (!detail) throw new HttpError(404, `unknown session ${id}`);
      const entry = detail.transcript.find(e => e.kind === "task" && e.id === key);
      if (!entry || entry.kind !== "task") throw new HttpError(404, "unknown session task");
      const harness = deps.harnesses[detail.harness];
      if (!harness?.taskMessages) return { status: "unavailable", reason: "This runtime does not provide child history." };
      try {
        return await harness.taskMessages(id, entry.task, detail.cwd);
      } catch {
        return { status: "unavailable", reason: "Child history could not be read. Try again." };
      }
    },

    async detail(id) {
      const s = get(id);
      if (!s) return null;
      let l = live.get(id);
      let stored: TranscriptEntry[] = [];
      const harness = deps.harnesses[s.harness];
      if (!l && s.origin === "external" && harness?.measurements) {
        try {
          const facts = await harness.measurements(id, s.cwd);
          // A resume may have attached while the native history was loading.
          if (facts !== null && !live.has(id)) services.ingest.replaceHistory(id, facts);
        } catch {
          // A missing/unreadable native measurement store must never prevent opening the conversation.
        }
      }
      if (harness) {
        try {
          stored = await harness.messages(id, s.cwd);
        } catch (err) {
          console.error(`reading the transcript of ${id} failed:`, errorMessage(err));
        }
      }
      l = live.get(id);
      let transcript: TranscriptEntry[];
      if (l && HISTORY_REPLACES_TAIL.has(s.harness) && l.tail.length) {
        const settled = Math.min(l.settled, l.tail.length);
        const base = reconcileTaskHistory(stored);
        const finished = l.turnActive ? l.tail.slice(0, settled) : l.tail;
        const covered = !finished.length || (stored.length > 0 && historyCovers(stored, finished));
        const inFlight = l.turnActive && covered ? l.tail.slice(settled) : covered ? [] : l.tail;
        transcript = mergeInFlight(base, inFlight);
      } else transcript = mergeTranscript(reconcileTaskHistory(stored), l?.tail ?? []);
      let artifacts: SessionDetail["artifacts"] = [];
      try {
        artifacts = services.artifacts.forSession(id);
      } catch {
        artifacts = [];
      }
      const active = l && !l.closing ? l : null;
      return {
        slashCommands: active?.slashCommands ?? storedSlashCommands(id, s.project),
        ...(get(id) ?? s),
        transcript,
        pending: active ? [...active.pending.values()] : [],
        todos: l?.todos ?? todosFromTranscript(transcript),
        goal: active?.goal ?? null,
        artifacts,
        live: !!active,
        streaming: active ? [...active.streaming] : [],
        messageQueue: outbox.snapshot(id),
      };
    },

    async nativeState(id) {
      const s = mustGet(id);
      const harness = harnessFor(s);
      if (!harness.nativeState) bad("runtime does not provide native session state");
      return harness.nativeState(id, s.cwd);
    },

    async shell(id, input) {
      const s = mustGet(id);
      const command = (input as { command?: unknown } | null)?.command;
      if (typeof command !== "string" || !command.trim()) bad("command must be a non-empty string");
      if ((command as string).length > SHELL_MAX_COMMAND) bad("command is too long");
      if (shellBusy.has(id)) throw new HttpError(409, "a command is already running in this session");
      shellBusy.add(id);
      try { return await runShell(s.cwd, command as string); } finally { shellBusy.delete(id); }
    },

    async nativeAction(id, input) {
      const s = mustGet(id);
      const harness = harnessFor(s);
      const action = nativeAction(input, harness.capabilities);
      if (nativeBusy.has(id) || s.state === "running" || s.state === "waiting" || live.get(id)?.turnActive || outbox.snapshot(id).messages.length) throw new HttpError(409, "native operations require an idle session with an empty message queue");
      nativeBusy.add(id);
      try {
        const l = await openHandle(id);
        if (!l?.handle.nativeAction) bad("runtime does not provide native operations");
        const result = await l.handle.nativeAction(action);
        if (action.type === "revert" || action.type === "unrevert" || action.type === "commitRevert") {
          l.tail = [];
          l.settled = 0;
          l.streaming.clear();
        }
        patchAndEmit(id, { updatedAt: now() });
        return result;
      } finally { nativeBusy.delete(id); }
    },

    async start(req: StartSessionRequest) {
      if (!req || typeof req !== "object") bad("invalid request");
      const harnessId: unknown = req.harness ?? services.settings.get().defaultHarness ?? "claude";
      if (typeof harnessId !== "string" || !Object.hasOwn(deps.harnesses, harnessId)) bad(`unknown harness ${String(harnessId)}`);
      const harness = deps.harnesses[harnessId]!;
      req = { ...req, harness: harnessId };
      const id = randomUUID();
      const plan = await services.launch.plan(req, id);
      const native = req.runtimeOptions === undefined ? undefined : runtimeOptions(req.runtimeOptions, harness.capabilities);
      await validateEffort(harness, plan.model, req.effort);
      const project = services.projects.get(req.project);
      if (!project) throw new HttpError(404, `unknown project ${req.project}`);
      if (project.missing) throw new HttpError(409, `project ${project.name} is missing on disk`);

      let cwd = project.path;
      let workspace: Workspace = { kind: "checkout" };
      let branch: string | null;
      if (plan.worktree) {
        const wt = await services.projects.createWorktree(project.name, plan.branch ?? sessionBranch(plan.title, id));
        cwd = wt.path;
        branch = wt.branch;
        workspace = { kind: "worktree", path: wt.path, branch: wt.branch };
      } else {
        branch = currentBranch(project.name);
      }
      const at = now();
      insert({
        id, harness: harnessId, project: project.name, projects: [...new Set([project.name, ...(req.projects ?? []).map(n => n.trim()).filter(Boolean)])], title: plan.title, firstPrompt: plan.prompt?.text ?? null, tags: plan.tags,
        origin: "odin", state: "running", cwd, workspace, branch, model: plan.model, effort: req.effort, permissionMode: plan.permissionMode,
        agent: null, agentVersion: null, templateId: null, parentId: null, createdAt: at, updatedAt: at,
        launchConfig: JSON.stringify({ mcpIds: Object.keys(plan.mcpServers), runtimeOptions: native }),
      });

      const opts: StartOptions = { cwd, sessionId: id, title: plan.title, hostTools: hostTools(id) };
      if (plan.prompt) opts.prompt = plan.prompt;
      if (plan.model) opts.model = plan.model;
      opts.effort = req.effort;
      if (plan.permissionMode) opts.permissionMode = plan.permissionMode;
      if (Object.keys(plan.mcpServers).length) opts.mcpServers = plan.mcpServers;
      if (plan.prompt) await services.checkpoints.capture(id, "turn.prepare", null);
      startHandle(id, harness, opts);
      return mustGet(id);
    },

    async send(id, message) {
      const msg = messageFor(id, message);
      const s = mustGet(id);
      if (outbox.duplicate(id, msg)) return mustGet(id);
      if (s.state === "waiting") throw new HttpError(409, "the session is waiting for an answer to a prompt");
      if (outbox.enqueue(id, msg)) await pumpQueue(id);
      return mustGet(id);
    },

    queue(id) { mustGet(id); return outbox.snapshot(id); },
    editQueuedMessage(id, messageId, message) { return outbox.edit(id, messageId, messageFor(id, message)); },
    cancelQueuedMessage(id, messageId) { mustGet(id); return outbox.cancel(id, messageId); },
    retryQueuedMessage(id, messageId) { mustGet(id); return outbox.retry(id, messageId); },
    async resumeQueue(id) { mustGet(id); outbox.resume(id); await pumpQueue(id); return outbox.snapshot(id); },

    async sendNow(id, message) {
      mustGet(id);
      if (outbox.snapshot(id).messages.some(m => m.state === "uncertain")) throw new HttpError(409, "resolve uncertain messages before sending now");
      if (message && !outbox.enqueueNext(id, messageFor(id, message))) return outbox.snapshot(id);
      if (!outbox.snapshot(id).messages.some(m => m.state === "queued")) throw new HttpError(409, "nothing queued to send");
      const wasPaused = outbox.snapshot(id).paused;
      if (wasPaused) outbox.resume(id);
      const l = await openHandle(id);
      const cur = mustGet(id);
      const busy = !!l && !l.closing && (cur.state === "running" || cur.state === "waiting");
      if (busy) {
        l.releaseNext = true;
        l.pauseAfterRelease = wasPaused;
        await l.handle.interrupt();
        return outbox.snapshot(id);
      }
      if (l) l.pauseAfterRelease = wasPaused;
      await pumpQueue(id);
      if (!l && wasPaused) outbox.pause(id);
      return outbox.snapshot(id);
    },

    answer(id, requestId, answer) {
      mustGet(id);
      const a = validateAnswer(answer);
      if (approvals.answer(id, requestId, a)) {
        if (a.behavior === "deny" && a.interrupt) void live.get(id)?.handle.interrupt();
        return;
      }
      const l = live.get(id);
      if (!l || l.closing || !l.pending.has(requestId)) throw new HttpError(409, "that prompt is no longer open");
      if (a.behavior === "allow" && l.harness.capabilities && !l.harness.capabilities.permissionScopes.includes(a.scope)) bad(`${l.harness.id} does not support approval scope ${a.scope}`);
      l.handle.answer(requestId, a);
      l.pending.delete(requestId);
    },

    async interrupt(id) {
      approvals.cancel(id);
      const s = mustGet(id);
      outbox.pause(id);
      const l = live.get(id);
      if (!l || l.closing || (s.state !== "running" && s.state !== "waiting")) return;
      await l.handle.interrupt();
    },

    async update(id, req: UpdateSessionRequest) {
      const s = mustGet(id);
      if (nativeBusy.has(id)) throw new HttpError(409, "a native session operation is in progress");
      if (!req || typeof req !== "object") bad("invalid request");
      if (req.title !== undefined && (typeof req.title !== "string" || !req.title.trim())) bad("title must be a non-empty string");
      if (req.tags !== undefined && (!Array.isArray(req.tags) || req.tags.some((t) => typeof t !== "string"))) bad("tags must be a list of strings");
      if (req.pinned !== undefined && typeof req.pinned !== "boolean") bad("pinned must be a boolean");
      if (req.archived !== undefined && typeof req.archived !== "boolean") bad("archived must be a boolean");
      if (req.model !== undefined && (typeof req.model !== "string" || !req.model.trim())) bad("model must be a non-empty string");
      if (req.permissionMode !== undefined && !PERMISSION_MODES.includes(req.permissionMode)) bad("unknown permission mode");
      if (req.aside !== undefined && req.aside !== false) bad(req.aside === true ? "a session can't be made a side thread" : "aside must be false");
      let projects: string[] | undefined;
      if (req.addProjects !== undefined) {
        if (!Array.isArray(req.addProjects) || req.addProjects.some((n) => typeof n !== "string" || !n.trim())) bad("addProjects must be a list of project names");
        const names = [...new Set(req.addProjects.map((n) => n.trim()))].filter((n) => !s.projects.includes(n));
        for (const name of names) {
          const project = services.projects.get(name);
          if (!project) throw new HttpError(404, `unknown project ${name}`);
          if (project.missing) throw new HttpError(409, `project ${name} is unavailable`);
        }
        if (names.length) {
          if (harnessFor(s).capabilities?.additionalDirectories === false) bad(`${s.harness} does not support additional project directories`);
          // The directories are handed to the harness when its process starts, so a turn in flight can't take them.
          if (s.state === "running" || s.state === "waiting") throw new HttpError(409, "wait for the current turn to finish before adding a project");
          projects = [...s.projects, ...names];
        }
      }
      if (req.runtimeOptions !== undefined) {
        const native = runtimeOptions({ ...s.runtimeOptions, ...req.runtimeOptions }, harnessFor(s).capabilities);
        const l = live.get(id);
        if (l && !l.closing) {
          if (!l.handle.setRuntimeOptions) bad("runtime cannot change native options");
          await l.handle.setRuntimeOptions(native);
        }
        const config = parseJson<Record<string, unknown>>(row(id)!.launch_config, {});
        db.prepare("UPDATE sessions SET launch_config = ? WHERE id = ?").run(JSON.stringify({ ...config, runtimeOptions: native }), id);
      }

      if (req.model !== undefined && req.effort === undefined && s.effort) {
        const models = await harnessFor(s).models();
        const selected = findModel(models, req.model);
        if (!selected?.effortLevels?.includes(s.effort)) req = { ...req, effort: null };
      }
      await validateEffort(harnessFor(s), req.model ?? s.model, req.effort);
      if (req.model !== undefined || req.permissionMode !== undefined || req.effort !== undefined) {
        if (req.permissionMode && harnessFor(s).capabilities && !harnessFor(s).capabilities!.permissionModes.includes(req.permissionMode)) bad(`${s.harness} does not support permission mode ${req.permissionMode}`);
        // Without a live handle the record is enough: a resume starts with the stored model and mode.
        const l = await openHandle(id);
        if (l) {
          try {
            if (req.model !== undefined) await l.handle.setModel(req.model.trim());
            if (req.effort !== undefined) {
              if (!l.handle.setEffort) throw new Error("Harness cannot change effort live");
              await l.handle.setEffort(req.effort);
            }
            if (req.permissionMode !== undefined) await l.handle.setPermissionMode(req.permissionMode);
          } catch (err) {
            // The running process can refuse (Claude: bypass on a process not launched for it). Between turns, close
            // it and keep the change for the resume; mid-turn, say why.
            const busy = s.state === "running" || s.state === "waiting";
            if (busy) throw new HttpError(409, `the session could not change its settings: ${errorMessage(err)}`);
            console.error(`session ${id}: changing settings live failed; applying on resume:`, errorMessage(err));
            await closeHandle(l, false);
          }
        }
      }
      const patch: Parameters<typeof write>[1] = {};
      if (projects) {
        // An idle process keeps its old directories: close it, and the next message resumes with the new list.
        const l = await openHandle(id);
        if (l) await closeHandle(l, false);
        patch.projects = projects;
      }
      if (req.runtimeOptions !== undefined) patch.updatedAt = now();
      if (req.model !== undefined) patch.model = req.model.trim();
      if (req.effort !== undefined) patch.effort = req.effort;
      if (req.permissionMode !== undefined) patch.permissionMode = req.permissionMode;
      if (req.title !== undefined) {
        const title = req.title.trim().slice(0, 200);
        patch.title = title;
        if (title !== s.title) {
          try {
            await harnessFor(s).rename(id, title, s.cwd);
          } catch (err) {
            console.error(`renaming ${id} in the harness failed:`, errorMessage(err));
          }
        }
      }
      if (req.tags !== undefined) patch.tags = [...new Set(req.tags.map((t) => t.trim()).filter(Boolean))];
      if (req.pinned !== undefined) patch.pinned = req.pinned;
      if (req.archived !== undefined) patch.archived = req.archived;
      if (req.aside === false) patch.aside = false;
      return patchAndEmit(id, patch);
    },

    async fork(id, req: ForkSessionRequest = {}) {
      if (nativeBusy.has(id)) throw new HttpError(409, "a native session operation is in progress");
      const parent = mustGet(id);
      if (!req || typeof req !== "object") bad("invalid request");
      if (req.title !== undefined && (typeof req.title !== "string" || !req.title.trim())) bad("title must be a non-empty string");
      if (req.worktree !== undefined && typeof req.worktree !== "boolean") bad("worktree must be a boolean");
      if (req.aside !== undefined && typeof req.aside !== "boolean") bad("aside must be a boolean");
      if (req.model !== undefined && (typeof req.model !== "string" || !req.model.trim())) bad("model must be a non-empty string");
      if (req.permissionMode !== undefined && !PERMISSION_MODES.includes(req.permissionMode)) bad("unknown permission mode");
      if (req.atMessageId !== undefined && (typeof req.atMessageId !== "string" || !req.atMessageId)) bad("atMessageId must be a non-empty string");
      if (req.restoreFiles !== undefined && typeof req.restoreFiles !== "boolean") bad("restoreFiles must be a boolean");
      if (req.restoreFiles && (!req.atMessageId || !req.worktree)) bad("restoreFiles needs atMessageId and worktree: true");
      const aside = req.aside === true;
      if (aside && req.prompt === undefined) bad("a side thread needs a prompt");
      if (aside && (req.atMessageId || req.restoreFiles)) bad("a side thread can't be cut at a message");
      if (aside && req.worktree) bad("a side thread can't have a worktree");
      const prompt = req.prompt !== undefined ? messageFor(id, req.prompt) : null;
      const harness = harnessFor(parent);
      const supports = (mode: PermissionMode) => !harness.capabilities || harness.capabilities.permissionModes.includes(mode);
      if (req.permissionMode !== undefined && !supports(req.permissionMode)) bad(`${parent.harness} does not support permission mode ${req.permissionMode}`);
      // A side thread reads but doesn't edit what the parent is working on, unless asked otherwise.
      const permissionMode = req.permissionMode ?? (aside && supports("plan") ? "plan" : parent.permissionMode);
      const model = req.model?.trim() ?? parent.model;
      let effort = parent.effort;
      if (req.model !== undefined && effort) {
        const models = await harness.models();
        if (!findModel(models, model)?.effortLevels?.includes(effort)) effort = null;
      }
      const title = (req.title?.trim() || (aside ? sideTitle(prompt!) : `${parent.title} (fork)`)).slice(0, 200);
      if (parent.projects.length > 1 && harness.capabilities?.additionalDirectories === false) bad(`${parent.harness} does not support additional project directories`);
      const mcpServers = await savedMcp(id);

      // Fork cut before a message: the harness must support it, and the cut's checkpoint (if any) gives the files.
      let cut: Checkpoint | null = null;
      if (req.atMessageId) {
        if (typeof harness.forkAt !== "function" || harness.capabilities?.checkpoints?.forkAt === false) bad(`${parent.harness} cannot fork a session at a message`);
        cut = services.checkpoints.list(id).find(c => c.kind === "turn" && c.messageId === req.atMessageId) ?? null;
        if (req.restoreFiles && (!cut || cut.snapshot !== "ok")) throw new HttpError(409, "there is no saved working tree for that message");
      }

      let newId: string;
      if (prompt && !req.atMessageId) newId = randomUUID();
      else {
        try {
          newId = req.atMessageId ? await harness.forkAt!(id, req.atMessageId, parent.cwd) : await harness.fork(id, parent.cwd);
        } catch (err) {
          throw new HttpError(502, `the harness could not fork the session: ${errorMessage(err)}`);
        }
      }

      let cwd = parent.cwd;
      let workspace = parent.workspace;
      let branch = parent.branch;
      if (req.worktree) {
        // Always a new odin/ branch: the parent's would already be checked out.
        const wt = await services.projects.createWorktree(parent.project, sessionBranch(title, newId));
        cwd = wt.path;
        branch = wt.branch;
        workspace = { kind: "worktree", path: wt.path, branch: wt.branch };
        if (req.restoreFiles && cut) {
          try {
            await services.checkpoints.materialize(id, cut.id, wt.path);
          } catch (err) {
            throw new HttpError(502, `the worktree was created at ${wt.path} but its files could not be restored: ${errorMessage(err)}`);
          }
        }
      }

      const parentRow = row(id)!;
      const at = now();
      insert({
        id: newId, harness: parent.harness, project: parent.project, projects: parent.projects, title, firstPrompt: prompt?.text ?? parentRow.first_prompt, tags: parent.tags,
        origin: "odin", state: prompt ? "running" : "idle", cwd, workspace, branch, model, effort, permissionMode,
        agent: parent.agent, agentVersion: parent.agentVersion, templateId: parent.templateId, parentId: id, aside,
        createdAt: at, updatedAt: at,
        launchConfig: parentRow.launch_config,
      });
      try {
        services.ingest.recordBaseline(newId, id);
      } catch (err) {
        console.error(`ingest.recordBaseline(${newId}) failed:`, errorMessage(err));
      }
      try {
        services.checkpoints.inherit(id, newId, cut?.id ?? null);
      } catch (err) {
        console.error(`checkpoints.inherit(${newId}) failed:`, errorMessage(err));
      }

      if (prompt) {
        // Cut at a message: the harness already made the stored fork, so resume it; otherwise fork while starting.
        const opts: StartOptions = req.atMessageId
          ? { cwd, resume: newId, prompt, title, hostTools: hostTools(newId), mcpServers }
          : { cwd, resume: id, fork: true, sessionId: newId, prompt, title, hostTools: hostTools(newId), mcpServers };
        await services.checkpoints.capture(newId, "turn.prepare", null);
        if (model) opts.model = model;
        opts.effort = effort;
        if (permissionMode) opts.permissionMode = permissionMode;
        startHandle(newId, harness, opts);
      } else if (title !== parent.title) {
        try {
          await harness.rename(newId, title, cwd);
        } catch (err) {
          console.error(`renaming fork ${newId} failed:`, errorMessage(err));
        }
      }
      return mustGet(newId);
    },

    async handoffPreview(id, harnessId): Promise<HandoffPreview> {
      const s = mustGet(id);
      const target = handoffTarget(s, harnessId);
      const detail = await service.detail(id);
      const [facts, check, models] = await Promise.all([
        gitFacts(s.cwd),
        target.check().catch((err) => ({ available: false, note: errorMessage(err) })),
        target.models().catch(() => []),
      ]);
      const source = harnessFor(s);
      const brief = buildBrief({
        sessionId: id, title: s.title, harness: s.harness, harnessName: source.name, targetName: target.name, model: s.model,
        firstPrompt: row(id)?.first_prompt ?? null, transcript: detail?.transcript ?? [], todos: detail?.todos ?? [],
        branch: s.branch, files: facts.files, diffStat: facts.diffStat,
      });
      return {
        brief: brief.text, truncated: brief.truncated,
        source: { harness: s.harness, model: s.model, title: s.title },
        target: { harness: target.id, name: target.name, available: check.available, note: check.note, models },
        files: facts.files, branch: s.branch,
      };
    },

    async handoff(id, req: HandoffRequest) {
      if (nativeBusy.has(id)) throw new HttpError(409, "a native session operation is in progress");
      const s = mustGet(id);
      if (!req || typeof req !== "object") bad("invalid request");
      const target = handoffTarget(s, req.harness);
      if (req.brief !== undefined && (typeof req.brief !== "string" || !req.brief.trim())) bad("brief must be a non-empty string");
      if (req.title !== undefined && (typeof req.title !== "string" || !req.title.trim())) bad("title must be a non-empty string");
      if (req.model !== undefined && (typeof req.model !== "string" || !req.model.trim())) bad("model must be a non-empty string");
      if (req.endSource !== undefined && typeof req.endSource !== "boolean") bad("endSource must be a boolean");
      if (req.permissionMode !== undefined && !PERMISSION_MODES.includes(req.permissionMode)) bad("unknown permission mode");
      const modes = target.capabilities?.permissionModes;
      if (req.permissionMode !== undefined && modes && !modes.includes(req.permissionMode)) bad(`${target.id} does not support permission mode ${req.permissionMode}`);
      if (s.projects.length > 1 && target.capabilities?.additionalDirectories === false) bad(`${target.id} does not support additional project directories`);
      if (s.state === "running" || s.state === "waiting") throw new HttpError(409, "stop the session before handing it off: both would share one checkout");
      const check = await target.check().catch((err) => ({ available: false, note: errorMessage(err) }));
      if (!check.available) throw new HttpError(409, `${target.name} is not available${check.note ? `: ${check.note}` : ""}`);
      const brief = req.brief?.trim() ?? (await service.handoffPreview(id, target.id)).brief;
      const prompt = validateMessage({ text: brief });
      const permissionMode = req.permissionMode ?? (s.permissionMode && (!modes || modes.includes(s.permissionMode)) ? s.permissionMode : null);
      const model = req.model?.trim() ?? null;
      const title = (req.title?.trim() || s.title).slice(0, 200);
      const mcpServers = await savedMcp(id);
      const mcpIds = parseJson<{ mcpIds?: string[] }>(row(id)!.launch_config, {}).mcpIds ?? [];

      const newId = randomUUID();
      const at = now();
      insert({
        id: newId, harness: target.id, project: s.project, projects: s.projects, title, firstPrompt: row(id)!.first_prompt, tags: s.tags,
        origin: "odin", state: "running", cwd: s.cwd, workspace: s.workspace, branch: s.branch, model, effort: null, permissionMode,
        agent: null, agentVersion: null, templateId: null, parentId: id, handoff: { from: id, harness: s.harness, at },
        createdAt: at, updatedAt: at, launchConfig: JSON.stringify({ mcpIds }),
      });
      const opts: StartOptions = { cwd: s.cwd, sessionId: newId, title, prompt, hostTools: hostTools(newId), effort: null };
      if (model) opts.model = model;
      if (permissionMode) opts.permissionMode = permissionMode;
      if (mcpServers && Object.keys(mcpServers).length) opts.mcpServers = mcpServers;
      startHandle(newId, target, opts);
      if (req.endSource !== false && mustGet(newId).state !== "failed") {
        try {
          await service.end(id);
        } catch (err) {
          console.error(`ending ${id} after a handoff failed:`, errorMessage(err));
        }
      }
      return mustGet(newId);
    },

    async end(id) {
      if (nativeBusy.has(id)) throw new HttpError(409, "a native session operation is in progress");
      const s = mustGet(id);
      outbox.pause(id);
      const l = live.get(id);
      if (l) {
        await closeHandle(l, true);
        return mustGet(id);
      }
      if (s.state === "failed" || s.state === "ended") return s;
      return patchAndEmit(id, { state: "ended", waitingFor: null, endedAt: now() });
    },

    async remove(id) {
      if (nativeBusy.has(id)) throw new HttpError(409, "a native session operation is in progress");
      const s = mustGet(id);
      const l = live.get(id);
      if (l) await closeHandle(l, true);
      const harness = deps.harnesses[s.harness];
      if (harness) {
        try {
          await harness.delete(id, s.cwd);
        } catch (err) {
          throw new HttpError(502, `the harness could not delete the session; its record was preserved: ${errorMessage(err)}`);
        }
      }
      void services.checkpoints.forget(id).catch((err: unknown) => console.error(`checkpoints.forget(${id}) failed:`, errorMessage(err)));
      db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
      bus.emit({ type: "session.removed", sessionId: id });
    },

    discover,

    counts(project?: string): SessionCounts {
      const r = db
        .prepare(
          `SELECT coalesce(sum(state = 'running'), 0) AS running, coalesce(sum(state = 'waiting'), 0) AS waiting, count(*) AS total
           FROM sessions WHERE archived = 0 AND aside = 0${project ? " AND (project = ? OR EXISTS (SELECT 1 FROM json_each(sessions.projects) WHERE value = ?))" : ""}`,
        )
        .get(...(project ? [project, project] : [])) as { running: number; waiting: number; total: number };
      return { running: Number(r.running), waiting: Number(r.waiting), total: Number(r.total) };
    },

    ensureExternal(input) {
      return importExternal(input);
    },

    patch(id, patch) {
      return patchAndEmit(id, patch);
    },

    onUpdated(listener) {
      updatedListeners.add(listener);
      return () => updatedListeners.delete(listener);
    },

    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },

    async close() {
      closed = true;
      if (rescanTimer) clearInterval(rescanTimer);
      const all = [...live.values()];
      await Promise.all(all.map((l) => Promise.race([closeHandle(l, false), new Promise<void>((r) => setTimeout(r, 5000).unref?.())])));
    },
  };
  return service;
}

/** For the routes' query validation. */
export { SESSION_STATES, ORIGINS };
