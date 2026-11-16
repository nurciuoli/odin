import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { MessageQueue, QueuedMessage, UserMessage } from "@odin/shared/api";
import { HttpError } from "../http/util.ts";

interface MessageRow { id: string; payload: string; state: QueuedMessage["state"]; created_at: string; updated_at: string }

/** Synchronous transitions reserve a message before any async runtime operation. */
export function messageOutbox(db: DatabaseSync, now: () => string, changed: (id: string, queue: MessageQueue) => void) {
  const fingerprint = (message: UserMessage) => createHash("sha256").update(JSON.stringify(message)).digest("hex");
  function ensure(id: string) { db.prepare("INSERT OR IGNORE INTO session_message_queues(session_id) VALUES (?)").run(id); }
  function snapshot(id: string): MessageQueue {
    const q = db.prepare("SELECT paused, revision FROM session_message_queues WHERE session_id = ?").get(id) as { paused: number; revision: number } | undefined;
    const rows = db.prepare("SELECT * FROM session_messages WHERE session_id = ? AND state IN ('queued','sending','uncertain') ORDER BY sort_order, sequence").all(id) as unknown as MessageRow[];
    return { paused: !!q?.paused, revision: q?.revision ?? 0, messages: rows.map(r => ({ id: r.id, message: JSON.parse(r.payload), state: r.state, createdAt: r.created_at, updatedAt: r.updated_at })) };
  }
  function publish(id: string) {
    db.prepare("UPDATE session_message_queues SET revision = revision + 1 WHERE session_id = ?").run(id);
    const q = snapshot(id); changed(id, q); return q;
  }
  function pause(id: string) {
    ensure(id);
    if (db.prepare("UPDATE session_message_queues SET paused = 1 WHERE session_id = ? AND paused = 0").run(id).changes) return publish(id);
    return snapshot(id);
  }
  function change(id: string, messageId: string, from: string, to: string, message?: UserMessage) {
    const r = db.prepare("SELECT state FROM session_messages WHERE session_id = ? AND id = ?").get(id, messageId) as { state: string } | undefined;
    if (!r) throw new HttpError(404, "unknown queued message");
    if (r.state !== from) throw new HttpError(409, "that message can no longer be changed");
    db.prepare("UPDATE session_messages SET state = ?, payload = COALESCE(?, payload), updated_at = ? WHERE session_id = ? AND id = ? AND state = ?")
      .run(to, to === "cancelled" ? "{}" : message ? JSON.stringify(message) : null, now(), id, messageId, from);
    return publish(id);
  }
  return {
    snapshot, pause,
    duplicate(id: string, message: UserMessage) {
      if (!message.clientId) return false;
      const old = db.prepare("SELECT request_hash FROM session_messages WHERE session_id = ? AND client_id = ?").get(id, message.clientId) as { request_hash: string } | undefined;
      if (!old) return false;
      if (old.request_hash !== fingerprint(message)) throw new HttpError(409, "this message id was already used for different content");
      return true;
    },
    recover() {
      db.prepare("UPDATE session_messages SET state = 'uncertain', updated_at = ? WHERE state = 'sending'").run(now());
      db.prepare("UPDATE session_message_queues SET paused = 1, revision = revision + 1 WHERE session_id IN (SELECT session_id FROM session_messages WHERE state IN ('queued','uncertain'))").run();
    },
    enqueue(id: string, message: UserMessage) {
      ensure(id);
      const payload = JSON.stringify(message);
      if (message.clientId) {
        const old = db.prepare("SELECT request_hash FROM session_messages WHERE session_id = ? AND client_id = ?").get(id, message.clientId) as { request_hash: string } | undefined;
        if (old) {
          if (old.request_hash !== fingerprint(message)) throw new HttpError(409, "this message id was already used for different content");
          return false;
        }
      }
      if (!snapshot(id).messages.length) db.prepare("UPDATE session_message_queues SET paused = 0 WHERE session_id = ?").run(id);
      db.prepare("INSERT INTO session_messages(sort_order,id,session_id,client_id,request_hash,payload,state,created_at,updated_at) VALUES ((SELECT COALESCE(MAX(sort_order),0)+1 FROM session_messages WHERE session_id=?),?,?,?,?,?,'queued',?,?)")
        .run(id, randomUUID(), id, message.clientId ?? null, fingerprint(message), payload, now(), now());
      publish(id); return true;
    },
    /** Puts this message ahead of every other receipt. A duplicate of queued work is moved forward; any other duplicate is left alone. */
    enqueueNext(id: string, message: UserMessage) {
      ensure(id);
      const hash = fingerprint(message);
      const front = () => {
        const row = db.prepare("SELECT MIN(sort_order) AS n FROM session_messages WHERE session_id = ?").get(id) as { n: number | null };
        return (row.n ?? 0) - 1;
      };
      if (message.clientId) {
        const old = db.prepare("SELECT id, state, request_hash FROM session_messages WHERE session_id = ? AND client_id = ?").get(id, message.clientId) as { id: string; state: string; request_hash: string } | undefined;
        if (old) {
          if (old.request_hash !== hash) throw new HttpError(409, "this message id was already used for different content");
          if (old.state !== "queued") return false;
          db.prepare("UPDATE session_messages SET sort_order = ? WHERE id = ?").run(front(), old.id);
          publish(id);
          return true;
        }
      }
      const at = now();
      db.prepare("INSERT INTO session_messages(sort_order,id,session_id,client_id,request_hash,payload,state,created_at,updated_at) VALUES (?,?,?,?,?,?,'queued',?,?)")
        .run(front(), randomUUID(), id, message.clientId ?? null, hash, JSON.stringify(message), at, at);
      publish(id);
      return true;
    },
    reserve(id: string) {
      const q = snapshot(id);
      if (q.paused || q.messages.some(m => m.state !== "queued")) return null;
      const m = q.messages[0];
      if (!m) return null;
      change(id, m.id, "queued", "sending");
      return m;
    },
    settle(id: string, completed: boolean) {
      const result = db.prepare("UPDATE session_messages SET state = ?, payload = CASE WHEN ? THEN '{}' ELSE payload END, updated_at = ? WHERE session_id = ? AND state = 'sending'").run(completed ? "completed" : "uncertain", completed ? 1 : 0, now(), id);
      if (result.changes) publish(id);
    },
    edit(id: string, messageId: string, message: UserMessage) {
      const existing = snapshot(id).messages.find(m => m.id === messageId);
      const edited = { text: message.text, ...(message.attachments?.length ? { attachments: message.attachments } : {}), ...(existing?.message.clientId ? { clientId: existing.message.clientId } : {}) };
      return change(id, messageId, "queued", "queued", edited);
    },
    cancel(id: string, messageId: string) {
      const message = snapshot(id).messages.find(m => m.id === messageId);
      if (!message) throw new HttpError(404, "unknown queued message");
      if (message.state === "sending") throw new HttpError(409, "that message can no longer be changed");
      return change(id, messageId, message.state, "cancelled");
    },
    retry(id: string, messageId: string) { pause(id); return change(id, messageId, "uncertain", "queued"); },
    resume(id: string) {
      ensure(id);
      if (snapshot(id).messages.some(m => m.state === "uncertain")) throw new HttpError(409, "resolve uncertain messages before resuming the queue");
      db.prepare("UPDATE session_message_queues SET paused = 0 WHERE session_id = ?").run(id);
      return publish(id);
    },
  };
}
