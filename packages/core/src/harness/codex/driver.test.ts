import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../db/db.ts";
import { createCodexHarness } from "./driver.ts";
import { itemEntry, policy } from "./map.ts";
import { wslPath, type Rpc, type Wire } from "./transport.ts";
import type { HarnessEvent } from "@odin/shared/harness";
import { tempDir, removeTempDir } from "../../test-helpers.ts";

class FakeRpc implements Rpc {
  onMessage: (message: Wire) => void = () => {};
  onExit: (error: Error | null) => void = () => {};
  calls: { method: string; params: Wire }[] = [];
  replies: Wire[] = [];
  closed = false;
  responses: Record<string, Wire> = {};
  async request(method: string, params: Wire = {}): Promise<Wire> {
    this.calls.push({ method, params });
    return (
      this.responses[method] ??
      {
        "thread/start": {
          thread: { id: "native-parent" },
          model: "test-codex",
        },
        "thread/resume": {
          thread: { id: params.threadId },
          model: "test-codex",
        },
        "thread/fork": { thread: { id: "native-fork" }, model: "test-codex" },
        "turn/start": { turn: { id: "turn-1" } },
        "model/list": {
          data: [
            {
              model: "test-codex",
              displayName: "Test Codex",
              description: "fixture",
            },
          ],
          nextCursor: null,
        },
      }[method] ??
      {}
    );
  }
  notify(method: string) {
    this.calls.push({ method, params: {} });
  }
  respond(id: string | number, result: Wire) {
    this.replies.push({ id, result });
  }
  reject(id: string | number, message: string) {
    this.replies.push({ id, error: message });
  }
  close() {
    this.closed = true;
  }
  event(method: string, params: Wire) {
    this.onMessage({
      method,
      params: { threadId: "native-parent", ...params },
    });
  }
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail("fixture did not settle");
}
function setup() {
  const db = openDb(":memory:");
  const connections: FakeRpc[] = [];
  const connect = () => {
    const rpc = new FakeRpc();
    connections.push(rpc);
    return rpc;
  };
  const harness = createCodexHarness({ db, connect, historyRoot: join(tmpdir(), "odin-fixture-missing-codex-history") });
  return { db, connections, harness, connect };
}

test("unmapped Codex records can be opened, renamed and removed without a subprocess", async () => {
  const s = setup();
  try {
    assert.deepEqual(await s.harness.messages("not-created"), []);
    assert.equal(await s.harness.info("not-created"), null);
    await s.harness.rename("not-created", "New title");
    await s.harness.delete("not-created");
    assert.equal(s.connections.length, 0);
    const handle = s.harness.start({ cwd: "/fixture", resume: "not-created", prompt: { text: "continue" } });
    const events: HarnessEvent[] = [];
    for await (const event of handle.events) events.push(event);
    assert.equal(events.at(-1)?.type, "exit");
    assert.match((events.at(-1) as { error: string }).error, /Start a new session/);
    assert.equal(s.connections[0]!.calls.some(c => c.method === "thread/start"), false);
  } finally { s.db.close(); }
});

test("Codex child history is read-only, parent-scoped and paginated", async () => {
  const s = setup();
  const task = { kind: "agent", childSessionId: "child" } as any;
  s.db.prepare("INSERT INTO harness_session_links (harness, session_id, native_id) VALUES ('codex', 'parent', 'parent'), ('codex', 'other', 'other')").run();
  const rpc = new FakeRpc();
  const other = new FakeRpc();
  const connections = [rpc, other];
  const harness = createCodexHarness({ db: s.db, historyRoot: join(tmpdir(), "odin-fixture-missing-codex-history"), connect: () => connections.shift()! });
  rpc.responses["thread/read"] = { thread: { id: "child", parentThreadId: "parent" } };
  rpc.responses["thread/items/list"] = { data: [{ item: { type: "agentMessage", id: "reply", text: "Child reply" } }], nextCursor: null };
  const request = rpc.request.bind(rpc);
  rpc.request = async (method, params = {}) => {
    if (method === "thread/items/list" && !params.cursor) {
      rpc.calls.push({ method, params });
      return { data: [{ item: { type: "userMessage", id: "prompt", content: [{ type: "text", text: "Review" }] } }], nextCursor: "page2" };
    }
    return request(method, params);
  };
  const result = await harness.taskMessages!("parent", task);
  assert.equal(result.status, "available");
  if (result.status === "available") assert.deepEqual(result.transcript.map(e => e.kind), ["user", "assistant"]);
  assert.equal(rpc.calls.filter(c => c.method === "thread/items/list").length, 2);
  assert.ok(rpc.calls.every(c => !["turn/start", "thread/resume", "thread/start"].includes(c.method)));
  other.responses["thread/read"] = { thread: { parentThreadId: "parent" } };
  assert.equal((await harness.taskMessages!("other", task)).status, "unavailable");
  assert.ok(!other.calls.some(c => c.method === "thread/items/list"));
  s.db.close();
});

