// MetricsService: query (grouping, in aggregate.ts) and refreshOutput (read-only git). docs/contracts.md#metrics.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type { MetricsDimension, MetricsQuery, MetricsRow, ProjectActivity, ProjectActivityDay, TokenUsage } from "@odin/shared/api";
import { costOf } from "@odin/shared/pricing";
import { gitBinary } from "../tools/resolve.ts";
import { defaultBase } from "../projects/git.ts";
import { HttpError } from "../http/util.ts";
import type { Deps, MetricsService, Services } from "../services.ts";
import { METRICS_DIMENSIONS, aggregate } from "./aggregate.ts";

const run = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run(gitBinary(), args, { cwd, timeout: 15_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
    return stdout;
  } catch {
    return null;
  }
}

async function hasRef(cwd: string, ref: string): Promise<boolean> {
  return (await git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) !== null;
}

export function parseNumstat(out: string): { added: number; removed: number; files: number } {
  let added = 0, removed = 0, files = 0;
  for (const line of out.split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
    if (!m) continue;
    files++;
    if (m[1] !== "-") added += Number(m[1]);
    if (m[2] !== "-") removed += Number(m[2]);
  }
  return { added, removed, files };
}

/** The local calendar day (the server's time zone) of a time, YYYY-MM-DD. */
export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export const ACTIVITY_MAX_DAYS = 168;
/** How long a project's commit counts are reused. */
export const COMMITS_TTL_MS = 30_000;

