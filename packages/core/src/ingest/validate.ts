// Per-event validation for POST /api/ingest. Returns a sanitised copy: only known fields survive, long strings are
// truncated, so nothing a producer stuffs into `data` is stored.
import { INGEST_KINDS, type IngestEvent, type IngestKind } from "@odin/shared/ingest";

export const MAX_TARGET = 200;
export const MAX_TEXT = 2000;
const MAX_ID = 200;
const MAX_SHORT = 500;

export type Validated = { ok: true; event: IngestEvent } | { ok: false; id: string; error: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const cut = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);

class Invalid extends Error {}
const bad = (msg: string): never => {
  throw new Invalid(msg);
};

function str(o: Record<string, unknown>, key: string, max: number, required = false): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return required ? bad(`${key} is required`) : undefined;
  if (typeof v !== "string") return bad(`${key} must be a string`);
  if (required && !v.trim()) return bad(`${key} must not be empty`);
  return cut(v, max);
}

function num(o: Record<string, unknown>, key: string, required: boolean, dflt?: number): number | undefined {
  const v = o[key];
  if (v === undefined || v === null) return required ? bad(`${key} is required`) : dflt;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return bad(`${key} must be a non-negative number`);
  return v;
}

export function validateEvent(raw: unknown): Validated {
  const id = isObject(raw) && typeof raw.id === "string" ? cut(raw.id, 80) : "";
  try {
    if (!isObject(raw)) return bad("event must be an object");
    const eid = str(raw, "id", MAX_ID, true)!;
    const ts = str(raw, "ts", 64, true)!;
    if (Number.isNaN(Date.parse(ts))) bad("ts must be an ISO-8601 time");
    const harness = str(raw, "harness", 64, true)!;
    const session = str(raw, "session", MAX_ID, true)!;
    const kind = raw.kind as IngestKind;
    if (!INGEST_KINDS.includes(kind)) bad(`unknown kind ${JSON.stringify(String(raw.kind).slice(0, 40))}`);
    if (!isObject(raw.data)) bad("data must be an object");
    const d = raw.data as Record<string, unknown>;

    const base = {
      id: eid,
      ts: new Date(ts).toISOString(),
      harness,
      session,
      project: str(raw, "project", MAX_SHORT),
      cwd: str(raw, "cwd", 1024),
      branch: str(raw, "branch", MAX_SHORT),
      agent: str(raw, "agent", 80),
    };
    // Drop absent keys so stored/compared events stay tidy.
    for (const k of Object.keys(base) as (keyof typeof base)[]) if (base[k] === undefined) delete base[k];

    let data: Record<string, unknown>;
    switch (kind) {
      case "session.started":
        data = { model: str(d, "model", 200), title: str(d, "title", MAX_SHORT), source: str(d, "source", 40) };
        break;
      case "session.ended": {
        if (d.outcome !== "completed" && d.outcome !== "failed") bad("outcome must be completed or failed");
        data = { outcome: d.outcome, error: str(d, "error", MAX_TEXT) };
        break;
      }
      case "turn":
        data = { index: num(d, "index", true), durationMs: num(d, "durationMs", true), model: str(d, "model", 200) };
        break;
      case "tool": {
        if (typeof d.ok !== "boolean") bad("ok must be a boolean");
        data = { name: str(d, "name", 100, true), target: str(d, "target", MAX_TARGET), ok: d.ok, durationMs: num(d, "durationMs", false) };
        break;
      }
      case "usage":
        data = {
          model: str(d, "model", 200, true),
          input: num(d, "input", false, 0),
          output: num(d, "output", false, 0),
          cacheRead: num(d, "cacheRead", false, 0),
          cacheWrite: num(d, "cacheWrite", false, 0),
          cumulative: d.cumulative === true ? true : undefined,
        };
        break;
      case "message":
        data = { text: str(d, "text", MAX_TEXT, true) };
        break;
      case "error":
        data = { message: str(d, "message", MAX_TEXT, true) };
        break;
    }
    for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k];
    return { ok: true, event: { ...base, kind, data } as unknown as IngestEvent };
  } catch (err) {
    if (err instanceof Invalid) return { ok: false, id, error: err.message };
    throw err;
  }
}