test("Codex command output deltas stay bounded and final output replaces the stream", async () => {
  const s = setup();
  const handle = s.harness.start({ sessionId: "commands", cwd: "/repo", prompt: { text: "tests" } });
  const events: HarnessEvent[] = [];
  const consume = (async () => { for await (const event of handle.events) events.push(event); })();
  try {
    const rpc = s.connections[0];
    await until(() => rpc.calls.some(c => c.method === "turn/start"));
    const command = { type: "commandExecution", id: "command", command: "tests", status: "inProgress", aggregatedOutput: "" };
    rpc.event("item/started", { item: command });
    rpc.event("item/commandExecution/outputDelta", { itemId: "command", delta: "x".repeat(21000) });
    rpc.event("item/completed", { item: { ...command, status: "completed", exitCode: 0, aggregatedOutput: "Final" } });
    await until(() => events.filter(e => e.type === "task").length === 3);
    const tasks = events.filter(e => e.type === "task").map(e => e.task);
    assert.equal(tasks[1].output?.text.length, 20000);
    assert.equal(tasks[1].output?.truncated, true);
    assert.equal(tasks[2].output?.text, "Final");
    assert.equal(tasks[2].state, "completed");
  } finally {
    await handle.close();
    await consume;
    s.db.close();
  }
});

test("native child rollout reads validate parent on every refresh without starting an app-server", async () => {
  const root = tempDir("odin-native-child-");
  const db = openDb(":memory:");
  const child = "11111111-1111-4111-8111-111111111111";
  db.prepare("INSERT INTO harness_session_links (harness, session_id, native_id) VALUES ('codex', 'parent', 'native-parent')").run();
  const file = join(root, `rollout-fixture-${child}.jsonl`);
  const save = (parent: string) => writeFileSync(file, [
    { type: "session_meta", payload: { id: child, parent_thread_id: parent } },
    { type: "event_msg", payload: { type: "item_completed", item: { type: "AgentMessage", id: "reply", content: [{ type: "text", text: "Child reply" }] } } },
  ].map(row => JSON.stringify(row)).join("\n"));
  const harness = createCodexHarness({ db, historyRoot: root, connect: () => { throw new Error("Native history should avoid process startup"); } });
  const task = { kind: "agent", childSessionId: child } as any;
  try {
    save("native-parent");
    for (let i = 0; i < 2; i++) assert.equal((await harness.taskMessages!("parent", task)).status, "available");
    save("unrelated-parent");
    assert.equal((await harness.taskMessages!("parent", task)).status, "unavailable");
  } finally { db.close(); removeTempDir(root); }
});

test("Codex usage exhaustion preserves the handle and pauses queued work until a user retries", async () => {
  const s = setup();
  const handle = s.harness.start({ sessionId: "limited", cwd: "/repo", prompt: { text: "hello" } });
  const events: HarnessEvent[] = [];
  const consume = (async () => { for await (const event of handle.events) events.push(event); })();
  try {
    const rpc = s.connections[0]!;
    await until(() => rpc.calls.some(c => c.method === "turn/start"));
    handle.send({ text: "queued" });
    rpc.event("turn/completed", { turn: { status: "failed", error: { codexErrorInfo: "usageLimitExceeded", message: "SECRET" } } });
    await until(() => events.some(e => e.type === "turn.end"));
    assert.equal(rpc.calls.filter(c => c.method === "turn/start").length, 1);
    assert.equal(rpc.closed, false);
    assert.ok(events.some(e => e.type === "turn.end" && !e.ok && e.error?.includes("usage limit reached")));
    assert.ok(!JSON.stringify(events).includes("SECRET"));
    handle.send({ text: "retry" });
    await until(() => rpc.calls.filter(c => c.method === "turn/start").length === 2);
  } finally { await handle.close(); await consume; s.db.close(); }
});

