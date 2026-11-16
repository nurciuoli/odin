import { test } from "node:test";
import assert from "node:assert/strict";
import { restartPolicy } from "./backoff.ts";

test("delays 1, 2, 5, 5, 5 s then gives up within 2 minutes", () => {
  const p = restartPolicy();
  const got = [0, 10_000, 20_000, 30_000, 40_000, 50_000].map((t) => p.next(t));
  assert.deepEqual(got, [1000, 2000, 5000, 5000, 5000, null]);
});

test("old attempts fall out of the 2 minute window", () => {
  const p = restartPolicy();
  for (let i = 0; i < 5; i++) p.next(i * 1000);
  assert.equal(p.next(10_000), null);
  assert.equal(p.next(125_000), 1000);
});

test("reset clears history", () => {
  const p = restartPolicy();
  for (let i = 0; i < 5; i++) p.next(i);
  p.reset();
  assert.equal(p.next(10), 1000);
});
