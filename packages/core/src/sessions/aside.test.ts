// Side threads (`Session.aside`) and fork overrides. docs/contracts.md#sessions (Fork, Side thread).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Session } from "@odin/shared/api";
import { watchEvents } from "../test-helpers.ts";
import { HttpError } from "../http/util.ts";
import { parseSessionFilter } from "./routes.ts";
import { sideTitle } from "./service.ts";
import { PROJECT, serve, setup, waitFor } from "./test-setup.ts";

const status = (n: number) => (e: unknown) => e instanceof HttpError && e.status === n;
const idle = (s: ReturnType<typeof setup>, id: string) => waitFor(() => s.sessions.get(id)?.state === "idle", 2000, `${id} idle`);
const ids = (list: Session[]) => list.map((x) => x.id).sort();

test("sideTitle: first 60 characters on one line, ellipsis when cut", () => {
  assert.equal(sideTitle({ text: "  why is\nthis   slow?  " }), "Side: why is this slow?");
  const long = "a".repeat(59) + " bcdef";
  assert.equal(sideTitle({ text: long }), `Side: ${"a".repeat(59)}…`);
  assert.equal(sideTitle({ text: "x".repeat(60) }), `Side: ${"x".repeat(60)}`);
  assert.equal(sideTitle({ text: "", attachments: [{ name: "a.png", mediaType: "image/png", data: "" }] }), "Side question");
});

test("aside fork: validation, plan mode and title defaults, stored aside with parentId", async () => {
  const s = setup();
  try {
    const st = await s.sessions.start({ project: PROJECT, prompt: { text: "base" }, permissionMode: "acceptEdits" });
    await idle(s, st.id);
    await assert.rejects(s.sessions.fork(st.id, { aside: true }), status(400), "prompt required");
    await assert.rejects(s.sessions.fork(st.id, { aside: true, prompt: { text: "q" }, worktree: true }), status(400), "no worktree");
    await assert.rejects(s.sessions.fork(st.id, { aside: "yes" as never, prompt: { text: "q" } }), status(400));
    await assert.rejects(s.sessions.fork(st.id, { prompt: { text: "q" }, permissionMode: "bogus" as never }), status(400));
    await assert.rejects(s.sessions.fork(st.id, { prompt: { text: "q" }, model: " " }), status(400));
    const startsBefore = s.harness.starts.length;

    const side = await s.sessions.fork(st.id, { aside: true, prompt: { text: "What does this function return?" } });
    assert.equal(side.aside, true);
    assert.equal(side.parentId, st.id);
    assert.equal(side.title, "Side: What does this function return?");
    assert.equal(side.permissionMode, "plan");
    assert.equal(side.workspace.kind, "checkout");
    assert.equal(s.harness.starts.length, startsBefore + 1);
    const opts = s.harness.starts.at(-1)!;
    assert.deepEqual([opts.resume, opts.fork, opts.sessionId, opts.permissionMode, opts.prompt!.text], [st.id, true, side.id, "plan", "What does this function return?"]);
    await idle(s, side.id);
    assert.equal((await s.sessions.detail(side.id))!.transcript.length, 4, "the parent's history plus the side turn");

    const explicit = await s.sessions.fork(st.id, { aside: true, prompt: { text: "q" }, permissionMode: "default", title: "Mine" });
    assert.equal(explicit.permissionMode, "default");
    assert.equal(explicit.title, "Mine");
    assert.equal(s.harness.starts.at(-1)!.permissionMode, "default");
  } finally {
    await s.sessions.close();
  }
});

test("fork overrides permissionMode and model for ordinary forks too (with and without a prompt)", async () => {
  const s = setup();
  try {
    const st = await s.sessions.start({ project: PROJECT, prompt: { text: "base" }, model: "sonnet", permissionMode: "default" });
    await idle(s, st.id);
    const f = await s.sessions.fork(st.id, { prompt: { text: "again" }, permissionMode: "acceptEdits", model: " opus " });
    assert.equal(f.aside, false);
    assert.equal(f.title, "base (fork)");
    assert.equal(f.permissionMode, "acceptEdits");
    assert.equal(f.model, "opus");
    const opts = s.harness.starts.at(-1)!;
    assert.deepEqual([opts.model, opts.permissionMode], ["opus", "acceptEdits"]);
    await idle(s, f.id);
    // init from the handle reports what it started with
    assert.equal(s.sessions.get(f.id)!.permissionMode, "acceptEdits");

    const stored = await s.sessions.fork(st.id, { model: "haiku" });
    assert.equal(stored.model, "haiku");
    assert.equal(stored.permissionMode, "default", "the parent's mode by default");
  } finally {
    await s.sessions.close();
  }
});

