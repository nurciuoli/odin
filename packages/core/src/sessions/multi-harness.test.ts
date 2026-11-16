import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, PROJECT } from "./test-setup.ts";
import { fakeHarness } from "../harness/fake.ts";
import { createSettingsService } from "../settings/service.ts";
import { createIngestService } from "../ingest/service.ts";
import type { HarnessMeasurement } from "../harness/types.ts";

test("unsupported attachments and additional repositories are rejected before runtime side effects", async () => {
  const s = setup();
  const limited = fakeHarness({ id: "limited" });
  Object.assign(limited, { capabilities: { permissionModes: ["default"], permissionScopes: ["once"], attachments: false, additionalDirectories: false } });
  s.deps.harnesses.limited = limited;
  const prompt = { text: "hello", attachments: [{ name: "note.txt", mediaType: "text/plain", data: "text" }] };
  try {
    await assert.rejects(s.sessions.start({ project: PROJECT, harness: "limited", prompt }), /does not support attachments/);
    assert.equal(limited.starts.length, 0);
    const session = await s.sessions.start({ project: PROJECT, harness: "limited", prompt: { text: "plain" } });
    for (const action of [
      () => s.sessions.send(session.id, prompt),
      () => s.sessions.sendNow(session.id, prompt),
      () => s.sessions.fork(session.id, { prompt }),
    ]) await assert.rejects(action(), /does not support attachments/);
    assert.equal(s.sessions.queue(session.id).messages.length, 0);
    // Old persisted multi-project records receive the same check on fork/resume.
    s.deps.db.prepare("UPDATE sessions SET projects=? WHERE id=?").run(JSON.stringify([PROJECT, "other"]), session.id);
    await assert.rejects(s.sessions.fork(session.id, {}), /does not support additional project/);
    assert.equal(limited.starts.length, 1);
  } finally { await s.sessions.close(); }
});

test("opening an imported session hydrates native stats without starting the runtime", async () => {
  const s = setup();
  s.services.ingest = createIngestService(s.deps, s.services);
  const codex = fakeHarness({ id: "codex" });
  const facts: HarnessMeasurement[] = [{ id: "usage", at: "2026-11-10T12:00:00Z", kind: "usage", data: { model: "test-codex", input: 100, output: 25, cacheRead: 50, cacheWrite: 0, costUsd: null, cumulative: false, contextTokens: 175 } }];
  let reads = 0;
  codex.measurements = async () => { reads++; return facts; };
  codex.seed({ sessionId: "external-codex", cwd: s.projectPath });
  s.deps.harnesses.codex = codex;
  try {
    await s.sessions.discover(PROJECT);
    assert.equal((await s.sessions.detail("external-codex"))!.metrics.tokens.output, 25);
    assert.equal((await s.sessions.detail("external-codex"))!.metrics.tokens.output, 25);
    assert.equal(reads, 2);
    assert.equal(codex.starts.length, 0);
    codex.measurements = async () => { throw new Error("unreadable"); };
    assert.equal((await s.sessions.detail("external-codex"))!.metrics.tokens.output, 25);
    codex.measurements = async () => null;
    assert.equal((await s.sessions.detail("external-codex"))!.metrics.tokens.output, 25);
  } finally { await s.sessions.close(); }
});

test("two runtimes route start, send, resume and fork independently; explicit settings win runtime defaults", async () => {
  const s = setup();
  const codex = fakeHarness();
  Object.assign(codex, { id: "codex", capabilities: { permissionModes: ["default", "plan"], permissionScopes: ["once", "session"] } });
  s.deps.harnesses.codex = codex;
  s.services.settings = createSettingsService(s.deps, s.services);
  try {
    s.services.settings.update({ defaultModel: "opus", defaultHarness: "codex", harnessDefaults: { codex: { model: "codex-default", permissionMode: "default" } } });
    const first = await s.sessions.start({ project: PROJECT, prompt: { text: "hello" } });
    assert.equal(first.harness, "codex"); assert.equal(codex.starts[0]!.model, "codex-default"); assert.equal(s.harness.starts.length, 0);
    await s.sessions.end(first.id);
    await s.sessions.send(first.id, { text: "continue" });
    assert.equal(codex.starts.at(-1)!.resume, first.id);
    const fork = await s.sessions.fork(first.id, { prompt: { text: "branch off" } });
    assert.equal(fork.harness, "codex"); assert.equal(codex.starts.at(-1)!.fork, true);
    const claude = await s.sessions.start({ project: PROJECT, harness: "claude", prompt: { text: "other runtime" } });
    assert.equal(claude.harness, "claude"); assert.equal(s.harness.starts[0]!.model, "opus");
    await s.sessions.start({ project: PROJECT, prompt: { text: "Review" }, model: "codex-review", permissionMode: "plan" });
    assert.equal(codex.starts.at(-1)!.model, "codex-review"); assert.equal(codex.starts.at(-1)!.permissionMode, "plan");
    await assert.rejects(s.sessions.start({ project: PROJECT, harness: "codex", prompt: { text: "bad" }, permissionMode: "auto" }), /does not support permission mode/);
    const defaults = s.services.settings.get(); assert.equal(defaults.defaultHarness, "codex"); assert.equal(defaults.harnessDefaults?.codex?.model, "codex-default");
  } finally { await s.sessions.close(); }
});