test("Codex recovers stored usage, turn timing and tool counts without resuming a thread", async () => {
  const root = tempDir("odin-native-metrics-");
  const s = setup();
  try {
    const path = join(root, "rollout.jsonl");
    const timestamp = "2026-11-10T12:00:00Z";
    writeFileSync(path, [
      { timestamp, type: "session_meta", payload: { id: "native" } },
      { timestamp, type: "turn_context", payload: { model: "test-codex" } },
      { timestamp, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 10 }, last_token_usage: { total_tokens: 110 }, model_context_window: 475000 } } },
    ].map(r => JSON.stringify(r)).join("\n"));
    s.db.prepare("INSERT INTO harness_session_links (harness, session_id, native_id) VALUES ('codex', 'local', 'native')").run();
    const rpc = new FakeRpc();
    rpc.responses["thread/read"] = { thread: { path, createdAt: Date.parse(timestamp) / 1000 } };
    rpc.responses["thread/turns/list"] = { data: [{ id: "turn", status: "completed", startedAt: Date.parse(timestamp) / 1000, completedAt: Date.parse(timestamp) / 1000 + 5, durationMs: 5000, items: [{ id: "tool", type: "commandExecution", command: "pwd", status: "completed", aggregatedOutput: "", exitCode: 0 }] }], nextCursor: null };
    const harness = createCodexHarness({ db: s.db, connect: () => rpc });
    const facts = await harness.measurements!("local");
    const usage = facts!.find(f => f.kind === "usage")!;
    assert.equal(usage.kind === "usage" && usage.data.input, 40);
    assert.equal(facts!.filter(f => f.kind === "tool").length, 1);
    assert.equal(facts!.find(f => f.kind === "turn")!.data.durationMs, 5000);
    assert.ok(!rpc.calls.some(c => c.method === "thread/resume" || c.method === "turn/start"));
    assert.equal(rpc.closed, true);
  } finally { s.db.close(); removeTempDir(root); }
});

test("Codex handshake, native ID binding and restart resume; history uses identical item IDs", async () => {
  const s = setup();
  const handle = s.harness.start({
    sessionId: "local-parent",
    cwd: "/repo",
    prompt: { text: "hello" },
  });
  const events: HarnessEvent[] = [];
  const consume = (async () => {
    for await (const event of handle.events) events.push(event);
  })();
  try {
    const rpc = s.connections[0]!;
    await until(() => rpc.calls.some((c) => c.method === "turn/start"));
    assert.deepEqual(
      rpc.calls.slice(0, 3).map((c) => c.method),
      ["initialize", "initialized", "thread/start"],
    );
    assert.equal(events[0]?.type, "init");
    const item = { type: "agentMessage", id: "answer-1", text: "Hello" };
    rpc.event("item/completed", { item });
    rpc.event("turn/completed", { turn: { status: "completed" } });
    await handle.close();
    await consume;
    assert.equal(events.filter((e) => e.type === "exit").length, 1);
    const restarted = createCodexHarness({ db: s.db, connect: s.connect });
    const resumed = restarted.start({ resume: "local-parent", cwd: "/repo" });
    const next = s.connections.at(-1)!;
    await until(() => next.calls.some((c) => c.method === "thread/resume"));
    assert.equal(
      next.calls.find((c) => c.method === "thread/resume")!.params.threadId,
      "native-parent",
    );
    await resumed.close();
    const historyConnect = () => {
      const h = new FakeRpc();
      h.responses["thread/items/list"] = { data: [{ item }], nextCursor: null };
      return h;
    };
    const history = await createCodexHarness({
      db: s.db,
      connect: historyConnect,
    }).messages("local-parent");
    assert.deepEqual(history[0], itemEntry(item, null));
    assert.ok(
      events.some((e) => e.type === "entry" && e.entry.id === history[0]!.id),
    );
  } finally {
    await handle.close();
    s.db.close();
  }
});