/** Commits per local day from `git log --branches` (one line per commit: author time in seconds). */
export function countCommitsByDay(out: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of out.split("\n")) {
    const t = Number(line.trim());
    if (!line.trim() || !Number.isFinite(t)) continue;
    const day = localDay(new Date(t * 1000));
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  return counts;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
const usageOf = (d: Record<string, unknown>): TokenUsage => ({ input: num(d.input), output: num(d.output), cacheRead: num(d.cacheRead), cacheWrite: num(d.cacheWrite) });

export function createMetricsService(deps: Deps, services: Services): MetricsService {
  const pending = new Set<Promise<void>>();
  let closed = false;
  const commitCache = new Map<string, { at: number; counts: Promise<Map<string, number> | null> }>();

  /** Commits per local day since `start`, or null for a missing or non-git folder. Cached per folder and window. */
  function commitsSince(path: string, start: Date): Promise<Map<string, number> | null> {
    const key = `${path}\0${start.toISOString()}`;
    const now = deps.now().getTime();
    const hit = commitCache.get(key);
    if (hit && now - hit.at < COMMITS_TTL_MS) return hit.counts;
    const counts = (async () => {
      if (!existsSync(path)) return null;
      const inside = await git(path, ["rev-parse", "--is-inside-work-tree"]);
      if (inside?.trim() !== "true") return null;
      // --since bounds the walk by committer date; the day is taken from the author date and filtered below.
      const out = await git(path, ["log", "--branches", `--since=${start.toISOString()}`, "--format=%at"]);
      if (out === null) return new Map<string, number>();
      return countCommitsByDay(out);
    })();
    commitCache.set(key, { at: now, counts });
    for (const [k, v] of commitCache) if (now - v.at >= COMMITS_TTL_MS) commitCache.delete(k);
    if (commitCache.size > 64) commitCache.delete(commitCache.keys().next().value!);
    return counts;
  }

  function query(q: MetricsQuery): MetricsRow[] {
    const dims = q.groupBy;
    if (!Array.isArray(dims) || dims.length > 3 || dims.length > 3 || new Set(dims).size !== dims.length || dims.some((d) => !METRICS_DIMENSIONS.includes(d as MetricsDimension))) {
      throw new HttpError(400, `groupBy takes 0 to 3 distinct dimensions of: ${METRICS_DIMENSIONS.join(", ")}`);
    }
    if (q.since !== undefined && Number.isNaN(Date.parse(q.since))) throw new HttpError(400, "since must be an ISO-8601 time");
    if (q.until !== undefined && Number.isNaN(Date.parse(q.until))) throw new HttpError(400, "until must be an ISO-8601 time");
    let sessions = services.sessions.list({ ...(q.project ? { project: q.project } : {}), ...(q.since ? { since: q.since } : {}), archived: false, limit: 100_000 });
    if (q.until !== undefined) {
      const until = Date.parse(q.until);
      sessions = sessions.filter((s) => Date.parse(s.createdAt) < until);
    }
    return aggregate(sessions, dims);
  }

  function sessionActivity(project: string, days: number): { days: ProjectActivityDay[]; start: Date } {
    if (!Number.isInteger(days) || days < 1 || days > ACTIVITY_MAX_DAYS) throw new HttpError(400, `days must be an integer from 1 to ${ACTIVITY_MAX_DAYS}`);
    const today = deps.now();
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1));
    const out: ProjectActivityDay[] = [];
    const index = new Map<string, ProjectActivityDay>();
    for (let i = 0; i < days; i++) {
      const day: ProjectActivityDay = { date: localDay(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)), sessions: 0, activeMs: 0, costUsd: null, commits: null, added: 0, removed: 0 };
      out.push(day);
      index.set(day.date, day);
    }
    const dayOf = (ts: string): ProjectActivityDay | undefined => {
      const t = Date.parse(ts);
      return Number.isFinite(t) ? index.get(localDay(new Date(t))) : undefined;
    };
    // Archived sessions count; a session that ended before the window has updatedAt before it.
    const sessions = services.sessions.list({ project, since: start.toISOString(), limit: 1_000_000 });
    if (!sessions.length) return { days: out, start };
    const pricing = services.settings.pricing();
    const rows = deps.db
      .prepare(
        `SELECT session_id, kind, ts, data FROM session_events
         WHERE session_id IN (SELECT value FROM json_each(?)) AND kind IN ('turn', 'usage', 'baseline') ORDER BY seq`,
      )
      .all(JSON.stringify(sessions.map((s) => s.id))) as { session_id: string; kind: string; ts: string; data: string }[];
    const bySession = new Map<string, { kind: string; ts: string; data: Record<string, any> }[]>();
    for (const r of rows) {
      let data: Record<string, any> = {};
      try { data = JSON.parse(r.data) ?? {}; } catch { /* skip bad JSON */ }
      const list = bySession.get(r.session_id) ?? [];
      list.push({ kind: r.kind, ts: r.ts, data });
      bySession.set(r.session_id, list);
    }
    const addCost = (day: ProjectActivityDay | undefined, cost: number | null) => {
      if (day && cost !== null && cost > 0) day.costUsd = (day.costUsd ?? 0) + cost;
      else if (day && cost === 0 && day.costUsd === null) day.costUsd = 0;
    };
    for (const s of sessions) {
      const facts = bySession.get(s.id) ?? [];
      const active = new Set<ProjectActivityDay>();
      if (facts.some((f) => f.kind === "turn")) {
        // Cumulative usage reports replace earlier ones: the day's share is the increase since the previous report.
        const prev = new Map<string, { usage: TokenUsage; costUsd: number | null }>();
        const base = facts.find((f) => f.kind === "baseline")?.data.models;
        if (base && typeof base === "object") {
          for (const [model, b] of Object.entries(base as Record<string, any>)) prev.set(model, { usage: usageOf(b?.usage ?? {}), costUsd: typeof b?.costUsd === "number" ? b.costUsd : null });
        }
        for (const f of facts) {
          const day = dayOf(f.ts);
          if (f.kind === "turn") {
            if (day) {
              active.add(day);
              day.activeMs += num(f.data.durationMs);
            }
          } else if (f.kind === "usage" && typeof f.data.model === "string") {
            const model = f.data.model;
            let usage = usageOf(f.data);
            let harnessCost = typeof f.data.costUsd === "number" && Number.isFinite(f.data.costUsd) && f.data.costUsd >= 0 ? f.data.costUsd : null;
            if (f.data.cumulative === true) {
              const p = prev.get(model);
              prev.set(model, { usage, costUsd: harnessCost });
              if (p) {
                usage = {
                  input: Math.max(0, usage.input - p.usage.input), output: Math.max(0, usage.output - p.usage.output),
                  cacheRead: Math.max(0, usage.cacheRead - p.usage.cacheRead), cacheWrite: Math.max(0, usage.cacheWrite - p.usage.cacheWrite),
                };
                harnessCost = harnessCost === null || p.costUsd === null ? null : Math.max(0, harnessCost - p.costUsd);
              }
            } else {
              const p = prev.get(model);
              prev.set(model, p
                ? {
                    usage: { input: p.usage.input + usage.input, output: p.usage.output + usage.output, cacheRead: p.usage.cacheRead + usage.cacheRead, cacheWrite: p.usage.cacheWrite + usage.cacheWrite },
                    costUsd: p.costUsd === null || harnessCost === null ? p.costUsd ?? harnessCost : p.costUsd + harnessCost,
                  }
                : { usage, costUsd: harnessCost });
            }
            addCost(day, costOf(usage, model, pricing) ?? harnessCost);
          }
        }
      } else {
        for (const ts of [s.createdAt, s.updatedAt]) {
          const day = dayOf(ts);
          if (day) active.add(day);
        }
      }
      for (const day of active) day.sessions++;
      // Diff lines count once, on the session's last active day in the window.
      if (s.metrics.diff && active.size) {
        let last: ProjectActivityDay | undefined;
        for (const day of active) if (!last || day.date > last.date) last = day;
        last!.added += num(s.metrics.diff.added);
        last!.removed += num(s.metrics.diff.removed);
      }
    }
    return { days: out, start };
  }

  async function activity(project: string, days: number): Promise<ProjectActivity> {
    const { days: out, start } = sessionActivity(project, days);
    const ref = services.projects.get(project);
    let counts: Map<string, number> | null = null;
    if (ref?.path) {
      try { counts = await commitsSince(ref.path, start); } catch { counts = null; }
    }
    if (counts) for (const day of out) day.commits = counts.get(day.date) ?? 0;
    return { days: out };
  }

  async function refreshOutput(sessionId: string): Promise<void> {
    const session = services.sessions.get(sessionId);
    if (!session?.branch || !session.cwd || !existsSync(session.cwd)) return;
    const branch = `refs/heads/${session.branch}`;
    if (!(await hasRef(session.cwd, branch))) return;
    const project = services.projects.get(session.project);
    if (!project) return;
    const base = await defaultBase(session.cwd, project.settings.defaultBranch);
    if (!base) return;
    const numstat = await git(session.cwd, ["diff", "--numstat", `${base}...${branch}`]);
    const count = await git(session.cwd, ["rev-list", "--count", `${base}..${branch}`]);
    if (numstat === null || count === null) return;
    const diff = parseNumstat(numstat);
    const commits = Number(count.trim());
    const now = services.sessions.get(sessionId);
    if (!now) return;
    const same = now.metrics.commits === commits && JSON.stringify(now.metrics.diff) === JSON.stringify(diff);
    if (!same) services.sessions.patch(sessionId, { metrics: { diff, commits } });
  }

  return {
    query,
    activity,
    sessionsPerDay: (project, days) => sessionActivity(project, days).days.map((d) => d.sessions),
    refreshOutput(sessionId) {
      if (closed) return Promise.resolve();
      const task = refreshOutput(sessionId);
      pending.add(task);
      void task.finally(() => pending.delete(task)).catch(() => {});
      return task;
    },
    async close() { closed = true; await Promise.allSettled([...pending]); },
  };
}
