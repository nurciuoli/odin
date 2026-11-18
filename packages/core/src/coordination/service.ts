// Project coordinator and threads (docs/plans/project-coordinator.md). A coordinator is an ordinary session that
// gets host tools to start and steer other sessions (threads) in its project; both share a project brief and
// project memory (plain Markdown files in <ODIN_HOME>/memory/<project>/). Everything goes through services.sessions:
// this module never touches harness types beyond HostTool.
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { PROJECT_BRIEF_MAX, type CoordinatorThread, type MemoryFile, type ProjectBrief, type ProjectThreads, type Session, type StartCoordinatorRequest } from "@odin/shared/api";
import type { HostTool, HostToolResult } from "../harness/types.ts";
import { HttpError } from "../http/util.ts";
import { readRegularFile, resolveInside, writeFileAtomic } from "../library/files.ts";
import type { CoordinationService, Deps, Services } from "../services.ts";

/** Threads one coordinator may have running or waiting at once. */
export const MAX_ACTIVE_THREADS = 6;
export const MAX_MEMORY_FILE_BYTES = 64 * 1024;
export const MAX_MEMORY_FILES = 200;
/** How much of a thread's latest reply goes into an update message / read_thread result. */
export const UPDATE_EXCERPT_CHARS = 2_000;
export const READ_THREAD_CHARS = 8_000;
const MEMORY_INDEX = "MEMORY.md";
const MEMORY_INDEX_CHARS = 8_000;
const MEMORY_PATH = /^[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*)*\.md$/;

type Role =
  | { kind: "coordinator"; sessionId: string; project: string }
  | { kind: "thread"; sessionId: string; project: string; coordinatorId: string; task: string };

interface ThreadRow { session_id: string; coordinator_id: string; project: string; task: string; created_at: string }