test("Codex queues messages until turn end; updates model/mode for next turn and interrupts", async () => {
  const s = setup();
  const h = s.harness.start({
    sessionId: "local",
    cwd: "/repo",
    prompt: { text: "one" },
  });
  h.send({ text: "two" });
  try {
    const rpc = s.connections[0]!;
    await until(() => rpc.calls.some((c) => c.method === "turn/start"));
    assert.equal(
      rpc.calls.find((c) => c.method === "turn/start")!.params.input[0].text,
      "one",
    );
    assert.equal(rpc.calls.filter((c) => c.method === "turn/start").length, 1);
    await h.setModel("another-model");
    await h.setPermissionMode("dontAsk");
    rpc.event("turn/completed", { turn: { status: "completed" } });
    await until(
      () => rpc.calls.filter((c) => c.method === "turn/start").length === 2,
    );
    const turn = rpc.calls.filter((c) => c.method === "turn/start")[1]!.params;
    assert.equal(turn.model, "another-model");
    assert.equal(turn.approvalPolicy, "never");
    assert.equal(turn.sandboxPolicy.type, "workspaceWrite");
    await assert.rejects(h.setPermissionMode("auto"), /does not support/);
    await h.interrupt();
    assert.ok(rpc.calls.some((c) => c.method === "turn/interrupt"));
  } finally {
    await h.close();
    s.db.close();
  }
});

test("Codex interrupted turns report interruption and do not release queued work", async () => {
  const s = setup();
  const handle = s.harness.start({ sessionId: "paused", cwd: "/repo", prompt: { text: "one" } });
  const events: HarnessEvent[] = [];
  const consume = (async () => { for await (const event of handle.events) events.push(event); })();
  try {
    const rpc = s.connections[0]!;
    await until(() => rpc.calls.some(call => call.method === "turn/start"));
    handle.send({ text: "two" });
    // Interruption may also originate from another native client, without handle.interrupt().
    rpc.event("turn/completed", { turn: { status: "interrupted" } });
    await until(() => events.some(event => event.type === "state" && event.state === "idle"));
    assert.ok(events.some(event => event.type === "turn.end" && !event.ok && event.error === "interrupted"));
    assert.equal(rpc.calls.filter(call => call.method === "turn/start").length, 1);
  } finally { await handle.close(); await consume; s.db.close(); }
});

test("Codex accepts the next service-dispatched message at the idle boundary", async () => {
  const s = setup();
  const handle = s.harness.start({ sessionId: "boundary", cwd: "/repo", prompt: { text: "one" } });
  let dispatched = false;
  const consume = (async () => {
    for await (const event of handle.events) {
      if (event.type === "state" && event.state === "idle" && !dispatched) {
        dispatched = true;
        handle.send({ text: "two" });
      }
    }
  })();
  try {
    const rpc = s.connections[0]!;
    await until(() => rpc.calls.some(call => call.method === "turn/start"));
    rpc.event("turn/completed", { turn: { status: "completed" } });
    await until(() => rpc.calls.filter(call => call.method === "turn/start").length === 2);
    assert.equal(rpc.calls.filter(call => call.method === "turn/start")[1]!.params.input[0].text, "two");
  } finally { await handle.close(); await consume; s.db.close(); }
});

test("Codex approvals deny unsupported scope, route questions by native IDs, and cancel on close", async () => {
  const s = setup();
  const h = s.harness.start({
    sessionId: "local",
    cwd: "/repo",
    prompt: { text: "one" },
  });
  const events: HarnessEvent[] = [];
  const consume = (async () => {
    for await (const e of h.events) events.push(e);
  })();
  try {
    const rpc = s.connections[0]!;
    await until(() => rpc.calls.some((c) => c.method === "turn/start"));
    assert.equal(rpc.calls.find((c) => c.method === "thread/start")!.params.config.features.default_mode_request_user_input, true);
    rpc.onMessage({
      id: 91,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "native-parent", itemId: "cmd", command: "npm test" },
    });
    assert.throws(
      () => h.answer("91", { behavior: "allow", scope: "project" }),
      /this call or this session/,
    );
    h.answer("91", { behavior: "allow", scope: "session" });
    assert.deepEqual(rpc.replies[0], {
      id: 91,
      result: { decision: "acceptForSession" },
    });
    rpc.onMessage({
      id: "question",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "native-parent",
        questions: [{ id: "q1", question: "Choose?" }],
      },
    });
    h.answer("question", {
      behavior: "allow",
      scope: "once",
      updatedInput: { answers: { "Choose?": ["Yes"] } },
    });
    assert.deepEqual(rpc.replies[1]!.result.answers, {
      q1: { answers: ["Yes"] },
    });
    rpc.onMessage({
      id: 92,
      method: "item/fileChange/requestApproval",
      params: { threadId: "native-parent", itemId: "edit" },
    });
    await h.close();
    await consume;
    assert.ok(
      events.some(
        (e) =>
          e.type === "permission.resolved" &&
          e.requestId === "92" &&
          e.behavior === "cancelled",
      ),
    );
  } finally {
    await h.close();
    s.db.close();
  }
});

