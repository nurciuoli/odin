import { test } from "node:test";
import assert from "node:assert/strict";
import { INGEST_KINDS } from "@odin/shared/ingest";
import { MAX_TEXT, validateEvent } from "./validate.ts";

const base = { id: "e1", ts: "2026-10-17T12:00:00+02:00", harness: "claude-code", session: "s1" };
const ok = (raw: unknown) => {
  const v = validateEvent(raw);
  assert.ok(v.ok, v.ok ? "" : v.error);
  return v.event;
};
const rejected = (raw: unknown) => {
  const v = validateEvent(raw);
  assert.equal(v.ok, false);
  return v as { ok: false; id: string; error: string };
};

test("a valid event is normalised: ISO timestamp, absent optional keys dropped", () => {
  const e = ok({ ...base, kind: "message", data: { text: "hi" }, project: "demo" });
  assert.deepEqual(e, { id: "e1", ts: "2026-10-17T10:00:00.000Z", harness: "claude-code", session: "s1", project: "demo", kind: "message", data: { text: "hi" } });
});

test("unknown fields never survive, at the top level or in data", () => {
  const e = ok({ ...base, kind: "tool", extra: 1, data: { name: "Bash", ok: true, secret: "x" } });
  assert.deepEqual(Object.keys(e).sort(), ["data", "harness", "id", "kind", "session", "ts"]);
  assert.deepEqual(e.data, { name: "Bash", ok: true });
});

test("long strings are truncated, not rejected", () => {
  const e = ok({ ...base, kind: "message", data: { text: "x".repeat(MAX_TEXT + 500) } });
  assert.equal((e.data as { text: string }).text.length, MAX_TEXT);
});

test("every kind has a valid minimal shape", () => {
  const data: Record<string, unknown> = {
    "session.started": {},
    "session.ended": { outcome: "completed" },
    turn: { index: 0, durationMs: 10 },
    tool: { name: "Read", ok: false },
    usage: { model: "m" },
    message: { text: "t" },
    error: { message: "boom" },
  };
  assert.deepEqual(Object.keys(data).sort(), [...INGEST_KINDS].sort());
  for (const kind of INGEST_KINDS) assert.equal(ok({ ...base, kind, data: data[kind] }).kind, kind);
});

test("usage counters default to 0 and cumulative is only kept when true", () => {
  assert.deepEqual(ok({ ...base, kind: "usage", data: { model: "m", input: 5, cumulative: "yes" } }).data, { model: "m", input: 5, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal((ok({ ...base, kind: "usage", data: { model: "m", cumulative: true } }).data as { cumulative?: boolean }).cumulative, true);
});

test("invalid events are rejected with the field at fault", () => {
  const cases: [string, unknown, RegExp][] = [
    ["not an object", [1], /event must be an object/],
    ["null", null, /event must be an object/],
    ["missing id", { ...base, id: undefined, kind: "message", data: { text: "t" } }, /id is required/],
    ["blank session", { ...base, session: "  ", kind: "message", data: { text: "t" } }, /session must not be empty/],
    ["bad ts", { ...base, ts: "yesterday", kind: "message", data: { text: "t" } }, /ts must be an ISO-8601 time/],
    ["non-string harness", { ...base, harness: 3, kind: "message", data: { text: "t" } }, /harness must be a string/],
    ["unknown kind", { ...base, kind: "nope", data: {} }, /unknown kind "nope"/],
    ["data not an object", { ...base, kind: "message", data: "x" }, /data must be an object/],
    ["bad outcome", { ...base, kind: "session.ended", data: { outcome: "cancelled" } }, /outcome must be completed or failed/],
    ["tool ok not boolean", { ...base, kind: "tool", data: { name: "x", ok: "yes" } }, /ok must be a boolean/],
    ["negative duration", { ...base, kind: "turn", data: { index: 0, durationMs: -1 } }, /durationMs must be a non-negative number/],
    ["NaN index", { ...base, kind: "turn", data: { index: NaN, durationMs: 1 } }, /index must be a non-negative number/],
    ["message without text", { ...base, kind: "message", data: {} }, /text is required/],
  ];
  for (const [name, raw, error] of cases) assert.match(rejected(raw).error, error, name);
});

test("a rejection carries the event id, capped at 80 characters", () => {
  assert.equal(rejected({ ...base, id: "i".repeat(200), kind: "nope", data: {} }).id.length, 80);
  assert.equal(rejected("junk").id, "");
});
