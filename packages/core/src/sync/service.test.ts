import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { startApp } from "../test-helpers.ts";
import { FakeGitHub } from "./fake-github.ts";
import { closesFromBody, prOutcome } from "./service.ts";
import { syncStack } from "./test-fakes.ts";

test("GitHub is off by default even with a repository and credentials", async () => {
  const s = syncStack();
  try {
    assert.equal(s.sync.status("odin").state, "off");
    await s.sync.syncNow("odin");
    assert.equal(s.gh.requests.length, 0);
  } finally { await s.close(); }
});

test("enabled sync reads PRs and updates session outcomes without mirroring or remote writes", async () => {
  const s = syncStack();
  try {
    s.projects.get("odin")!.settings.githubEnabled = true;
    s.sessions.add({ id: "worker", branch: "work/w-test1" });
    s.gh.addIssue({ title: "Not mirrored" });
    const pr = s.gh.addPull({ number: 42, head: { ref: "work/w-test1" }, body: "Closes #3" }, ["a.ts"]);
    await s.sync.syncNow("odin");
    assert.equal(s.sessions.get("worker")?.pull?.number, 42);
    assert.equal(s.sync.pullForBranch("odin", "work/w-test1")?.url, pr.html_url);
    const patchCount = s.sessions.patches.length;
    const requestCount = s.gh.requests.length;
    await s.sync.syncNow("odin");
    assert.equal(s.sessions.patches.length, patchCount, "unchanged PRs do not revive session activity");
    assert.equal(s.gh.requests.length - requestCount, 1, "unchanged PRs reuse file and review details");
    s.gh.editPull(42, { state: "closed", merged_at: s.gh.tick() }, ["CHANGES_REQUESTED", "APPROVED"]);
    await s.sync.syncNow("odin");
    assert.equal(s.sessions.get("worker")?.metrics.prOutcome, "merged-after-changes");
    assert.ok(s.gh.requests.every((r) => r.method === "GET"));
    assert.ok(s.gh.requests.every((r) => !/\/issues|\/milestones/.test(r.url)));
  } finally { await s.close(); }
});

test("failed PR reads expose a scrubbed error and recover on retry", async () => {
  const s = syncStack();
  try {
    s.projects.get("odin")!.settings.githubEnabled = true;
    s.gh.failWith = { status: 500, message: s.gh.token };
    await s.sync.syncNow("odin");
    assert.equal(s.sync.status("odin").state, "error");
    assert.ok(!JSON.stringify(s.deps.events).includes(s.gh.token));
    s.gh.failWith = null;
    await s.sync.syncNow("odin");
    assert.equal(s.sync.status("odin").state, "idle");
  } finally { await s.close(); }
});

test("PR metadata helpers", () => {
  assert.deepEqual(closesFromBody("Closes #4, fixes #2, closes #4"), [2, 4]);
  assert.equal(prOutcome({ state: "closed", merged: true, reviewRounds: 0 }), "merged");
  assert.equal(prOutcome({ state: "closed", merged: false, reviewRounds: 0 }), "closed");
});
