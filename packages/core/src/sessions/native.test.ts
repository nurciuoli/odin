import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeHarness } from "../harness/fake.ts";
import type { HarnessCapabilities } from "@odin/shared/api";
import { runtimeOptions, nativeAction } from "./native.ts";
import { PROJECT, setup, waitFor } from "./test-setup.ts";
import { validateSettings } from "../library/parse.ts";

const capabilities: HarnessCapabilities = { permissionModes: ["default"], permissionScopes: ["once", "session"], native: { agents: true, variants: true, permissionRules: true, actions: ["compact", "revert", "unrevert", "commitRevert"] } };

test("native controls reject unsupported options and preserve native rule semantics", () => {
  const options = { agent: "build", variant: "high", permissionRules: [{ action: "bash", resource: "git *", effect: "ask" as const }] };
  assert.deepEqual(runtimeOptions(options, capabilities), options);
  assert.throws(() => runtimeOptions(options), /does not support/);
  assert.throws(() => runtimeOptions({ token: "secret" }, capabilities), /unknown native option/);
  assert.throws(() => runtimeOptions({ permissionRules: [{ action: "bash", resource: "*", effect: "yes" }] }, capabilities), /unknown permission effect/);
  assert.throws(() => nativeAction({ type: "share" }, capabilities), /does not support/);
  assert.throws(() => nativeAction({ type: "revert", messageId: "m", files: "yes" }, capabilities), /files must/);
});

test("native options survive end, resume and fork without altering MCP configuration", async () => {
  const harness = Object.assign(fakeHarness(), { capabilities });
  const s = setup({ harnesses: { claude: harness } });
  const options = { agent: "build", variant: "high" };
  try {
    const session = await s.sessions.start({ project: PROJECT, prompt: { text: "hello" }, runtimeOptions: options });
    assert.deepEqual(harness.starts[0]!.runtimeOptions, options);
    await waitFor(() => s.sessions.get(session.id)?.state === "idle");
    await s.sessions.end(session.id);
    await s.sessions.update(session.id, { runtimeOptions: { variant: null } });
    assert.deepEqual(s.sessions.get(session.id)!.runtimeOptions, { agent: "build", variant: null });
    await s.sessions.send(session.id, { text: "resume" });
    assert.deepEqual(harness.starts.at(-1)!.runtimeOptions, { agent: "build", variant: null });
    await waitFor(() => s.sessions.get(session.id)?.state === "idle");
    const child = await s.sessions.fork(session.id, {});
    assert.deepEqual(child.runtimeOptions, { agent: "build", variant: null });
  } finally { await s.sessions.close(); }
});

test("native operations exclude concurrent sends and refresh reverted live history", async () => {
  const harness = Object.assign(fakeHarness(), { capabilities });
  const start = harness.start.bind(harness);
  let release!: () => void;
  harness.start = options => Object.assign(start(options), { nativeAction: async () => { await new Promise<void>(resolve => { release = resolve; }); return { revert: { messageId: "m" } }; } });
  const s = setup({ harnesses: { claude: harness } });
  try {
    const session = await s.sessions.start({ project: PROJECT, prompt: { text: "hello" } });
    await waitFor(() => s.sessions.get(session.id)?.state === "idle");
    const operation = s.sessions.nativeAction(session.id, { type: "revert", messageId: "m" });
    await waitFor(() => !!release);
    await assert.rejects(s.sessions.send(session.id, { text: "racing message" }), /operation is in progress/);
    await assert.rejects(s.sessions.remove(session.id), /operation is in progress/);
    await assert.rejects(s.sessions.end(session.id), /operation is in progress/);
    await assert.rejects(s.sessions.fork(session.id, {}), /operation is in progress/);
    await assert.rejects(s.sessions.update(session.id, { title: "Busy title" }), /operation is in progress/);
    await assert.rejects(s.sessions.nativeAction(session.id, { type: "compact" }), /idle session/);
    release();
    assert.deepEqual(await operation, { revert: { messageId: "m" } });
  } finally { await s.sessions.close(); }
});

test("settings profiles validate explicit native OpenCode rules", () => {
  const errors: string[] = [];
  const profile = validateSettings({ opencode: { instructions: "Read carefully", permissionRules: [{ action: "edit", resource: "*", effect: "deny" }] } }, errors);
  assert.deepEqual(errors, []);
  assert.equal(profile.opencode?.permissionRules?.[0]?.effect, "deny");
  validateSettings({ opencode: { permissionRules: [{ action: "edit", resource: "*", effect: "all" }] } }, errors);
  assert.match(errors.join(" "), /invalid OpenCode permission rule/);
});
