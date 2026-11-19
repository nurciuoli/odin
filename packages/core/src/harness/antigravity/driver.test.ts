import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../../db/db.ts";
import type { HarnessEvent } from "@odin/shared/harness";
import { createAntigravityHarness } from "./driver.ts";
import type { Rpc, Wire } from "./transport.ts";

class FakeRpc implements Rpc {
  onMessage: (message: Wire) => void = () => {};
  onExit: (error: Error | null) => void = () => {};
  calls: { method: string; params: Wire }[] = [];
  replies: Wire[] = [];
  notes: Wire[] = [];
  closed = false;
  responses: Record<string, Wire | ((params: Wire) => Wire)> = {};

  async request(method: string, params: Wire = {}): Promise<Wire> {
    this.calls.push({ method, params });
    const preset = this.responses[method];
    if (typeof preset === "function") return preset(params);
    if (preset) return preset;
    if (method === "initialize") {
      return {
        protocolVersion: 1,
        models: [
          {
            id: "gemini-3.8-flash",
            name: "Gemini 3.8 Flash",
            description: "Fast frontier",
            contextWindow: 1048576,
            _meta: { reasoningEffort: "medium" },
          },
        ],
      };
    }
    if (method === "session/new") return { sessionId: "native-agy-1" };
    if (method === "session/fork") return { sessionId: "native-agy-fork" };
    if (method === "session/prompt") {
      return {
        stopReason: "end_turn",
        _meta: {
          modelId: "gemini-3.8-flash",
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            reasoningTokens: 2,
            cachedReadTokens: 0,
            cacheCreationTokens: 0,
            costUsd: 0.001,
          },
        },
      };
    }
    return {};
  }
  respond(id: string | number, result: Wire) {
    this.replies.push({ id, result });
  }
  notify(method: string, params: Wire = {}) {
    this.notes.push({ method, params });
  }
  reject(id: string | number, message: string) {
    this.replies.push({ id, error: message });
  }
  close() {
    this.closed = true;
  }
}

const PROJECT_DIR = join(tmpdir(), "odin-agy-project");

async function take(events: AsyncIterable<HarnessEvent>, stop: (event: HarnessEvent) => boolean) {
  const out: HarnessEvent[] = [];
  for await (const event of events) {
    out.push(event);
    if (stop(event)) break;
  }
  return out;
}

function setup(overrides: Partial<import("./driver.ts").AntigravityOptions> = {}) {
  const db = openDb(":memory:");
  const connections: FakeRpc[] = [];
  const harness = createAntigravityHarness({
    db,
    historyRoot: join(tmpdir(), "odin-agy-missing"),
    connect: () => {
      const rpc = new FakeRpc();
      connections.push(rpc);
      return rpc;
    },
    binary: () => "agy.exe",
    version: async () => {},
    ...overrides,
  });
  return { db, connections, harness };
}

test("a new Antigravity session links native id and streams a turn", async () => {
  const { db, connections, harness } = setup();
  const handle = harness.start({
    cwd: PROJECT_DIR,
    sessionId: "odin-agy-1",
    prompt: { text: "Hello Antigravity" },
    permissionMode: "plan",
    model: "gemini-3.8-flash",
    effort: "high",
  });

  const rpc = connections[0]!;
  const original = rpc.request.bind(rpc);
  rpc.request = async (method, params = {}) => {
    if (method === "session/prompt") {
      rpc.calls.push({ method, params });
      rpc.onMessage({
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "Planning next steps..." },
          },
        },
      });
      rpc.onMessage({
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Here is the result." },
          },
        },
      });
      rpc.onMessage({
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call-read-1",
            name: "read_file",
            args: { Path: "src/index.ts" },
          },
        },
      });
      rpc.onMessage({
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "call-read-1",
            status: "completed",
            content: [{ type: "text", text: "file content" }],
          },
        },
      });
      return {
        stopReason: "end_turn",
        _meta: {
          modelId: "gemini-3.8-flash",
          usage: {
            inputTokens: 20,
            outputTokens: 10,
            reasoningTokens: 5,
            cachedReadTokens: 2,
            cacheCreationTokens: 0,
            costUsd: 0.002,
          },
        },
      };
    }
    return original(method, params);
  };

  const events = await take(handle.events, (event) => event.type === "turn.end");

  assert.equal(events[0]?.type, "init");
  if (events[0]?.type === "init") {
    assert.equal(events[0].sessionId, "odin-agy-1");
    assert.equal(events[0].permissionMode, "plan");
    assert.equal(events[0].model, "gemini-3.8-flash");
  }

  assert.ok(events.some((e) => e.type === "delta" && e.kind === "thinking" && e.text.includes("Planning")));
  assert.ok(events.some((e) => e.type === "entry" && e.entry.kind === "assistant" && e.entry.text.includes("result")));
  assert.ok(events.some((e) => e.type === "tool.result" && e.toolUseId === "call-read-1" && e.result.ok));

  const usage = events.find((e) => e.type === "usage");
  assert.ok(usage && usage.type === "usage");
  assert.equal(usage.usage.input, 20);
  assert.equal(usage.usage.output, 15); // output + reasoning
  assert.equal(usage.costUsd, 0.002);

  const end = events.at(-1);
  assert.ok(end && end.type === "turn.end" && end.ok);

  const link = db.prepare("SELECT native_id FROM harness_session_links WHERE harness = 'antigravity' AND session_id = 'odin-agy-1'").get() as { native_id: string };
  assert.equal(link.native_id, "native-agy-1");

  await handle.close();
});

test("Antigravity permission prompt handling", async () => {
  const { connections, harness } = setup();
  const handle = harness.start({
    cwd: PROJECT_DIR,
    sessionId: "odin-agy-perm",
    model: "gemini-3.8-flash",
  });

  const rpc = connections[0]!;
  // Trigger permission request from ACP
  rpc.onMessage({
    method: "session/request_permission",
    id: 42,
    params: {
      toolCall: {
        name: "run_command",
        title: "Bash",
        rawInput: { command: "rm -rf build" },
      },
      options: [
        { optionId: "opt-allow-once", kind: "allow_once" },
        { optionId: "opt-allow-always", kind: "allow_always" },
        { optionId: "opt-reject", kind: "reject_once" },
      ],
    },
  });

  const events = await take(handle.events, (e) => e.type === "state" && e.state === "waiting");
  const reqEvent = events.find((e) => e.type === "permission.request");
  assert.ok(reqEvent && reqEvent.type === "permission.request");
  assert.equal(reqEvent.request.id, "42");
  assert.equal(reqEvent.request.toolName, "Bash");

  handle.answer("42", { behavior: "allow", scope: "once" });
  assert.equal(rpc.replies.length, 1);
  assert.deepEqual(rpc.replies[0], { id: 42, result: { outcome: { optionId: "opt-allow-once" } } });

  await handle.close();
});

test("Antigravity check and models", async () => {
  const { harness } = setup();
  const check = await harness.check();
  assert.equal(check.available, true);
  assert.ok(check.note?.includes("agy.exe"));

  const models = await harness.models();
  assert.ok(models.length >= 1);
  assert.equal(models[0]!.value, "gemini-3.8-flash");
});