test("Codex host artifacts use native dynamic tools; fork records a distinct binding", async () => {
  const s = setup();
  let input: unknown;
  const h = s.harness.start({
    sessionId: "local",
    cwd: "/repo",
    hostTools: [
      {
        name: "post_artifact",
        description: "Post HTML",
        params: { html: { type: "string", description: "HTML" } },
        async handler(value) {
          input = value;
          return { text: "artifact 1", content: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }] };
        },
      },
    ],
  });
  try {
    const rpc = s.connections[0]!;
    await until(() => rpc.calls.some((c) => c.method === "thread/start"));
    await until(
      () =>
        rpc.calls.find((c) => c.method === "thread/start")?.params.dynamicTools
          ?.length === 1,
    );
    await new Promise((resolve) => setTimeout(resolve, 2));
    rpc.onMessage({
      id: 77,
      method: "item/tool/call",
      params: {
        threadId: "native-parent",
        tool: "post_artifact",
        arguments: { html: "<h1>Hello</h1>" },
      },
    });
    await until(() => rpc.replies.length === 1);
    assert.deepEqual(input, { html: "<h1>Hello</h1>" });
    assert.equal(rpc.replies[0]!.result.success, true);
    assert.deepEqual(rpc.replies[0]!.result.contentItems, [
      { type: "inputText", text: "artifact 1" },
      { type: "inputImage", imageUrl: "data:image/png;base64,aW1hZ2U=" },
    ]);
    const fork = await s.harness.fork("local");
    const row = s.db
      .prepare(
        "SELECT native_id FROM harness_session_links WHERE session_id = ?",
      )
      .get(fork) as Wire;
    assert.equal(row.native_id, "native-fork");
  } finally {
    await h.close();
    s.db.close();
  }
});

