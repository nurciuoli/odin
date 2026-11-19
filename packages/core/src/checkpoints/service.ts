// CheckpointsService: per-turn file snapshots in a shadow git store and rewind. docs/contracts.md#checkpoints.
import { join } from "node:path";
import type { Checkpoint, CheckpointDiff, RestoreCheckpointRequest, RestoreCheckpointResult } from "@odin/shared/api";
import { HttpError } from "../http/util.ts";
import type { CheckpointsService, Deps, Services } from "../services.ts";
import { CheckpointStore } from "./store.ts";

export const DEFAULT_MAX_COUNT = 200;
export const DEFAULT_MAX_BYTES = 500 * 1024 * 1024;
const BYTES_CHECK_EVERY = 25;

interface Row {
  session_id: string;
  id: string;
  kind: "turn" | "pre-restore";
  message_id: string | null;
  turn: number;
  at: string;
  before_tree: string | null;
  end_tree: string | null;
  files: string | null;
  snapshot: "ok" | "skipped" | "failed";
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createCheckpointsService(deps: Deps, services: Services): CheckpointsService {
  const { db, bus } = deps;
  const root = join(deps.config.home, "checkpoints");
  const stores = new Map<string, CheckpointStore>();
  /** Before-trees taken by `turn.prepare`, waiting for the user entry that names the message. */
  const pending = new Map<string, { tree: string | null; snapshot: Row["snapshot"]; at: string }>();
  let inserts = 0;

  const store = (project: string) => {
    let s = stores.get(project);
    if (!s) stores.set(project, (s = new CheckpointStore(root, project)));
    return s;
  };
  const enabled = (project: string) => services.projects.get(project)?.settings.checkpoints?.enabled !== false;

  function toCheckpoint(r: Row): Checkpoint {
    return { id: r.id, sessionId: r.session_id, kind: r.kind, messageId: r.message_id, turn: r.turn, at: r.at, files: r.files ? JSON.parse(r.files) : null, snapshot: r.snapshot };
  }
  const rows = (sessionId: string) => db.prepare("SELECT * FROM checkpoints WHERE session_id = ? ORDER BY turn, at, id").all(sessionId) as unknown as Row[];
  function row(sessionId: string, id: string): Row {
    const r = db.prepare("SELECT * FROM checkpoints WHERE session_id = ? AND id = ?").get(sessionId, id) as unknown as Row | undefined;
    if (!r) throw new HttpError(404, `unknown checkpoint ${id}`);
    return r;
  }
  function mustSession(id: string) {
    const s = services.sessions.get(id);
    if (!s) throw new HttpError(404, `unknown session ${id}`);
    return s;
  }
  function emit(r: Row): void {
    bus.emit({ type: "checkpoint.updated", sessionId: r.session_id, checkpoint: toCheckpoint(r) });
  }
  function insert(r: Row): void {
    db.prepare("INSERT INTO checkpoints (session_id, id, kind, message_id, turn, at, before_tree, end_tree, files, snapshot) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(r.session_id, r.id, r.kind, r.message_id, r.turn, r.at, r.before_tree, r.end_tree, r.files, r.snapshot);
  }
  const nextTurn = (sessionId: string) => ((db.prepare("SELECT MAX(turn) AS t FROM checkpoints WHERE session_id = ? AND kind = 'turn'").get(sessionId) as { t: number | null }).t ?? 0) + 1;

  /** Trees in `candidates` that no remaining row references. */
  function unreferenced(candidates: Iterable<string>): string[] {
    const used = db.prepare("SELECT 1 FROM checkpoints WHERE before_tree = ?1 OR end_tree = ?1 LIMIT 1");
    return [...new Set(candidates)].filter((t) => !used.get(t));
  }
  const treesOf = (rs: Row[]) => rs.flatMap((r) => [r.before_tree, r.end_tree]).filter((t): t is string => !!t);

  async function prune(project: string): Promise<void> {
    const settings = services.projects.get(project)?.settings.checkpoints;
    const maxCount = settings?.maxCount ?? DEFAULT_MAX_COUNT;
    const maxBytes = settings?.maxBytes ?? DEFAULT_MAX_BYTES;
    const where = "session_id IN (SELECT id FROM sessions WHERE project = ?)";
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM checkpoints WHERE ${where}`).get(project) as { n: number }).n;
    let drop = Math.max(0, count - maxCount);
    if (inserts % BYTES_CHECK_EVERY === 0 && (await store(project).bytes()) > maxBytes) drop = Math.max(drop, Math.ceil(count / 4));
    if (!drop) return;
    const old = db.prepare(`SELECT * FROM checkpoints WHERE ${where} ORDER BY at, turn LIMIT ?`).all(project, drop) as unknown as Row[];
    const del = db.prepare("DELETE FROM checkpoints WHERE session_id = ? AND id = ?");
    for (const r of old) del.run(r.session_id, r.id);
    await store(project).release(unreferenced(treesOf(old)), true);
  }

  function filesSummary(changes: { status: string }[]): Checkpoint["files"] {
    return { changed: changes.filter((c) => c.status === "modified").length, added: changes.filter((c) => c.status === "added").length, removed: changes.filter((c) => c.status === "removed").length };
  }

  return {
    list(sessionId) {
      mustSession(sessionId);
      return rows(sessionId).map(toCheckpoint);
    },

    async diff(sessionId, checkpointId, against = "turn"): Promise<CheckpointDiff> {
      const s = mustSession(sessionId);
      const r = row(sessionId, checkpointId);
      if (against !== "turn" && against !== "current") throw new HttpError(400, "against must be turn or current");
      if (!r.before_tree) throw new HttpError(409, "that checkpoint has no files");
      const st = store(s.project);
      if (against === "turn") {
        if (!r.end_tree) throw new HttpError(409, "that turn has not finished");
        const d = await st.diff(r.before_tree, r.end_tree);
        return { checkpointId, against, files: d.files, truncated: d.truncated };
      }
      const now = await st.snapshot(s.cwd);
      if (!now.ok) throw new HttpError(409, `the working tree could not be read: ${now.reason}`);
      const d = await st.diff(now.tree, r.before_tree);
      return { checkpointId, against, files: d.files, truncated: d.truncated };
    },

    async restore(sessionId, checkpointId, request: RestoreCheckpointRequest): Promise<RestoreCheckpointResult> {
      const s = mustSession(sessionId);
      if (!request || typeof request !== "object" || typeof request.files !== "boolean" || typeof request.conversation !== "boolean") throw new HttpError(400, "files and conversation must be booleans");
      if (!request.files && !request.conversation) throw new HttpError(400, "restore files, the conversation, or both");
      const r = row(sessionId, checkpointId);
      if (r.kind !== "turn" && request.conversation) throw new HttpError(400, "only a turn checkpoint can rewind the conversation");
      if (s.state === "running" || s.state === "waiting" || services.sessions.queue(sessionId).messages.length) throw new HttpError(409, "rewinding needs an idle session with an empty message queue");
      if (request.files && (!r.before_tree || r.snapshot !== "ok")) throw new HttpError(409, "that checkpoint has no files to restore");
      if (request.conversation && !r.message_id) throw new HttpError(409, "that checkpoint has no message to rewind to");
      const st = store(s.project);

      // The fork can fail on the harness, so it goes first: nothing on disk has changed yet.
      let session = s;
      if (request.conversation) session = await services.sessions.fork(sessionId, { atMessageId: r.message_id! });

      let undoCheckpointId: string | null = null;
      if (request.files) {
        const current = await st.snapshot(s.cwd);
        if (!current.ok) throw new HttpError(409, `the working tree could not be saved before restoring: ${current.reason}`);
        const k = (db.prepare("SELECT COUNT(*) AS n FROM checkpoints WHERE session_id = ? AND kind = 'pre-restore'").get(sessionId) as { n: number }).n + 1;
        const undo: Row = { session_id: sessionId, id: `${sessionId}:undo:${k}`, kind: "pre-restore", message_id: null, turn: r.turn, at: deps.now().toISOString(), before_tree: current.tree, end_tree: current.tree, files: null, snapshot: "ok" };
        insert(undo);
        emit(undo);
        undoCheckpointId = undo.id;
        try {
          await st.restore(s.cwd, current.tree, r.before_tree!);
        } catch (err) {
          throw new HttpError(500, `restoring files failed: ${errorMessage(err)}; the previous state is saved as ${undo.id}`);
        }
      }
      let archivedSessionId: string | null = null;
      if (request.conversation) {
        await services.sessions.update(sessionId, { archived: true });
        archivedSessionId = sessionId;
      }
      return { session, archivedSessionId, undoCheckpointId };
    },

    async capture(sessionId, phase, messageId) {
      try {
        const s = services.sessions.get(sessionId);
        if (!s || !enabled(s.project)) { pending.delete(sessionId); return; }
        const st = store(s.project);
        if (phase === "turn.prepare") {
          pending.delete(sessionId);
          const snap = await st.snapshot(s.cwd);
          pending.set(sessionId, { tree: snap.ok ? snap.tree : null, snapshot: snap.ok ? "ok" : snap.skipped ? "skipped" : "failed", at: deps.now().toISOString() });
          return;
        }
        if (phase === "turn.start") {
          const p = pending.get(sessionId);
          pending.delete(sessionId);
          if (!p || !messageId) return;
          if (db.prepare("SELECT 1 FROM checkpoints WHERE session_id = ? AND message_id = ? AND kind = 'turn'").get(sessionId, messageId)) return;
          const turn = nextTurn(sessionId);
          const r: Row = { session_id: sessionId, id: `${sessionId}:${turn}`, kind: "turn", message_id: messageId, turn, at: p.at, before_tree: p.tree, end_tree: null, files: null, snapshot: p.snapshot };
          insert(r);
          emit(r);
          inserts++;
          void prune(s.project).catch((err) => console.error(`checkpoint prune failed: ${errorMessage(err)}`));
          return;
        }
        const open = db.prepare("SELECT * FROM checkpoints WHERE session_id = ? AND kind = 'turn' AND end_tree IS NULL ORDER BY turn DESC LIMIT 1").get(sessionId) as unknown as Row | undefined;
        if (!open || open.snapshot !== "ok") return;
        const snap = await st.snapshot(s.cwd);
        if (!snap.ok) return;
        let files: Checkpoint["files"] = null;
        try { files = filesSummary((await st.diff(open.before_tree!, snap.tree)).all); } catch { /* summary is optional */ }
        const done: Row = { ...open, end_tree: snap.tree, files: files ? JSON.stringify(files) : null };
        db.prepare("UPDATE checkpoints SET end_tree = ?, files = ? WHERE session_id = ? AND id = ?").run(done.end_tree, done.files, sessionId, open.id);
        emit(done);
      } catch (err) {
        console.error(`checkpoint capture (${phase}) failed for ${sessionId}: ${errorMessage(err)}`);
      }
    },

    async materialize(sessionId, checkpointId, dir) {
      const s = mustSession(sessionId);
      const r = row(sessionId, checkpointId);
      if (!r.before_tree || r.snapshot !== "ok") throw new HttpError(409, "that checkpoint has no files");
      await store(s.project).materialize(dir, r.before_tree);
    },

    inherit(parentId, childId, uptoCheckpointId) {
      const cut = uptoCheckpointId ? row(parentId, uptoCheckpointId).turn : Number.POSITIVE_INFINITY;
      for (const r of rows(parentId)) {
        if (r.kind !== "turn" || r.turn >= cut) continue;
        insert({ ...r, session_id: childId, id: `${childId}:${r.turn}` });
      }
    },

    async forget(sessionId) {
      const own = rows(sessionId);
      const project = services.sessions.get(sessionId)?.project;
      pending.delete(sessionId);
      db.prepare("DELETE FROM checkpoints WHERE session_id = ?").run(sessionId);
      if (project && own.length) await store(project).release(unreferenced(treesOf(own)), true);
    },

    close() {},
  };
}
