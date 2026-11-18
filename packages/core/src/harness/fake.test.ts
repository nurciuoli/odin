import { test } from "node:test";
import assert from "node:assert/strict";
import { foldHarnessEvents } from "@odin/shared/transcript";
import { eventsUntil, fakeHarness } from "./fake.ts";

test("a turn: init, state, user + assistant entries, usage, turn.end, idle", async () => {
  const h = fakeHarness();
  const handle = h.start({ cwd: "/p", sessionId: "s1", prompt: { text: "hello" } });
  const events = await eventsUntil(handle, (e) => e.type === "state" && e.state === "idle");
  assert.deepEqual(events.map((e) => e.type), ["init", "state", "entry", "entry", "usage", "turn.end", "state"]);
  const t = foldHarnessEvents(events);
  assert.deepEqual(t.map((e) => e.kind), ["user", "assistant"]);
  assert.equal(t[1]!.kind === "assistant" && t[1]!.text, "ok: hello");
  await handle.close();
  assert.deepEqual((await h.list("/p")).map((s) => s.sessionId), ["s1"]);
  assert.equal((await h.messages("s1")).length, 2);
});

test("fake accepts service dispatch from the idle event while pump is finishing", { timeout: 2000 }, async () => {
  const harness = fakeHarness();
  const handle = harness.start({ cwd: "/p", prompt: { text: "one" } });
  let idleCount = 0;
  try {
    for await (const event of handle.events) {
      if (event.type === "state" && event.state === "idle") {
        idleCount++;
        if (idleCount === 2) break;
        handle.send({ text: "two" });
      }
    }
    assert.deepEqual((await harness.messages(handle.sessionId)).flatMap(entry => entry.kind === "user" ? [entry.text] : []), ["one", "two"]);
    assert.equal((await harness.messages(handle.sessionId)).filter(entry => entry.kind === "assistant").length, 2);
  } finally { await handle.close(); }
});

test("permission prompts block until answered; deny reports an error result", async () => {
  const h = fakeHarness({
    script: () => [{ tool: "Write", input: { file_path: "a" }, ask: true }, { tool: "Bash", input: { command: "rm" }, ask: true }, { text: "after" }],
  });
  const handle = h.start({ cwd: "/p", prompt: { text: "go" } });
  const first = await eventsUntil(handle, (e) => e.type === "permission.request");
  const req = first.at(-1)!;
  assert.ok(req.type === "permission.request");
  handle.answer(req.request.id, { behavior: "allow", scope: "once" });
  const second = await eventsUntil(handle, (e) => e.type === "permission.request");
  const req2 = second.at(-1)!;
  assert.ok(req2.type === "permission.request");
  handle.answer(req2.request.id, { behavior: "deny", message: "no" });
  const rest = await eventsUntil(handle, (e) => e.type === "turn.end");
  const t = foldHarnessEvents([...first, ...second, ...rest]);
  const tools = t.filter((e) => e.kind === "tool");
  assert.equal(tools[0]!.kind === "tool" && tools[0]!.result?.ok, true);
  assert.equal(tools[1]!.kind === "tool" && tools[1]!.result?.text, "no");
  assert.equal(h.answers.length, 2);
  await handle.close();
});

test("resume continues the stored transcript; fork copies it under a new id", async () => {
  const h = fakeHarness();
  const a = h.start({ cwd: "/p", sessionId: "a", prompt: { text: "one" } });
  await eventsUntil(a, (e) => e.type === "turn.end");
  await a.close();
  const b = h.start({ cwd: "/p", resume: "a", prompt: { text: "two" } });
  assert.equal(b.sessionId, "a");
  await eventsUntil(b, (e) => e.type === "turn.end");
  await b.close();
  assert.equal((await h.messages("a")).length, 4);
  const f = h.start({ cwd: "/p", resume: "a", fork: true, sessionId: "f" });
  assert.equal(f.sessionId, "f");
  await eventsUntil(f, (e) => e.type === "state");
  await f.close();
  assert.equal((await h.messages("f")).length, 4);
  const forked = await h.fork("a");
  assert.equal((await h.messages(forked)).length, 4);
});

test("host tools are called with the model's input", async () => {
  let got: unknown = null;
  const h = fakeHarness({ script: () => [{ hostTool: "post_artifact", input: { title: "T" } }] });
  const handle = h.start({
    cwd: "/p",
    prompt: { text: "x" },
    hostTools: [{ name: "post_artifact", description: "", params: {}, handler: async (input) => ((got = input), { text: "posted" }) }],
  });
  const events = await eventsUntil(handle, (e) => e.type === "turn.end");
  assert.deepEqual(got, { title: "T" });
  const tool = foldHarnessEvents(events).find((e) => e.kind === "tool");
  assert.ok(tool?.kind === "tool" && tool.name === "mcp__odin__post_artifact" && tool.result?.text === "posted");
  await handle.close();
});

test("fail ends the handle with exit failed; seeded sessions are listed", async () => {
  const h = fakeHarness({ script: () => [{ fail: "boom" }] });
  const handle = h.start({ cwd: "/p", prompt: { text: "x" } });
  const events = await eventsUntil(handle, (e) => e.type === "exit");
  assert.deepEqual(events.at(-1), { type: "exit", outcome: "failed", error: "boom" });
  h.seed({ sessionId: "ext", cwd: "/p/sub", title: "From a terminal" });
  assert.ok((await h.list("/p")).some((s) => s.sessionId === "ext"));
  assert.equal((await h.list("/other")).length, 0);
});

test("the demo script asks before running and posts artifacts through host tools", async () => {
  const { demoScript } = await import("./fake.ts");
  const posted: unknown[] = [];
  const h = fakeHarness({ script: demoScript });
  const handle = h.start({
    cwd: "/p",
    prompt: { text: "run the tests and post an artifact" },
    hostTools: [{ name: "post_artifact", description: "", params: {}, handler: async (i) => (posted.push(i), { text: "ok" }) }],
  });
  const first = await eventsUntil(handle, (e) => e.type === "permission.request");
  const req = first.at(-1)!;
  assert.ok(req.type === "permission.request" && req.request.toolName === "Bash");
  handle.answer(req.request.id, { behavior: "allow", scope: "once" });
  await eventsUntil(handle, (e) => e.type === "turn.end");
  assert.equal(posted.length, 1);
  await handle.close();
});

test("forkAt copies history up to, not including, a user message; start with forkAtMessageId does the same", async () => {
  const h = fakeHarness();
  const handle = h.start({ cwd: "/p", sessionId: "s1", prompt: { text: "one" } });
  await eventsUntil(handle, (e) => e.type === "state" && e.state === "idle");
  handle.send({ text: "two" });
  await eventsUntil(handle, (e) => e.type === "state" && e.state === "idle");
  const parent = await h.messages("s1");
  const second = parent.filter((e) => e.kind === "user")[1]!;
  const forked = await h.forkAt!("s1", second.id);
  assert.deepEqual((await h.messages(forked)).map((e) => e.kind), ["user", "assistant"]);
  const live = h.start({ cwd: "/p", resume: "s1", fork: true, sessionId: "s2", forkAtMessageId: second.id });
  assert.deepEqual((await h.messages("s2")).map((e) => e.kind), ["user", "assistant"]);
  await assert.rejects(h.forkAt!("s1", parent.find((e) => e.kind === "assistant")!.id), /not a user message/);
  await live.close();
  await handle.close();
  assert.equal((await h.messages("s1")).length, 4);
});
