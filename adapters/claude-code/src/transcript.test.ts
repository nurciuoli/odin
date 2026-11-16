import { test } from "node:test";
import assert from "node:assert/strict";
import { FIXTURE, assistant, user } from "./test-fixtures.ts";
import { TranscriptScan, parseTranscript } from "./transcript.ts";

test("usage is de-duplicated by message id and split per model; junk lines are skipped", () => {
  const { usage } = parseTranscript(FIXTURE);
  assert.deepEqual(usage, {
    "claude-sonnet-5-5": { input: 300, output: 100, cacheRead: 2200, cacheWrite: 50 },
    "claude-haiku-4-5": { input: 10, output: 7, cacheRead: 0, cacheWrite: 0 },
  });
});

test("turns are one per assistant message, timed from the preceding user line", () => {
  const { turns } = parseTranscript(FIXTURE);
  assert.deepEqual(turns, [
    { index: 1, durationMs: 4000, model: "claude-sonnet-5-5", ts: "2026-10-17T10:00:04.000Z" },
    { index: 2, durationMs: 1500, model: "claude-haiku-4-5", ts: "2026-10-17T10:00:06.500Z" },
    { index: 3, durationMs: 3000, model: "claude-sonnet-5-5", ts: "2026-10-17T10:00:10.000Z" },
  ]);
});

test("sidechain lines count toward usage but not turns", () => {
  const text = [user("2026-10-17T10:00:00.000Z"), assistant("a", "m", "2026-10-17T10:00:01.000Z", { output_tokens: 3 }, { isSidechain: true })].join("\n");
  const s = parseTranscript(text);
  assert.equal(s.usage.m?.output, 3);
  assert.equal(s.turns.length, 0);
});

test("a scan shares de-duplication across transcripts", () => {
  const scan = new TranscriptScan();
  scan.add(FIXTURE, true);
  scan.add(assistant("msg_3", "claude-sonnet-5-5", "2026-10-17T10:00:10.000Z", { input_tokens: 200, output_tokens: 60, cache_read_input_tokens: 1200 }));
  scan.add(assistant("sub_1", "claude-haiku-4-5", "2026-10-17T10:00:12.000Z", { input_tokens: 1, output_tokens: 1 }));
  assert.equal(scan.usage()["claude-sonnet-5-5"]?.input, 300);
  assert.equal(scan.usage()["claude-haiku-4-5"]?.input, 11);
});

test("empty and garbage input give an empty summary", () => {
  assert.deepEqual(parseTranscript(""), { usage: {}, turns: [] });
  assert.deepEqual(parseTranscript("[1,2]\nnull\n42\n{"), { usage: {}, turns: [] });
});
