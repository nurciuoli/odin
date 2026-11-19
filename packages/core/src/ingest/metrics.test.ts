import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelPrice } from "@odin/shared/api";
import { baselineFrom, computeMetrics, modelTotals, type FactRow } from "./metrics.ts";

const at = (s: number) => new Date(Date.UTC(2026, 9, 17, 12, 0, s)).toISOString();
const usage = (s: number, model: string, d: Record<string, unknown>): FactRow => ({ kind: "usage", ts: at(s), data: { model, ...d } });
const NO_PRICES: Record<string, ModelPrice> = {};

test("no facts: nothing is invented", () => {
  const { metrics, topModel } = computeMetrics([], NO_PRICES);
  assert.equal(topModel, null);
  assert.deepEqual(metrics, { wallMs: null, activeMs: null, turns: 0, toolCalls: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, tokensByModel: {}, costUsd: null, contextTokens: null });
});

test("turns, tools and wall time come from the facts; active time needs every turn's duration", () => {
  const rows: FactRow[] = [
    { kind: "turn", ts: at(0), data: { durationMs: 1000 } },
    { kind: "tool", ts: at(5), data: {} },
    { kind: "tool", ts: at(6), data: {} },
    { kind: "turn", ts: at(60), data: { durationMs: 2500 } },
  ];
  const { metrics } = computeMetrics(rows, NO_PRICES);
  assert.deepEqual([metrics.turns, metrics.toolCalls, metrics.wallMs, metrics.activeMs], [2, 2, 60_000, 3500]);
  rows.push({ kind: "turn", ts: at(70), data: { durationMs: null } });
  assert.equal(computeMetrics(rows, NO_PRICES).metrics.activeMs, null);
});

test("incremental usage adds up per model; a cumulative report replaces what came before", () => {
  const rows = [usage(0, "a", { input: 10, output: 1, costUsd: 0.5 }), usage(1, "a", { input: 5, output: 2, costUsd: 0.25 }), usage(2, "b", { input: 1, output: 9 })];
  const totals = modelTotals(rows);
  assert.deepEqual(totals.get("a")!.usage, { input: 15, output: 3, cacheRead: 0, cacheWrite: 0 });
  assert.equal(totals.get("a")!.costUsd, 0.75);
  const { metrics, topModel } = computeMetrics([...rows, usage(3, "a", { input: 100, output: 4, cumulative: true })], NO_PRICES);
  assert.equal(metrics.tokensByModel.a!.input, 100);
  assert.equal(metrics.tokens.input, 101);
  assert.equal(topModel, "b");
});

test("junk numbers count as zero", () => {
  const { metrics } = computeMetrics([usage(0, "a", { input: -5, output: "7", cacheRead: Infinity })], NO_PRICES);
  assert.deepEqual(metrics.tokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("cost: list price when the model is priced, else the harness's own cost, else unknown", () => {
  const rows = [usage(0, "priced", { input: 1_000_000, costUsd: 99 }), usage(1, "free", { input: 5, costUsd: 0.5 })];
  const price: ModelPrice = { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 };
  assert.equal(computeMetrics([rows[0]!], { priced: price }).metrics.costUsd, 3);
  assert.equal(computeMetrics([rows[1]!], NO_PRICES).metrics.costUsd, 0.5);
  assert.equal(computeMetrics([usage(0, "x", { input: 1 })], NO_PRICES).metrics.costUsd, null);
});

test("a fork subtracts the parent's baseline, but only from cumulative reports", () => {
  const parent = [usage(0, "a", { input: 100, output: 10, costUsd: 1, cumulative: true })];
  const baseline = baselineFrom(parent);
  assert.deepEqual(baseline.a, { usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }, costUsd: 1 });
  const child = computeMetrics([usage(5, "a", { input: 130, output: 14, costUsd: 1.3, cumulative: true })], NO_PRICES, baseline).metrics;
  assert.deepEqual(child.tokensByModel.a, { input: 30, output: 4, cacheRead: 0, cacheWrite: 0 });
  assert.equal(Math.round(child.costUsd! * 100) / 100, 0.3);
  const incremental = computeMetrics([usage(5, "a", { input: 30, output: 4 })], NO_PRICES, baseline).metrics;
  assert.equal(incremental.tokensByModel.a!.input, 30);
});

test("context size and window are the latest values reported", () => {
  const { metrics } = computeMetrics([usage(0, "a", { contextTokens: 10, contextWindow: 200 }), usage(1, "a", { contextTokens: 25 })], NO_PRICES);
  assert.deepEqual([metrics.contextTokens, metrics.contextWindow], [25, 200]);
});
