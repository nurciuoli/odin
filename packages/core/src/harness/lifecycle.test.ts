// Driver-neutral lifecycle checks. Native processes/SDK calls are replaced with local scripted transports.
import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../db/db.ts";
import type { Harness, SessionHandle } from "./types.ts";
import type { HarnessEvent } from "@odin/shared/harness";
import { EventQueue } from "./queue.ts";
import { createClaudeHarness, type ClaudeSdk } from "./claude/driver.ts";
import { createCodexHarness } from "./codex/driver.ts";
import { createGrokHarness } from "./grok/driver.ts";

function fixture(kind: "claude" | "codex" | "grok") {
  const db = openDb(":memory:");
  const output = new EventQueue<unknown>();
  const rpc = {
    onMessage: (_event: Record<string, any>) => {}, onExit: (_error: Error | null) => {},
    request: async (method: string) => {
      if (method === "initialize") return { authMethods: [{ id: "cached_token" }] };
      if (method === "thread/start") return { thread: { id: "native" }, model: "fixture" };
      if (method === "session/new") return { sessionId: "native" };
      return {};
    },
    respond() {}, reject() {}, notify() {}, close() {},
  };
  const query: ClaudeSdk["query"] = () => {
    const iterator = (async function* () {
      for await (const message of output) { if (message instanceof Error) throw message; yield message; }
    })();
    return Object.assign(iterator, {
      initializationResult: async () => ({ commands: [], agents: [], models: [] }),
      supportedModels: async () => [], close: () => output.end(), interrupt: async () => {},
      setModel: async () => {}, setPermissionMode: async () => {},
    }) as unknown as ReturnType<ClaudeSdk["query"]>;
  };
  const harness: Harness = kind === "claude" ? createClaudeHarness({ sdk: { query }, log: () => {} })
    : kind === "codex" ? createCodexHarness({ db, connect: () => rpc })
      : createGrokHarness({ db, connect: () => rpc });
  return { harness, dispose: () => db.close(), fail: () => {
    if (kind === "claude") output.push(new Error("fixture transport failed"));
    else rpc.onExit(new Error("fixture transport failed"));
  } };
}

async function collectUntil(handle: SessionHandle, done: (event: HarnessEvent) => boolean) {
  const events: HarnessEvent[] = [];
  for await (const event of handle.events) { events.push(event); if (done(event)) break; }
  return events;
}

for (const kind of ["claude", "codex", "grok"] as const) {
  test(kind + " lifecycle: idle attach closes with one terminal exit", async () => {
    const f = fixture(kind), handle = f.harness.start({ cwd: "C:/fixture", sessionId: "local" });
    try {
      const events = await collectUntil(handle, event => event.type === "state" && event.state === "idle");
      assert.equal(events[0]?.type, "init");
      await handle.close(); await handle.close();
      events.push(...await collectUntil(handle, () => false));
      assert.deepEqual(events.filter(event => event.type === "exit"), [{ type: "exit", outcome: "closed", error: null }]);
      assert.equal(events.at(-1)?.type, "exit");
    } finally { await handle.close(); f.dispose(); }
  });
  test(kind + " lifecycle: close during initialization cannot publish a late init", async () => {
    const f = fixture(kind), handle = f.harness.start({ cwd: "C:/fixture", sessionId: "local" });
    try {
      await handle.close();
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(await collectUntil(handle, () => false), [{ type: "exit", outcome: "closed", error: null }]);
    } finally { await handle.close(); f.dispose(); }
  });
  test(kind + " lifecycle: failed native stream exits once and remains terminal", async () => {
    const f = fixture(kind), handle = f.harness.start({ cwd: "C:/fixture", sessionId: "local" });
    try {
      await collectUntil(handle, event => event.type === "state" && event.state === "idle");
      f.fail();
      const events = await collectUntil(handle, () => false);
      assert.deepEqual(events, [{ type: "exit", outcome: "failed", error: "fixture transport failed" }]);
      await handle.close();
      assert.deepEqual(await collectUntil(handle, () => false), []);
    } finally { await handle.close(); f.dispose(); }
  });
}
