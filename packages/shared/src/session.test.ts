import { test } from "node:test";
import assert from "node:assert/strict";
import { canTransition, emptyMetrics, isFinal, sessionBranch, slugify } from "./session.ts";

test("transitions", () => {
  assert.ok(canTransition("idle", "running"));
  assert.ok(canTransition("running", "waiting"));
  assert.ok(canTransition("ended", "running"));
  assert.ok(canTransition("running", "running"));
  assert.ok(!canTransition("ended", "waiting"));
  assert.ok(isFinal("failed") && !isFinal("idle"));
});

test("branch names", () => {
  assert.equal(slugify("Fix the Login — page!"), "fix-the-login-page");
  assert.equal(sessionBranch("Fix login", "1234abcd-5678-0000-0000-000000000000"), "odin/fix-login-1234abcd");
});

test("empty metrics", () => {
  assert.equal(emptyMetrics().costUsd, null);
  assert.deepEqual(emptyMetrics().tokensByModel, {});
});