test("Codex usage subtracts restored history, cached input and repeated updates", async () => {
  const s = setup();
  const h = s.harness.start({
    sessionId: "local",
    cwd: "/repo",
    prompt: { text: "one" },
  });
  const events: HarnessEvent[] = [];
  const consume = (async () => {
    for await (const e of h.events) events.push(e);
  })();
  try {
    const rpc = s.connections[0]!;
    await until(() => rpc.calls.some((c) => c.method === "thread/start"));
    await new Promise((resolve) => setTimeout(resolve, 2));
    rpc.event("turn/started", { turn: { id: "turn-1" } });
    const first = {
      inputTokens: 1100,
      cachedInputTokens: 400,
      outputTokens: 200,
    };
    const last = {
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 20,
      totalTokens: 120,
    };
    rpc.event("thread/tokenUsage/updated", {
      turnId: "restored-old-turn",
      tokenUsage: { total: first, last },
    });
    await h.setModel("next-turn-model");
    rpc.event("thread/tokenUsage/updated", {
      turnId: "turn-1",
      tokenUsage: { total: first, last },
    });
    rpc.event("thread/tokenUsage/updated", {
      turnId: "turn-1",
      tokenUsage: { total: first, last },
    });
    await h.close();
    await consume;
    const usage = events.filter((e) => e.type === "usage");
    assert.equal(usage.length, 2);
    assert.equal(usage[0]!.model, "test-codex");
    assert.deepEqual(usage[0]!.usage, {
      input: 60,
      output: 20,
      cacheRead: 40,
      cacheWrite: 0,
    });
    assert.deepEqual(usage[1]!.usage, {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  } finally {
    await h.close();
    s.db.close();
  }
});

test("WSL path conversion preserves spaces and rejects relative paths; policies never silently broaden", () => {
  assert.equal(
    wslPath("C:\\Users\\alex\\My repo"),
    "/mnt/c/Users/alex/My repo",
  );
  assert.equal(
    wslPath("\\\\wsl.localhost\\Ubuntu\\home\\alex\\repo"),
    "/home/alex/repo",
  );
  assert.throws(() => wslPath("relative/path"), /absolute/);
  assert.deepEqual(policy("plan"), {
    approvalPolicy: "on-request",
    sandbox: "read-only",
  });
  assert.throws(() => policy("auto"), /does not support/);
});

test("Codex /compact and /review run app-server methods; native skills join the command list", async () => {
  const s = setup();
  const handle = s.harness.start({ sessionId: "cmds", cwd: "/repo" });
  const events: HarnessEvent[] = [];
  const consume = (async () => { for await (const event of handle.events) events.push(event); })();
  try {
    const rpc = s.connections[0]!;
    rpc.responses["skills/list"] = { data: [{ cwd: "/repo", skills: [{ name: "deploy", path: "/repo/.codex/skills/deploy/SKILL.md", shortDescription: "Ship it" }] }] };
    rpc.responses["review/start"] = { turn: { id: "review-turn" }, reviewThreadId: "native-parent" };
    await until(() => events.some((e) => e.type === "init"));
    const init = events.find((e) => e.type === "init") as Extract<HarnessEvent, { type: "init" }>;
    assert.deepEqual(init.slashCommands.map((c) => c.name), ["compact", "review"]);
    await until(() => events.some((e) => e.type === "commands"));
    const cmds = events.find((e) => e.type === "commands") as Extract<HarnessEvent, { type: "commands" }>;
    assert.deepEqual(cmds.slashCommands.map((c) => [c.name, c.source]), [["compact", "builtin"], ["review", "builtin"], ["deploy", "custom"]]);

    handle.send({ text: "/compact" });
    await until(() => rpc.calls.some((c) => c.method === "thread/compact/start"));
    assert.deepEqual(rpc.calls.find((c) => c.method === "thread/compact/start")!.params, { threadId: "native-parent" });
    rpc.event("turn/completed", { turn: { id: "t", status: "completed" } });

    handle.send({ text: "/review branch main" });
    await until(() => rpc.calls.some((c) => c.method === "review/start"));
    assert.deepEqual(rpc.calls.find((c) => c.method === "review/start")!.params, { threadId: "native-parent", target: { type: "baseBranch", branch: "main" }, delivery: "inline" });
    rpc.event("item/completed", { item: { type: "exitedReviewMode", id: "r", review: "Looks good" } });
    await until(() => events.some((e) => e.type === "entry" && e.entry.kind === "assistant" && e.entry.text === "Looks good"));
    rpc.event("turn/completed", { turn: { id: "review-turn", status: "completed" } });

    handle.send({ text: "/deploy now" });
    await until(() => rpc.calls.some((c) => c.method === "turn/start"));
    const input = rpc.calls.find((c) => c.method === "turn/start")!.params.input;
    assert.equal(input[0].text, "$deploy now");
    assert.deepEqual(input.at(-1), { type: "skill", name: "deploy", path: "/repo/.codex/skills/deploy/SKILL.md" });
    assert.ok(!rpc.calls.some((c) => c.method === "turn/start" && /compact|review/.test(c.params.input[0].text)));
  } finally {
    await handle.close();
    await consume;
    s.db.close();
  }
});

test("Codex effort reaches ordinary and plan turns and resets to default", async () => {
  const s = setup();
  const handle = s.harness.start({ cwd: "/fixture", model: "test-codex", effort: "high", permissionMode: "plan", prompt: { text: "start" } });
  try {
    const rpc = s.connections[0]!;
    await until(() => rpc.calls.some(c => c.method === "turn/start"));
    const first = rpc.calls.find(c => c.method === "turn/start")!.params;
    assert.equal(first.effort, "high");
    assert.equal(first.collaborationMode.settings.reasoning_effort, "high");
    rpc.event("turn/completed", { turn: { id: "turn-1", status: "completed" } });
    await handle.setEffort!(null);
    await handle.setPermissionMode("default");
    handle.send({ text: "again" });
    await until(() => rpc.calls.filter(c => c.method === "turn/start").length === 2);
    assert.equal(rpc.calls.filter(c => c.method === "turn/start")[1]!.params.effort, null);
  } finally { await handle.close(); s.db.close(); }
});
