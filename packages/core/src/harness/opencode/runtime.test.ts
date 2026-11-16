import { test } from "node:test";
import assert from "node:assert/strict";
import type { OpenCode } from "@opencode/sdk";
import { createOpenCodeRuntime, nativeDatabasePath } from "./runtime.ts";
import { join } from "node:path";
import type { Plugin } from "@opencode/plugin";
import type { Info } from "@opencode/plugin/promise/tool";
import { setup, PROJECT } from "../../sessions/test-setup.ts";
import { adaptOpenCodeLibrary } from "./library.ts";

test("canonical OpenCode projections preserve project edits and native settings overrides", async () => {
  const s = setup();
  try {
    s.services.library.save("agent", "reader", { "reader.md": "---\nname: reader\ndescription: Reads\ntools: Read, Grep\n---\nRead carefully." });
    await s.services.library.install(PROJECT, { kind: "agent", id: "reader", action: "install" });
    const native = { permissionRules: [{ action: "shell", resource: "git *", effect: "ask" }], instructions: "Native policy" };
    s.services.library.save("settings", "native", { "native.json": JSON.stringify({ name: "Native", opencode: native }) });
    await s.services.library.install(PROJECT, { kind: "settings", id: "native", action: "install" });
    const files = s.services.library.projectFiles(PROJECT, "settings", "native")!;
    assert.deepEqual(JSON.parse(files["native.json"]!).opencode, native);
    const result = adaptOpenCodeLibrary(s.services, s.deps.config.home, PROJECT, { cwd: s.projectPath, instructions: "Host" });
    assert.equal(result.instructions, "Host\n\nNative policy");
    assert.deepEqual(result.permissionRules, native.permissionRules);
    assert.equal(result.agents[0]?.prompt, "Read carefully.");
    assert.deepEqual(result.agents[0]?.permissionRules, [{ action: "*", resource: "*", effect: "deny" }, { action: "read", resource: "*", effect: "allow" }, { action: "grep", resource: "*", effect: "allow" }]);
  } finally { await s.sessions.close(); }
});

test("embedded runtime uses persistent storage and isolates instance keys including descendants", async () => {
  const s = setup();
  let config!: OpenCode.CreateOptions;
  let closed = 0;
  const databasePath = join(s.deps.config.home, "native-runtime", "opencode", "state.db");
  const runtime = await createOpenCodeRuntime({ home: s.deps.config.home, databasePath, create: async options => {
    config = options;
    return { close: async () => { closed++; } } as unknown as OpenCode.Interface;
  } });
  try {
    assert.match(config.database!.path!, /native-runtime.*opencode.*state.db$/);
    await runtime.prepare("parent", { cwd: s.projectPath });
    const instances = config.instances!;
    // Public SDK InstanceOptions are reconstructed here to exercise the synchronous ownership selector.
    const key = instances.key as (session: { id: string; parentID?: string }) => string;
    assert.equal(key({ id: "parent" }), "odin:parent:1");
    assert.equal(key({ id: "child", parentID: "parent" }), "odin:parent:1");
    assert.equal(key({ id: "grandchild", parentID: "child" }), "odin:parent:1");
    assert.equal(key({ id: "unrelated" }), "native:unrelated");
    assert.deepEqual(await instances.configure("native:unrelated"), { plugins: [] });
    await runtime.prepare("parent", { cwd: s.projectPath });
    assert.equal(key({ id: "parent" }), "odin:parent:2");
  } finally { await runtime.close(); await s.sessions.close(); }
  assert.equal(closed, 1);
});

test("native database resolution uses CLI authority or documented environment paths without reading credentials", async () => {
  const home = join(process.cwd(), "test-home");
  const authoritative = join(home, "custom", "native.db");
  assert.equal(await nativeDatabasePath({ lookup: async () => authoritative + "\n", home, env: {} }), authoritative);
  assert.equal(await nativeDatabasePath({ lookup: async () => { throw new Error("no CLI"); }, home, env: {} }), join(home, ".local", "share", "opencode", "opencode.db"));
  assert.equal(await nativeDatabasePath({ lookup: async () => "", home, env: { XDG_DATA_HOME: home, OPENCODE_DB: "channel.db" } }), join(home, "opencode", "channel.db"));
});

test("host tool handlers follow session identity and remain fresh on resume", async () => {
  const s = setup();
  let config!: OpenCode.CreateOptions;
  let calls = 0;
  const runtime = await createOpenCodeRuntime({ home: s.deps.config.home, databasePath: join(s.deps.config.home, "test.db"), create: async options => { config = options; return { close: async () => {} } as unknown as OpenCode.Interface; } });
  try {
    const hostTool = { name: "post_artifact", description: "Post", params: {}, handler: async () => ({ text: String(++calls) }) };
    await runtime.prepare("parent", { cwd: s.projectPath, hostTools: [hostTool] });
    const instances = config.instances!;
    const key = instances.key as (session: { id: string; parentID?: string }) => string;
    const parentKey = key({ id: "parent" });
    key({ id: "child", parentID: "parent" });
    const plugins = (await instances.configure(parentKey)).plugins as Plugin.Plugin[];
    type Context = Parameters<Plugin.Plugin["setup"]>[0];
    let transform!: Parameters<Context["tool"]["transform"]>[0];
    const registration = { dispose: async () => {} };
    const context = {
      session: { hook: async () => registration },
      agent: { transform: async () => registration },
      skill: { transform: async () => registration },
      mcp: { transform: async () => registration },
      tool: { transform: async (callback: typeof transform) => { transform = callback; return registration; } },
    } as unknown as Context;
    await plugins[0]!.setup(context);
    let tool!: Info;
    transform({ add: value => { tool = value; } } as Parameters<typeof transform>[0]);
    assert.deepEqual(await tool.execute({}, { sessionID: "parent" } as never), { content: "1" });
    assert.deepEqual(await tool.execute({}, { sessionID: "child" } as never), { content: "2" });
    await assert.rejects(tool.execute({}, { sessionID: "other" } as never), /session mismatch/);
    await runtime.prepare("parent", { cwd: s.projectPath, hostTools: [{ ...hostTool, handler: async () => ({ text: "new version" }) }] });
    assert.deepEqual(await tool.execute({}, { sessionID: "parent" } as never), { content: "new version" });
    await runtime.prepare("parent", { cwd: s.projectPath, hostTools: [{ ...hostTool, handler: async () => ({ text: "Plot", content: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }] }) }] });
    assert.deepEqual(await tool.execute({}, { sessionID: "parent" } as never), { content: [
      { type: "text", text: "Plot" },
      { type: "file", uri: "data:image/png;base64,aW1hZ2U=", mime: "image/png" },
    ] });
  } finally { await runtime.close(); await s.sessions.close(); }
});
