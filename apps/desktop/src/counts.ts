// Tray counts from the shell's own event stream (docs/desktop.md#tray-and-notifications). Mirrors the web sessions store
// (packages/web/src/app/sessions.ts): running and waiting sessions, plus idle ones whose turn ended but still have
// subagents or background commands running, which count as running. Side threads and archived sessions never count.

/** The fields of a `Session` the shell reads. Kept structural so the shell does not depend on shared's internals. */
export interface SessionLite {
  id: string;
  title: string;
  state: string;
  waitingFor?: "permission" | "question" | null;
  archived?: boolean;
  aside?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface TaskLite {
  taskId: string;
  runId?: string | null;
  state: string;
}

export interface Counts {
  running: number;
  waiting: number;
  /** Waiting sessions, newest start first, for the tray menu. */
  waitingSessions: { id: string; title: string }[];
}

/** How long an idle session is worth checking for background work (the web store uses the same window). */
export const WORK_WINDOW_MS = 24 * 60 * 60 * 1000;

const taskKey = (t: TaskLite) => `${t.taskId}\u0000${t.runId ?? ""}`;

export function countsStore() {
  const sessions = new Map<string, SessionLite>();
  const tasks = new Map<string, Map<string, string>>();

  const counted = (s: SessionLite) => !s.archived && !s.aside;
  const hasWork = (id: string) => {
    const t = tasks.get(id);
    if (!t) return false;
    for (const state of t.values()) if (state === "running") return true;
    return false;
  };

  return {
    /** Replace everything with a fresh list (on connect and every reconnect). Task tracking for known ids is kept. */
    seed(list: SessionLite[]) {
      sessions.clear();
      for (const s of list) sessions.set(s.id, s);
      for (const id of [...tasks.keys()]) if (!sessions.has(id)) tasks.delete(id);
    },
    update(s: SessionLite) {
      sessions.set(s.id, s);
    },
    remove(id: string) {
      sessions.delete(id);
      tasks.delete(id);
    },
    /** All task entries of a session (from its transcript), replacing what was known. */
    setTasks(id: string, list: TaskLite[]) {
      tasks.set(id, new Map(list.map((t) => [taskKey(t), t.state])));
    },
    /** One task snapshot from a live `task` event. Only tracked for sessions already known. */
    task(id: string, t: TaskLite) {
      if (!sessions.has(id)) return;
      const m = tasks.get(id) ?? new Map<string, string>();
      m.set(taskKey(t), t.state);
      tasks.set(id, m);
    },
    get(id: string): SessionLite | undefined {
      return sessions.get(id);
    },
    sessions(): SessionLite[] { return [...sessions.values()]; },
    /** Idle sessions recent enough that their transcript may hold running background work. */
    idleToCheck(now: number): SessionLite[] {
      return [...sessions.values()].filter(
        (s) => counted(s) && s.state === "idle" && now - Date.parse(s.updatedAt ?? "") < WORK_WINDOW_MS,
      );
    },
    counts(): Counts {
      let running = 0;
      const waiting: SessionLite[] = [];
      for (const s of sessions.values()) {
        if (!counted(s)) continue;
        if (s.state === "waiting") waiting.push(s);
        else if (s.state === "running" || (s.state === "idle" && hasWork(s.id))) running++;
      }
      waiting.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
      return {
        running,
        waiting: waiting.length,
        waitingSessions: waiting.map((s) => ({ id: s.id, title: s.title || "Untitled session" })),
      };
    },
  };
}

export type CountsStore = ReturnType<typeof countsStore>;

/** "Odin: 2 running, 1 needs you". */
export function trayTooltip(c: Pick<Counts, "running" | "waiting">): string {
  return `Odin: ${c.running} running, ${c.waiting} needs you`;
}

/** The quit confirmation, or null when nothing is live. */
export function quitPrompt(c: Pick<Counts, "running" | "waiting">): string | null {
  const n = c.running + c.waiting;
  if (n === 0) return null;
  return n === 1 ? "1 session is live. Quit and stop it?" : `${n} sessions are live. Quit and stop them?`;
}

export const TRAY_WAITING_LIMIT = 5;
