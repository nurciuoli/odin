// IngestService: validates hook events, resolves each to a session (creating external ones), stores them as
// measurement facts, and recomputes metrics. Odin-run sessions are measured from the harness stream instead
// (recordHarnessEvent). docs/contracts.md#ingest.
import { randomUUID } from "node:crypto";
import type { Session } from "@odin/shared/api";
import type { HarnessEvent } from "@odin/shared/harness";
import type { IngestEvent, IngestResponse } from "@odin/shared/ingest";
import type { Deps, IngestService, Services, SessionPatch } from "../services.ts";
import { BASELINE_KIND, type Baseline, type FactRow, baselineFrom, computeMetrics } from "./metrics.ts";
import { MAX_TARGET, validateEvent } from "./validate.ts";

interface Row {
  kind: string;
  ts: string;
  data: string;
}

/** The hook adapter calls the harness "claude-code"; the session's harness id is "claude". */
const harnessId = (h: string): string => (h === "claude-code" ? "claude" : h);

const cut = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);

/** A tool's target without contents: a path/pattern, or a command's first two words. */
export function targetOf(input: Record<string, unknown>): string | undefined {
  for (const key of ["file_path", "path", "pattern"]) {
    const v = input[key];
    if (typeof v === "string" && v) return cut(v, MAX_TARGET);
  }
  if (typeof input.command === "string" && input.command.trim()) return cut(input.command.trim().split(/\s+/).slice(0, 2).join(" "), MAX_TARGET);
  return undefined;
}

