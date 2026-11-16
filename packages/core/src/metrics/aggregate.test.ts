import { test } from "node:test";
import assert from "node:assert/strict";
import type { Session, SessionMetrics } from "@odin/shared/api";
import { makeSession } from "../ingest/fakes.ts";
import { aggregate, keyOf, median } from "./aggregate.ts";

const s = (id: string, over: Partial<Session> = {}, metrics: Partial<SessionMetrics> = {}): Session => {
  const base = makeSession({ id, ...over });
  return { ...base, metrics: { ...base.metrics, turns: 1, ...metrics } };
};

test("an empty population gives no rows", () => {
  assert.deepEqual(aggregate([], ["model"]), []);
  assert.deepEqual(aggregate([s("a", {}, { turns: 0 })], ["model"]), []);
});

test("median: ignores unknowns, averages the middle pair when even, null when nothing is known", () => {
  assert.equal(median([3, null, 1, undefined, 2]), 2);
  assert.equal(median([1, 2, 3, 10]), 2.5);
  assert.equal(median([]), null);
  assert.equal(median([null]), null);
  assert.equal(median([7]), 7);
});

test("sessions without turns and archived sessions are left out", () => {
  const rows = aggregate([s("a"), s("b", { archived: true }), s("c", {}, { turns: 0 })], ["project"]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]!.sessionIds, ["a"]);
});

test("keys: normalised model, agentVersion as agent@8, ∅ when unknown", () => {
  const x = s("a", { model: "anthropic/claude-opus-5-5[1m]", agent: "reviewer", agentVersion: "0123456789abcdef", templateId: "t1" });
  assert.equal(keyOf(x, "model"), "claude-opus-5-5");
  assert.equal(keyOf(x, "agentVersion"), "reviewer@01234567");
  assert.equal(keyOf(x, "template"), "t1");
  const y = s("b");
  for (const dim of ["model", "agent", "agentVersion", "template"] as const) assert.equal(keyOf(y, dim), "∅");
  assert.equal(keyOf(s("c", { agent: "r", agentVersion: null }), "agentVersion"), "∅");
  assert.deepEqual(aggregate([y], ["model", "agent"])[0]!.key, { model: "∅", agent: "∅" });
});

test("medians over known values and rates with their denominators", () => {
  const rows = aggregate(
    [
      s("a", { model: "m" }, { wallMs: 1000, activeMs: 100, turns: 2, toolCalls: 4, tokens: { input: 0, output: 10, cacheRead: 0, cacheWrite: 0 }, costUsd: 1, diff: { added: 5, removed: 5, files: 1 }, prOutcome: "merged" }),
      s("b", { model: "m" }, { wallMs: 3000, turns: 4, toolCalls: 6, tokens: { input: 0, output: 30, cacheRead: 0, cacheWrite: 0 }, costUsd: null, prOutcome: "merged-after-changes" }),
      s("c", { model: "m", state: "failed" }, { wallMs: null, turns: 3, prOutcome: "closed" }),
      s("d", { model: "m" }, { prOutcome: "open" }),
    ],
    ["model"],
  );
  assert.equal(rows.length, 1);
  const r = rows[0]!;
  assert.equal(r.n, 4);
  assert.equal(r.lowConfidence, false);
  assert.deepEqual(r.median, { wallMs: 2000, activeMs: 100, turns: 2.5, toolCalls: 2, tokensOut: 5, costUsd: 1, diffLines: 10 });
  // Denominator: merged, merged-after-changes, closed = 3.
  assert.equal(r.rates.merged, 2 / 3);
  assert.equal(r.rates.mergedClean, 1 / 3);
  assert.equal(r.rates.failed, 1 / 4);
});

test("rates are null with no decided PR; low confidence under three sessions", () => {
  const [r] = aggregate([s("a"), s("b")], ["project"]);
  assert.equal(r!.lowConfidence, true);
  assert.equal(r!.rates.merged, null);
  assert.equal(r!.rates.mergedClean, null);
  assert.equal(r!.rates.failed, 0);
  assert.equal(r!.median.costUsd, null);
  assert.equal(r!.median.diffLines, null);
});

test("rows sort by n descending, ties by key", () => {
  const rows = aggregate([s("1", { model: "b" }), s("2", { model: "a" }), s("3", { model: "c" }), s("4", { model: "c" })], ["model"]);
  assert.deepEqual(rows.map((r) => r.key.model), ["c", "a", "b"]);
});

test("three dimensions group on the combination", () => {
  const rows = aggregate([s("1", { model: "a", agent: "x" }), s("2", { model: "a", agent: "y" }), s("3", { model: "a", agent: "x" })], ["model", "agent", "origin"]);
  assert.deepEqual(rows.map((r) => [r.key.agent, r.n]), [["x", 2], ["y", 1]]);
});
