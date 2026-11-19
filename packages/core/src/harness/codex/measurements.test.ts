import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { rolloutMeasurements } from "./measurements.ts";
import { tempDir, removeTempDir } from "../../test-helpers.ts";

test("rollout usage separates cache, deduplicates mirrored records and keeps model changes", async () => {
  const root = tempDir("odin-codex-stats-");
  try {
    const file = join(root, "rollout.jsonl");
    const at = "2026-11-10T12:00:00Z";
    const total = { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 100, reasoning_output_tokens: 30, total_tokens: 1100 };
    writeFileSync(file, [
      { type: "session_meta", timestamp: at, payload: { id: "native" } },
      { type: "turn_context", timestamp: at, payload: { model: "model-a" } },
      { type: "token_usage_record", timestamp: at, payload: { thread_id: "native", thread_token_usage: total, usage: total } },
      { type: "event_msg", timestamp: at, payload: { type: "token_count", info: { total_token_usage: total, last_token_usage: total, model_context_window: 475000 } } },
      { type: "turn_context", timestamp: at, payload: { model: "model-b" } },
      { type: "token_usage_record", timestamp: at, payload: { thread_id: "native", thread_token_usage: { ...total, input_tokens: 1200, cached_input_tokens: 900, output_tokens: 150 }, usage: { input_tokens: 200, cached_input_tokens: 100, output_tokens: 50 } } },
      { type: "event_msg", timestamp: at, payload: { type: "token_count", info: { total_token_usage: { ...total, input_tokens: 1200, cached_input_tokens: 900, output_tokens: 150 }, last_token_usage: { total_tokens: 250 }, model_context_window: 300000 } } },
    ].map(r => JSON.stringify(r)).join("\n") + '\n{"incomplete":');
    const facts = await rolloutMeasurements(file, "native");
    assert.equal(facts?.length, 2);
    assert.deepEqual(facts?.map(f => f.kind === "usage" ? [f.data.model, f.data.input, f.data.cacheRead, f.data.output] : null), [
      ["model-a", 200, 800, 100], ["model-b", 100, 100, 50],
    ]);
    const latest = facts?.at(-1);
    assert.equal(latest?.kind === "usage" && latest.data.contextWindow, 300000);
    assert.equal(await rolloutMeasurements(file, "different-session"), null);
    assert.equal(await rolloutMeasurements(join(root, "missing.jsonl"), "native"), null);
  } finally { removeTempDir(root); }
});

test("native and legacy cumulative counters can diverge after compaction without inflating totals", async () => {
  const root = tempDir("odin-codex-counters-");
  try {
    const file = join(root, "rollout.jsonl");
    const timestamp = "2026-11-10T12:00:00Z";
    const rows = [
      { timestamp, type: "session_meta", payload: { id: "native" } },
      { timestamp, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, output_tokens: 10 } } } },
      { timestamp, type: "token_usage_record", payload: { response_id: "one", thread_token_usage: { input_tokens: 250, output_tokens: 25 } } },
      { timestamp, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 200, output_tokens: 20 } } } },
      { timestamp, type: "token_usage_record", payload: { response_id: "two", thread_token_usage: { input_tokens: 350, output_tokens: 35 } } },
      { timestamp, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 300, output_tokens: 30 } } } },
    ];
    writeFileSync(file, rows.map(r => JSON.stringify(r)).join("\n"));
    const facts = await rolloutMeasurements(file, "native");
    assert.equal(facts!.reduce((sum, f) => sum + (f.kind === "usage" ? f.data.input : 0), 0), 350);
    assert.equal(facts!.reduce((sum, f) => sum + (f.kind === "usage" ? f.data.output : 0), 0), 35);
    writeFileSync(file, rows.slice(0, 2).map(r => JSON.stringify(r)).join("\n"));
    const legacy = await rolloutMeasurements(file, "native");
    assert.equal(legacy!.length, 1);
    const first = legacy![0]!;
    assert.equal(first.kind === "usage" && first.data.output, 10);
  } finally { removeTempDir(root); }
});