export function createIngestService(deps: Deps, services: Services): IngestService {
  const { db } = deps;

  const exists = db.prepare("SELECT 1 FROM session_events WHERE id = ?");
  const insertFact = db.prepare(
    `INSERT OR IGNORE INTO session_events (id, seq, session_id, source, kind, ts, data, received_at)
     VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM session_events), ?, ?, ?, ?, ?, ?)`,
  );
  const factsOf = db.prepare("SELECT kind, ts, data FROM session_events WHERE session_id = ? ORDER BY seq");
  const countTurns = db.prepare("SELECT COUNT(*) AS n FROM session_events WHERE session_id = ? AND kind = 'turn'");

  const rowsOf = (sessionId: string): FactRow[] =>
    (factsOf.all(sessionId) as unknown as Row[]).map((r) => ({ kind: r.kind, ts: r.ts, data: JSON.parse(r.data) }));
  const baselineOf = (rows: FactRow[]): Baseline => {
    const row = rows.find((r) => r.kind === BASELINE_KIND);
    return (row?.data.models as Baseline | undefined) ?? {};
  };

  function store(id: string, sessionId: string, source: "ingest" | "harness", kind: string, ts: string, data: unknown): boolean {
    return Number(insertFact.run(id, sessionId, source, kind, ts, JSON.stringify(data), deps.now().toISOString()).changes) > 0;
  }

  /** Recompute metrics from the stored facts and patch the record (with any extra fields) in one update. */
  function flush(sessionId: string, extra: SessionPatch = {}): void {
    const session = services.sessions.get(sessionId);
    if (!session) return;
    const rows = rowsOf(sessionId);
    const { metrics, topModel } = computeMetrics(rows, services.settings.pricing(), baselineOf(rows));
    const patch: SessionPatch = { ...extra };
    const changed = (Object.keys(metrics) as (keyof typeof metrics)[]).some((k) => JSON.stringify(session.metrics[k]) !== JSON.stringify(metrics[k]));
    if (changed) patch.metrics = metrics;
    if (topModel && topModel !== session.model) patch.model = topModel;
    if (Object.keys(patch).length) services.sessions.patch(sessionId, patch);
  }

  /** True when this id is the native id of a session Odin already tracks. */
  function trackedNative(nativeId: string): boolean {
    const rows = db.prepare("SELECT session_id FROM harness_session_links WHERE native_id = ?").all(nativeId) as { session_id: string }[];
    return rows.some((row) => services.sessions.get(row.session_id));
  }

  function resolveSession(e: IngestEvent): { session: Session } | { error: string } {
    const known = services.sessions.get(e.session);
    if (known) return { session: known };
    let project: string | null = null;
    if (e.project && services.projects.get(e.project)) project = e.project;
    if (!project && e.cwd) project = services.projects.resolveCwd(e.cwd);
    if (!project) return { error: e.project ? `unknown project ${JSON.stringify(e.project.slice(0, 60))}` : "cannot resolve a project: send project or cwd" };
    const ref = services.projects.get(project);
    if (!ref) return { error: "unknown project" };
    const started = e.kind === "session.started" ? e.data : null;
    const session = services.sessions.ensureExternal({
      id: e.session,
      harness: harnessId(e.harness),
      project,
      cwd: e.cwd ?? ref.path,
      ...(started?.title ? { title: started.title } : {}),
      branch: e.branch ?? null,
      model: started?.model ?? null,
      agent: e.agent ?? null,
      at: e.ts,
    });
    return { session };
  }

  /** Record changes one event implies; merged per session and written at flush. */
  function lifecycle(e: IngestEvent, session: Session, patch: SessionPatch): void {
    if (!session.branch && e.branch && !patch.branch) patch.branch = e.branch;
    if (!patch.updatedAt || patch.updatedAt < e.ts) patch.updatedAt = e.ts;
    if (e.kind === "session.started") {
      if (!session.model && e.data.model && !patch.model) patch.model = e.data.model;
      // A resumed session that had ended is in use again.
      if (e.data.source === "resume" && (session.state === "ended" || session.state === "failed")) {
        patch.state = "idle";
        patch.endedAt = null;
        patch.error = null;
      }
    } else if (e.kind === "session.ended") {
      patch.state = e.data.outcome === "failed" ? "failed" : "ended";
      patch.endedAt = e.ts;
      patch.error = e.data.outcome === "failed" ? (e.data.error ?? "failed") : null;
    }
  }

  function ingestBatch(raw: unknown[]): IngestResponse {
    const res: IngestResponse = { accepted: 0, duplicates: 0, rejected: [], sessionIds: [] };
    const touched = new Map<string, SessionPatch>();
    db.exec("SAVEPOINT ingest");
    try {
      for (const item of raw) {
        const v = validateEvent(item);
        if (!v.ok) {
          res.rejected.push({ id: v.id, error: v.error });
          continue;
        }
        const e = v.event;
        if (exists.get(e.id)) {
          res.duplicates++;
          continue;
        }
        // A terminal session with no message yet only reports its start (and its end, if it closes empty). Don't save
        // it: the first turn, tool or usage fact after a reply creates the record.
        if ((e.kind === "session.started" || e.kind === "session.ended") && !services.sessions.get(e.session)) continue;
        // Grok and Codex ids in the hook payload are native ids. Odin already has that conversation under
        // another id; creating one here leaves an empty "Untitled session".
        if (!services.sessions.get(e.session) && trackedNative(e.session)) {
          res.duplicates++;
          continue;
        }
        const r = resolveSession(e);
        if ("error" in r) {
          res.rejected.push({ id: e.id, error: r.error });
          continue;
        }
        // Sessions Odin runs are measured from the harness stream; their project hooks fire too.
        if (r.session.origin === "odin") {
          res.duplicates++;
          continue;
        }
        store(e.id, r.session.id, "ingest", e.kind, e.ts, e.data);
        const patch = touched.get(r.session.id) ?? {};
        lifecycle(e, r.session, patch);
        touched.set(r.session.id, patch);
        res.accepted++;
      }
      for (const [id, patch] of touched) flush(id, patch);
      db.exec("RELEASE ingest");
    } catch (err) {
      db.exec("ROLLBACK TO ingest");
      db.exec("RELEASE ingest");
      throw err;
    }
    res.sessionIds = [...touched.keys()].sort();
    return res;
  }

  function recordHarnessEvent(sessionId: string, event: HarnessEvent): void {
    let id: string | null = null, kind = "", data: unknown;
    switch (event.type) {
      case "usage":
        kind = "usage";
        data = { model: event.model, ...event.usage, cumulative: event.cumulative, costUsd: event.costUsd, contextTokens: event.contextTokens, contextWindow: event.contextWindow };
        break;
      case "turn.end": {
        kind = "turn";
        const index = (countTurns.get(sessionId) as { n: number }).n + 1;
        data = { index, durationMs: event.durationMs, ok: event.ok };
        break;
      }
      case "entry":
        if (event.entry.kind !== "tool") return;
        kind = "tool";
        id = `h:${sessionId}:tool:${event.entry.id}`;
        data = { name: cut(event.entry.name, 100), ...(targetOf(event.entry.input) ? { target: targetOf(event.entry.input) } : {}), ok: event.entry.result?.ok ?? true };
        break;
      case "exit":
        if (event.outcome !== "failed") return;
        kind = "error";
        data = { message: cut(event.error ?? "the harness exited with an error", 2000) };
        break;
      default:
        return;
    }
    if (!services.sessions.get(sessionId)) return;
    const stored = store(id ?? `h:${randomUUID()}`, sessionId, "harness", kind, deps.now().toISOString(), data);
    if (stored) flush(sessionId);
  }

  function recordBaseline(sessionId: string, parentId: string): void {
    if (!services.sessions.get(sessionId)) return;
    // Gross totals as the parent's harness reported them (that is what the fork's cumulative counter starts from).
    const models = baselineFrom(rowsOf(parentId));
    store(`baseline:${sessionId}`, sessionId, "harness", BASELINE_KIND, deps.now().toISOString(), { models });
    flush(sessionId);
  }

  function replaceHistory(sessionId: string, facts: import("../harness/types.ts").HarnessMeasurement[]): void {
    const session = services.sessions.get(sessionId);
    if (!session || session.origin !== "external") return;
    // Hook measurements are already authoritative; don't mix two sources for the same work.
    if (db.prepare("SELECT 1 FROM session_events WHERE session_id = ? AND source = 'ingest' LIMIT 1").get(sessionId)) return;
    db.exec("SAVEPOINT history_metrics");
    try {
      db.prepare("DELETE FROM session_events WHERE session_id = ? AND source = 'harness'").run(sessionId);
      for (const fact of facts) store(`history:${sessionId}:${fact.id}`, sessionId, "harness", fact.kind, fact.at, fact.data);
      flush(sessionId);
      db.exec("RELEASE history_metrics");
    } catch (err) {
      db.exec("ROLLBACK TO history_metrics");
      db.exec("RELEASE history_metrics");
      throw err;
    }
  }

  return { ingest: (raw) => deps.bus.batch(() => ingestBatch(raw)), recordHarnessEvent, recordBaseline, replaceHistory };
}