function bad(message: string): never {
  throw new HttpError(400, message);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[… ${text.length - max} more characters]` : text;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function str(input: Record<string, unknown>, key: string, optional = false): string | undefined {
  const v = input[key];
  if (v === undefined || v === null || v === "") {
    if (optional) return undefined;
    throw new Error(`${key} is required`);
  }
  if (typeof v !== "string") throw new Error(`${key} must be a string`);
  return v;
}

export function createCoordinationService(deps: Deps, services: Services): CoordinationService {
  const { db } = deps;
  const now = () => deps.now().toISOString();
  let closed = false;
  /** Last state seen per thread, to detect running → idle and → failed. */
  const lastState = new Map<string, Session["state"]>();
  /** Updates a waiting coordinator couldn't take yet. */
  const deferred = new Map<string, string[]>();
  const inFlight = new Set<Promise<void>>();

  // ── roles ────────────────────────────────────────────────────────────────

  function role(sessionId: string): Role | null {
    const c = db.prepare("SELECT session_id, project FROM coordinators WHERE session_id = ?").get(sessionId) as { session_id: string; project: string } | undefined;
    if (c) return { kind: "coordinator", sessionId, project: c.project };
    const t = db.prepare("SELECT * FROM threads WHERE session_id = ?").get(sessionId) as ThreadRow | undefined;
    if (t) return { kind: "thread", sessionId, project: t.project, coordinatorId: t.coordinator_id, task: t.task };
    return null;
  }

  function threadRows(coordinatorId: string): ThreadRow[] {
    return db.prepare("SELECT * FROM threads WHERE coordinator_id = ? ORDER BY created_at DESC, rowid DESC").all(coordinatorId) as unknown as ThreadRow[];
  }

  function mustProject(name: string) {
    const p = services.projects.get(name);
    if (!p) throw new HttpError(404, `unknown project ${name}`);
    return p;
  }

  // ── brief and memory ─────────────────────────────────────────────────────

  function memoryDir(project: string): string {
    return join(deps.config.home, "memory", project);
  }

  function memoryFile(project: string, path: unknown): string {
    if (typeof path !== "string" || path.length > 200 || !MEMORY_PATH.test(path) || path.split("/").some((part) => part === "." || part === "..")) {
      bad("memory path must be a relative .md path (letters, digits, . _ - and /)");
    }
    const dir = memoryDir(project);
    mkdirSync(dir, { recursive: true });
    try {
      return resolveInside(dir, path);
    } catch {
      bad("memory path escapes the memory directory");
    }
  }

  function listMemory(project: string): MemoryFile[] {
    const root = memoryDir(project);
    const out: MemoryFile[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 4) return;
      let names: string[];
      try { names = readdirSync(dir); } catch { return; }
      for (const name of names) {
        if (name.startsWith(".")) continue;
        const abs = join(dir, name);
        const st = lstatSync(abs, { throwIfNoEntry: false });
        if (!st) continue;
        if (st.isDirectory()) walk(abs, depth + 1);
        else if (st.isFile() && name.endsWith(".md")) {
          out.push({ path: relative(root, abs).split(sep).join("/"), sizeBytes: st.size, updatedAt: st.mtime.toISOString() });
        }
      }
    };
    walk(root, 0);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  function briefRow(project: string): { instructions: string; updated_at: string } | undefined {
    return db.prepare("SELECT instructions, updated_at FROM project_briefs WHERE project = ?").get(project) as { instructions: string; updated_at: string } | undefined;
  }

  function brief(project: string): ProjectBrief {
    mustProject(project);
    const r = briefRow(project);
    return { instructions: r?.instructions ?? "", updatedAt: r?.updated_at ?? null, memory: listMemory(project) };
  }

  function updateBrief(project: string, instructions: unknown): ProjectBrief {
    mustProject(project);
    if (typeof instructions !== "string") bad("instructions must be a string");
    if (instructions.length > PROJECT_BRIEF_MAX) bad(`instructions are limited to ${PROJECT_BRIEF_MAX} characters`);
    if (instructions.trim()) {
      db.prepare("INSERT INTO project_briefs (project, instructions, updated_at) VALUES (?, ?, ?) ON CONFLICT(project) DO UPDATE SET instructions = excluded.instructions, updated_at = excluded.updated_at")
        .run(project, instructions, now());
    } else {
      db.prepare("DELETE FROM project_briefs WHERE project = ?").run(project);
    }
    return brief(project);
  }

  function readMemory(project: string, path: string) {
    mustProject(project);
    const abs = memoryFile(project, path);
    const content = readRegularFile(abs, MAX_MEMORY_FILE_BYTES);
    if (content === null) throw new HttpError(404, `no memory file ${path}`);
    return { path, content };
  }

  function writeMemory(project: string, path: string, content: unknown): ProjectBrief {
    mustProject(project);
    if (typeof content !== "string") bad("content must be a string");
    if (Buffer.byteLength(content) > MAX_MEMORY_FILE_BYTES) bad(`a memory file is limited to ${MAX_MEMORY_FILE_BYTES / 1024} KB`);
    const abs = memoryFile(project, path);
    const exists = lstatSync(abs, { throwIfNoEntry: false });
    if (exists && !exists.isFile()) bad(`${path} is not a regular file`);
    if (!exists && listMemory(project).length >= MAX_MEMORY_FILES) bad(`project memory is limited to ${MAX_MEMORY_FILES} files`);
    writeFileAtomic(abs, content);
    return brief(project);
  }

  function deleteMemory(project: string, path: string): void {
    mustProject(project);
    const abs = memoryFile(project, path);
    const st = lstatSync(abs, { throwIfNoEntry: false });
    if (!st || !st.isFile()) throw new HttpError(404, `no memory file ${path}`);
    rmSync(abs);
  }

  // ── threads ──────────────────────────────────────────────────────────────

  function threadView(r: ThreadRow): CoordinatorThread | null {
    const session = services.sessions.get(r.session_id);
    return session ? { sessionId: r.session_id, coordinatorId: r.coordinator_id, task: r.task, createdAt: r.created_at, session } : null;
  }

  function ownedThread(coordinatorId: string, threadId: unknown): CoordinatorThread {
    if (typeof threadId !== "string" || !threadId) throw new Error("thread_id is required");
    const r = db.prepare("SELECT * FROM threads WHERE session_id = ? AND coordinator_id = ?").get(threadId, coordinatorId) as ThreadRow | undefined;
    const view = r && threadView(r);
    if (!view) throw new Error(`${threadId} is not one of this coordinator's threads`);
    return view;
  }

  async function latestReply(sessionId: string): Promise<string | null> {
    const detail = await services.sessions.detail(sessionId);
    if (!detail) return null;
    for (let i = detail.transcript.length - 1; i >= 0; i--) {
      const e = detail.transcript[i]!;
      if (e.kind === "assistant" && e.parentToolUseId === null && e.text.trim()) return e.text;
    }
    return null;
  }

  function describe(t: CoordinatorThread): string {
    const s = t.session;
    const state = s.state === "waiting" ? `waiting for ${s.waitingFor ?? "the user"}` : s.state;
    return `- ${t.sessionId} "${s.title}": ${state}${s.branch ? `, branch ${s.branch}` : ""}\n  task: ${clip(t.task.replace(/\s+/g, " "), 200)}`;
  }

  async function startThread(coordinatorId: string, input: Record<string, unknown>): Promise<HostToolResult> {
    const coordinator = services.sessions.get(coordinatorId);
    if (!coordinator) return { text: "The coordinator session is unavailable", isError: true };
    const task = str(input, "task")!.trim();
    if (!task) throw new Error("task is required");
    const title = (str(input, "title", true)?.trim() || task.split("\n")[0]!).slice(0, 80);
    const model = str(input, "model", true);
    const worktree = input.worktree === undefined ? true : input.worktree;
    if (typeof worktree !== "boolean") throw new Error("worktree must be a boolean");
    const active = threadRows(coordinatorId).map(threadView).filter((t) => t && (t.session.state === "running" || t.session.state === "waiting"));
    if (active.length >= MAX_ACTIVE_THREADS) {
      return { text: `${active.length} threads are already running or waiting (limit ${MAX_ACTIVE_THREADS}). Wait for one to finish, or stop one.`, isError: true };
    }
    const id = randomUUID();
    db.prepare("INSERT INTO threads (session_id, coordinator_id, project, task, created_at) VALUES (?, ?, ?, ?, ?)").run(id, coordinatorId, coordinator.project, task, now());
    try {
      const s = await services.sessions.start({
        project: coordinator.project,
        projects: coordinator.projects,
        harness: coordinator.harness,
        prompt: { text: task },
        title,
        ...(model ?? coordinator.model ? { model: model ?? coordinator.model! } : {}),
        ...(coordinator.permissionMode ? { permissionMode: coordinator.permissionMode } : {}),
        worktree,
        tags: ["thread"],
      }, { id });
      lastState.set(id, s.state);
      return { text: `Started thread ${id} "${s.title}"${s.branch ? ` on branch ${s.branch}` : ""}. It reports back when it finishes a turn.` };
    } catch (err) {
      if (!services.sessions.get(id)) db.prepare("DELETE FROM threads WHERE session_id = ?").run(id);
      return { text: `start_thread failed: ${errorText(err)}`, isError: true };
    }
  }

  // ── host tools ───────────────────────────────────────────────────────────

  function guarded(handler: (input: Record<string, unknown>) => Promise<HostToolResult> | HostToolResult) {
    return async (input: Record<string, unknown>): Promise<HostToolResult> => {
      try {
        return await handler(input);
      } catch (err) {
        return { text: errorText(err), isError: true };
      }
    };
  }

  function memoryTools(project: string): HostTool[] {
    return [
      {
        name: "memory_list",
        description: "List this project's memory files (shared by its coordinator and every thread). MEMORY.md is the index.",
        params: {},
        handler: guarded(() => {
          const files = listMemory(project);
          return { text: files.length ? files.map((f) => `${f.path} (${f.sizeBytes} bytes, ${f.updatedAt})`).join("\n") : "Project memory is empty." };
        }),
      },
      {
        name: "memory_read",
        description: "Read one project memory file.",
        params: { path: { type: "string", description: "Relative .md path as memory_list shows it, e.g. MEMORY.md or decisions/db.md." } },
        handler: guarded((input) => ({ text: readMemory(project, str(input, "path")!).content })),
      },
      {
        name: "memory_write",
        description:
          "Create or replace a project memory file: requirements, decisions and pitfalls later threads need. Markdown, max 64 KB. " +
          "Keep MEMORY.md a short index that links the other files; it is given to every new thread and coordinator.",
        params: {
          path: { type: "string", description: "Relative .md path, e.g. MEMORY.md or pitfalls/flaky-tests.md." },
          content: { type: "string", description: "The whole file." },
        },
        handler: guarded((input) => {
          writeMemory(project, str(input, "path")!, input.content);
          return { text: `Saved ${input.path as string}` };
        }),
      },
      {
        name: "memory_delete",
        description: "Delete a project memory file (forget something). Update MEMORY.md if it linked the file.",
        params: { path: { type: "string", description: "Relative .md path." } },
        handler: guarded((input) => {
          deleteMemory(project, str(input, "path")!);
          return { text: `Deleted ${input.path as string}` };
        }),
      },
    ];
  }

  function coordinatorTools(coordinatorId: string, project: string): HostTool[] {
    return [
      {
        name: "start_thread",
        description:
          "Start a thread: a separate agent session that works on one task in parallel, by default in its own git worktree. " +
          "The thread doesn't see this conversation, so the task must be complete and self-contained (goal, context, constraints, how to check the work). " +
          `At most ${MAX_ACTIVE_THREADS} threads run at once. The thread reports back here when it finishes a turn.`,
        params: {
          task: { type: "string", description: "The thread's complete instructions." },
          title: { type: "string", description: "Short name shown to the user.", optional: true },
          worktree: { type: "boolean", description: "Run in a new worktree on its own branch (default true). False shares the project checkout.", optional: true },
          model: { type: "string", description: "Model for the thread. Default: this session's model.", optional: true },
        },
        handler: guarded((input) => startThread(coordinatorId, input)),
      },
      {
        name: "list_threads",
        description: "List the threads you started, newest first, with state (running, waiting, idle, ended, failed) and branch.",
        params: {},
        handler: guarded(() => {
          const views = threadRows(coordinatorId).map(threadView).filter((t): t is CoordinatorThread => !!t);
          return { text: views.length ? views.map(describe).join("\n") : "No threads yet." };
        }),
      },
      {
        name: "read_thread",
        description: "A thread's state and its latest reply (its result so far).",
        params: { thread_id: { type: "string", description: "Thread id from start_thread or list_threads." } },
        handler: guarded(async (input) => {
          const t = ownedThread(coordinatorId, input.thread_id);
          const reply = await latestReply(t.sessionId);
          return { text: `${describe(t)}\n\nLatest reply:\n${reply ? clip(reply, READ_THREAD_CHARS) : "(none yet)"}` };
        }),
      },
      {
        name: "message_thread",
        description: "Send a thread a follow-up or correction. Queued if the thread is busy. A thread waiting for permission needs the user, not a message.",
        params: {
          thread_id: { type: "string", description: "Thread id." },
          message: { type: "string", description: "The message." },
        },
        handler: guarded(async (input) => {
          const t = ownedThread(coordinatorId, input.thread_id);
          const s = await services.sessions.send(t.sessionId, { text: str(input, "message")! });
          return { text: `Sent to ${t.sessionId} (now ${s.state}).` };
        }),
      },
      {
        name: "stop_thread",
        description: "End a thread's live session. It stays resumable (message_thread resumes it).",
        params: { thread_id: { type: "string", description: "Thread id." } },
        handler: guarded(async (input) => {
          const t = ownedThread(coordinatorId, input.thread_id);
          await services.sessions.end(t.sessionId);
          return { text: `Stopped ${t.sessionId}.` };
        }),
      },
      {
        name: "update_brief",
        description:
          `Replace the project brief: standing rules every new thread and coordinator starts with (max ${PROJECT_BRIEF_MAX} characters). ` +
          "Only when the user asks for a standing rule; it reaches new threads, not running ones.",
        params: { instructions: { type: "string", description: "The whole new brief. Empty clears it." } },
        handler: guarded((input) => {
          updateBrief(project, input.instructions ?? "");
          return { text: "Project brief updated." };
        }),
      },
      ...memoryTools(project),
    ];
  }

  // ── instructions ─────────────────────────────────────────────────────────

  function instructions(sessionId: string): string | null {
    const r = role(sessionId);
    if (!r) return null;
    const parts: string[] = [];
    if (r.kind === "coordinator") {
      parts.push(
        `Odin coordinator instructions: you coordinate ongoing work in the project "${r.project}". The user sends tasks here. ` +
        "For each piece of work that can proceed on its own, call start_thread with a complete, self-contained task: threads don't see this conversation. " +
        `Prefer a few focused threads; at most ${MAX_ACTIVE_THREADS} run at once. Do small things (answers, quick lookups) yourself; hand implementation to threads. ` +
        'Threads report back here in messages that start with "[Odin thread update]": summarise results for the user, ' +
        "use read_thread for detail, message_thread to steer, stop_thread to end one. A thread waiting for permission needs the user: tell them. " +
        "Save requirements, decisions and pitfalls that later threads need with memory_write (keep MEMORY.md a short index), " +
        "and change the project brief with update_brief only when the user asks for a standing rule.",
      );
    } else {
      parts.push(
        "Odin thread instructions: you are a thread started by this project's coordinator, for the task in your first message. " +
        "Work only on that task. When you finish, end your turn with a short summary of the outcome (what changed, branch, checks run, anything left); " +
        "Odin forwards it to the coordinator. Save what later threads need to know (requirements, decisions, pitfalls) with memory_write; keep MEMORY.md a short index.",
      );
    }
    const b = briefRow(r.project);
    if (b?.instructions.trim()) parts.push(`Project brief for ${r.project}:\n${b.instructions}`);
    try {
      const index = readRegularFile(memoryFile(r.project, MEMORY_INDEX), MAX_MEMORY_FILE_BYTES);
      if (index?.trim()) parts.push(`Project memory index (${MEMORY_INDEX}; read other files with memory_read):\n${clip(index, MEMORY_INDEX_CHARS)}`);
    } catch (err) {
      console.error("coordination: couldn't read MEMORY.md:", errorText(err));
    }
    return parts.join("\n\n");
  }

  // ── thread updates ───────────────────────────────────────────────────────

  /** Sends an update to the coordinator outside the emitting listener; held while it waits for the user. */
  function deliver(coordinatorId: string, text: string): void {
    track((async () => {
      await Promise.resolve();
      if (closed) return;
      const coordinator = services.sessions.get(coordinatorId);
      if (!coordinator || coordinator.archived) return;
      if (coordinator.state === "waiting") {
        deferred.set(coordinatorId, [...(deferred.get(coordinatorId) ?? []), text]);
        return;
      }
      await services.sessions.send(coordinatorId, { text });
    })().catch((err) => {
      console.error("coordination: couldn't send a thread update:", errorText(err));
    }));
  }

  function track(p: Promise<void>): void {
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
  }

  function notify(thread: ThreadRow, session: Session, outcome: "idle" | "failed"): void {
    const head = `[Odin thread update] "${session.title}" (thread ${thread.session_id})`;
    if (outcome === "failed") {
      deliver(thread.coordinator_id, `${head} failed${session.error ? `: ${clip(session.error, 500)}` : "."}`);
      return;
    }
    track((async () => {
      let reply: string | null = null;
      try { reply = await latestReply(thread.session_id); } catch (err) { console.error("coordination: couldn't read a thread reply:", errorText(err)); }
      if (closed) return;
      const where = session.branch ? ` on branch ${session.branch}` : "";
      deliver(thread.coordinator_id, `${head} finished a turn${where}:\n${reply ? clip(reply, UPDATE_EXCERPT_CHARS) : "(no reply text)"}`);
    })());
  }

  const unsubscribe = services.sessions.onUpdated((s) => {
    if (closed) return;
    try {
      const pending = deferred.get(s.id);
      if (pending?.length && s.state !== "waiting") {
        deferred.delete(s.id);
        deliver(s.id, pending.join("\n\n"));
      }
      const thread = db.prepare("SELECT * FROM threads WHERE session_id = ?").get(s.id) as ThreadRow | undefined;
      if (!thread) return;
      const prev = lastState.get(s.id);
      lastState.set(s.id, s.state);
      if (prev === s.state) return;
      if (s.state === "idle" && (prev === "running" || prev === "waiting")) notify(thread, s, "idle");
      else if (s.state === "failed") notify(thread, s, "failed");
    } catch (err) {
      console.error("coordination: update listener failed:", errorText(err));
    }
  });

  // ── service ──────────────────────────────────────────────────────────────

  return {
    async startCoordinator(project, req: StartCoordinatorRequest) {
      mustProject(project);
      if (!req || typeof req !== "object" || Array.isArray(req)) bad("invalid request");
      const id = randomUUID();
      db.prepare("INSERT INTO coordinators (session_id, project, created_at) VALUES (?, ?, ?)").run(id, project, now());
      try {
        return await services.sessions.start({ ...req, project, tags: [...new Set(["coordinator", ...(Array.isArray(req.tags) ? req.tags : [])])] }, { id });
      } catch (err) {
        // A harness that failed after the record exists keeps the role: the session is there, failed, and resumable.
        if (!services.sessions.get(id)) db.prepare("DELETE FROM coordinators WHERE session_id = ?").run(id);
        throw err;
      }
    },

    threads(project): ProjectThreads {
      mustProject(project);
      const rows = db.prepare("SELECT session_id FROM coordinators WHERE project = ? ORDER BY created_at DESC, rowid DESC").all(project) as { session_id: string }[];
      const coordinators: ProjectThreads["coordinators"] = [];
      for (const r of rows) {
        const session = services.sessions.get(r.session_id);
        if (!session) continue;
        coordinators.push({ session, threads: threadRows(r.session_id).map(threadView).filter((t): t is CoordinatorThread => !!t) });
      }
      return { coordinators };
    },

    brief,
    updateBrief,
    readMemory,
    writeMemory,
    deleteMemory,

    hostTools(sessionId) {
      const r = role(sessionId);
      if (!r) return [];
      return r.kind === "coordinator" ? coordinatorTools(sessionId, r.project) : memoryTools(r.project);
    },

    instructions,

    async close() {
      closed = true;
      unsubscribe();
      await Promise.allSettled([...inFlight]);
    },
  };
}