test("aside fork while the parent is waiting on a prompt (mid-turn)", async () => {
  const s = setup({ harness: { script: (m) => (m.text === "clean up" ? [{ tool: "Bash", input: { command: "rm -rf build" }, ask: true }] : [{ text: "answer" }]) } });
  try {
    const st = await s.sessions.start({ project: PROJECT, prompt: { text: "clean up" } });
    await waitFor(() => s.sessions.get(st.id)?.state === "waiting", 2000, "parent waiting");
    const side = await s.sessions.fork(st.id, { aside: true, prompt: { text: "is that safe?" } });
    assert.equal(side.state, "running");
    assert.equal(s.sessions.get(st.id)!.state, "waiting", "the parent is untouched");
    await idle(s, side.id);
    assert.equal(s.sessions.get(st.id)!.state, "waiting");
  } finally {
    await s.sessions.close();
  }
});

test("list leaves side threads out unless asked; counts leave them out; promote", async () => {
  const s = setup();
  try {
    const st = await s.sessions.start({ project: PROJECT, prompt: { text: "base" } });
    await idle(s, st.id);
    const side = await s.sessions.fork(st.id, { aside: true, prompt: { text: "q" } });
    const fork = await s.sessions.fork(st.id, {});
    await idle(s, side.id);

    assert.deepEqual(ids(s.sessions.list()), ids([st, fork]));
    assert.deepEqual(ids(s.sessions.list({ aside: false, project: PROJECT })), ids([st, fork]));
    assert.deepEqual(ids(s.sessions.list({ aside: true })), [side.id]);
    assert.deepEqual(ids(s.sessions.list({ parentId: st.id })), ids([side, fork]), "children include side threads");
    assert.deepEqual(ids(s.sessions.list({ parentId: st.id, aside: false })), ids([side, fork]), "aside ignored with parentId");
    assert.deepEqual(s.sessions.list({ parentId: side.id }), []);
    assert.deepEqual(s.sessions.counts(), { running: 0, waiting: 0, total: 2 });
    assert.equal(s.sessions.counts(PROJECT).total, 2);

    await assert.rejects(s.sessions.update(side.id, { aside: true }), status(400));
    await assert.rejects(s.sessions.update(side.id, { aside: "no" as never }), status(400));
    const updated: Session[] = [];
    s.sessions.onUpdated((x) => void updated.push(x));
    const promoted = await s.sessions.update(side.id, { aside: false, title: "Kept" });
    assert.equal(promoted.aside, false);
    assert.equal(promoted.title, "Kept");
    assert.equal(promoted.parentId, st.id);
    assert.ok(updated.some((x) => x.id === side.id && !x.aside), "session.updated fires on promote");
    assert.deepEqual(ids(s.sessions.list()), ids([st, fork, side]));
    assert.equal(s.sessions.counts().total, 3);
    assert.equal((await s.sessions.update(st.id, { aside: false })).aside, false, "aside: false on an ordinary session is a no-op");
  } finally {
    await s.sessions.close();
  }
});

test("parseSessionFilter: aside and parentId", () => {
  assert.deepEqual(parseSessionFilter(new URLSearchParams("aside=true&parentId=abc")), { archived: false, aside: true, parentId: "abc" });
  assert.deepEqual(parseSessionFilter(new URLSearchParams("aside=0")), { archived: false, aside: false });
  assert.throws(() => parseSessionFilter(new URLSearchParams("aside=maybe")), (e: unknown) => (e as { status?: number }).status === 400);
});

test("routes: aside fork, GET filters, PATCH promote with session.updated, 400s", async () => {
  const s = setup();
  const app = await serve(s);
  try {
    const st = await (await app.post("/api/sessions", { project: PROJECT, prompt: { text: "base" } })).json();
    await idle(s, st.id);
    assert.equal((await app.post(`/api/sessions/${st.id}/fork`, { aside: true })).status, 400);
    assert.equal((await app.post(`/api/sessions/${st.id}/fork`, { aside: true, prompt: { text: "q" }, worktree: true })).status, 400);
    const res = await app.post(`/api/sessions/${st.id}/fork`, { aside: true, prompt: { text: "side question" } });
    assert.equal(res.status, 201);
    const side = await res.json();
    assert.equal(side.aside, true);
    assert.equal(side.permissionMode, "plan");
    await idle(s, side.id);

    const list = async (q: string) => ((await (await app.api(`/api/sessions${q}`)).json()) as Session[]).map((x) => x.id);
    assert.deepEqual(await list(""), [st.id]);
    assert.deepEqual(await list("?aside=true"), [side.id]);
    assert.deepEqual(await list(`?parentId=${st.id}&aside=true`), [side.id]);
    assert.equal((await app.api("/api/sessions?aside=maybe")).status, 400);

    const patch = (body: unknown) => app.api(`/api/sessions/${side.id}`, { method: "PATCH", body: JSON.stringify(body) });
    assert.equal((await patch({ aside: true })).status, 400);
    const sse = watchEvents(app.base, (evs) => evs.some((e) => e.type === "session.updated" && e.session.id === side.id && !e.session.aside), 3000);
    await sse.connected;
    const promoted = await patch({ aside: false });
    assert.equal(promoted.status, 200);
    assert.equal((await promoted.json()).aside, false);
    await sse.events;
    assert.deepEqual((await list("")).sort(), [st.id, side.id].sort());
  } finally {
    await app.close();
  }
});
