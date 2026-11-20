import { test } from "node:test";
import assert from "node:assert/strict";
import { watchEvents, startApp } from "../test-helpers.ts";
import { parseSessionFilter } from "./routes.ts";
import { PROJECT, serve, setup, waitFor } from "./test-setup.ts";

test("HTTP session launch, queue edits and forks accept attachments above the former JSON cap", async () => {
  const s = setup({ harness: { script: () => [{ wait: new Promise<void>(() => {}) }] } });
  const app = await serve(s);
  const message = { text: "image", attachments: [{ name: "image.png", mediaType: "image/png", data: Buffer.alloc(1024 * 1024).toString("base64") }] };
  try {
    const started = await app.post("/api/sessions", { project: PROJECT, prompt: message });
    assert.equal(started.status, 201);
    const session = await started.json();
    const base = `/api/sessions/${session.id}`;
    assert.equal((await app.post(`${base}/messages`, message)).status, 200);
    const q = s.sessions.queue(session.id);
    assert.equal((await app.api(`${base}/queue/${q.messages[0]!.id}`, { method: "PATCH", body: JSON.stringify(message) })).status, 200);
    assert.equal((await app.post(`${base}/fork`, { prompt: message })).status, 201);
    const invalid = { text: "x", attachments: [{ name: "broken" }] };
    assert.equal((await app.post("/api/sessions", { project: PROJECT, prompt: invalid })).status, 400);
    assert.equal((await app.post(`${base}/messages`, invalid)).status, 400);
  } finally { await app.close(); }
});

test("GET /api/sessions/:id/attachments/:entry/:index returns the file from that turn", async () => {
  const s = setup();
  const app = await serve(s);
  try {
    const started = await app.post("/api/sessions", {
      project: PROJECT,
      prompt: {
        text: "see",
        attachments: [
          { name: "pic.png", mediaType: "image/png", data: Buffer.from("png-bytes").toString("base64") },
          { name: "notes.md", mediaType: "text/markdown", data: "# hello" },
        ],
      },
    });
    assert.equal(started.status, 201);
    const session = await started.json();
    await waitFor(() => s.sessions.get(session.id)?.state === "idle");
    const detail = await (await app.api(`/api/sessions/${session.id}`)).json();
    const user = detail.transcript.find((entry: { kind: string }) => entry.kind === "user");
    assert.ok(user);
    const image = await app.api(`/api/sessions/${session.id}/attachments/${encodeURIComponent(user.id)}/0`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.equal(image.headers.get("x-content-type-options"), "nosniff");
    assert.equal(Buffer.from(await image.arrayBuffer()).toString(), "png-bytes");
    const note = await app.api(`/api/sessions/${session.id}/attachments/${encodeURIComponent(user.id)}/1`);
    assert.equal(note.status, 200);
    assert.equal(note.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(await note.text(), "# hello");
    assert.equal((await app.api(`/api/sessions/${session.id}/attachments/${encodeURIComponent(user.id)}/2`)).status, 404);
    assert.equal((await app.api(`/api/sessions/${session.id}/attachments/${encodeURIComponent(user.id)}/no`)).status, 400);
  } finally {
    await app.close();
  }
});

test("POST /api/sessions → 201, SSE session.updated + session.event, detail with transcript", async () => {
  const s = setup();
  const app = await serve(s);
  try {
    const sse = watchEvents(app.base, (evs) => evs.some((e) => e.type === "session.event" && e.event.type === "turn.end"), 3000);
    await sse.connected;
    const res = await app.post("/api/sessions", { project: PROJECT, prompt: { text: "hi" } });
    assert.equal(res.status, 201);
    const session = await res.json();
    assert.equal(session.state, "running");
    const events = await sse.events;
    assert.ok(events.some((e) => e.type === "session.updated" && e.session.id === session.id));
    assert.ok(events.some((e) => e.type === "session.event" && e.sessionId === session.id && e.event.type === "init"));

    await waitFor(() => s.sessions.get(session.id)?.state === "idle");
    const detail = await (await app.api(`/api/sessions/${session.id}`)).json();
    assert.equal(detail.live, true);
    assert.deepEqual(detail.transcript.map((e: { kind: string }) => e.kind), ["user", "assistant"]);
    assert.equal((await app.api("/api/sessions/nope")).status, 404);

    const list = await (await app.api(`/api/sessions?project=${PROJECT}&state=idle`)).json();
    assert.deepEqual(list.map((x: { id: string }) => x.id), [session.id]);
    assert.equal((await app.api("/api/sessions?state=bogus")).status, 400);

    const sent = await app.post(`/api/sessions/${session.id}/messages`, { text: "more" });
    assert.equal(sent.status, 200);
    await waitFor(() => s.harness.handles.get(session.id)!.sent.length === 2);
    await waitFor(() => s.sessions.get(session.id)?.state === "idle");

    assert.equal((await app.post(`/api/sessions/${session.id}/interrupt`)).status, 204);
    const patched = await (await app.api(`/api/sessions/${session.id}`, { method: "PATCH", body: JSON.stringify({ tags: ["a"] }) })).json();
    assert.deepEqual(patched.tags, ["a"]);

    const forked = await app.post(`/api/sessions/${session.id}/fork`, {});
    assert.equal(forked.status, 201);
    assert.equal((await forked.json()).parentId, session.id);

    const ended = await (await app.post(`/api/sessions/${session.id}/end`)).json();
    assert.equal(ended.state, "ended");
    const stored = await app.api(`/api/sessions/${session.id}`, { method: "PATCH", body: JSON.stringify({ model: "x" }) });
    assert.equal(stored.status, 200, "an ended session stores the model for its resume");
    assert.equal((await stored.json()).model, "x");

    assert.equal((await app.api(`/api/sessions/${session.id}`, { method: "DELETE" })).status, 204);
    assert.equal((await app.api(`/api/sessions/${session.id}`)).status, 404);
  } finally {
    await app.close();
  }
});

test("permission routes: 204 on answer, 409 on a closed prompt, 404 on an unknown session", async () => {
  const s = setup({ harness: { script: () => [{ tool: "Bash", input: { command: "ls" }, ask: true }] } });
  const app = await serve(s);
  try {
    const session = await (await app.post("/api/sessions", { project: PROJECT, prompt: { text: "run" } })).json();
    await waitFor(() => s.sessions.get(session.id)?.state === "waiting");
    const detail = await (await app.api(`/api/sessions/${session.id}`)).json();
    const rid = detail.pending[0].id;
    assert.equal((await app.post(`/api/sessions/${session.id}/messages`, { text: "x" })).status, 409);
    assert.equal((await app.post(`/api/sessions/nope/permissions/${rid}`, { behavior: "allow", scope: "once" })).status, 404);
    assert.equal((await app.post(`/api/sessions/${session.id}/permissions/${rid}`, { behavior: "deny", message: "no" })).status, 204);
    assert.equal((await app.post(`/api/sessions/${session.id}/permissions/${rid}`, { behavior: "allow", scope: "once" })).status, 409);
    await waitFor(() => s.sessions.get(session.id)?.state === "idle");
  } finally {
    await app.close();
  }
});

test("discover and models routes", async () => {
  const s = setup();
  const app = await serve(s);
  try {
    s.harness.seed({ sessionId: "ext-1", cwd: s.projectPath });
    assert.deepEqual(await (await app.post(`/api/projects/${PROJECT}/discover`)).json(), { added: 1 });
    assert.equal((await app.post("/api/projects/nope/discover")).status, 404);
    const models = await (await app.api("/api/models")).json();
    assert.ok(models.some((m: { value: string }) => m.value === "default"));
    assert.equal((await app.api("/api/models?harness=claude")).status, 200);
    assert.equal((await app.api("/api/models?harness=pi")).status, 400);
    assert.equal((await app.post("/api/sessions", { project: PROJECT, prompt: { text: "x" }, templateId: "t" })).status, 400);
  } finally {
    await app.close();
  }
});

test("parseSessionFilter: archived defaults to false; validation", () => {
  assert.deepEqual(parseSessionFilter(new URLSearchParams("")), { archived: false });
  assert.deepEqual(parseSessionFilter(new URLSearchParams("project=p&state=idle,running&tag=t&model=m&origin=external&q=%20x%20&archived=true&pinned=1&since=2026-10-01&limit=5000")), {
    project: "p", state: ["idle", "running"], tag: "t", model: "m", origin: "external", q: "x", archived: true, pinned: true, since: "2026-10-01", limit: 1000,
  });
  for (const q of ["origin=x", "archived=maybe", "limit=0", "since=never", "state=idle,nope"]) {
    assert.throws(() => parseSessionFilter(new URLSearchParams(q)), (e: unknown) => (e as { status?: number }).status === 400, q);
  }
});

test("the real app serves the sessions routes", async () => {
  const app = await startApp();
  try {
    assert.deepEqual(await app.json("/api/sessions"), []);
    const models = await app.json("/api/models");
    assert.ok(Array.isArray(models) && models.length > 0);
  } finally {
    await app.close();
  }
});

test("POST /api/sessions/:id/shell runs a command in the session cwd and validates input", async () => {
  const s = setup();
  const app = await serve(s);
  try {
    const started = await (await app.post("/api/sessions", { project: PROJECT, prompt: { text: "hi" } })).json();
    const url = `/api/sessions/${started.id}/shell`;
    const ok = await app.post(url, { command: "echo hello && echo oops 1>&2; exit 3" });
    assert.equal(ok.status, 200);
    const result = await ok.json();
    assert.match(result.output, /hello/);
    assert.match(result.output, /oops/);
    assert.equal(result.exitCode, process.platform === "win32" ? result.exitCode : 3);
    assert.equal(result.timedOut, false);
    assert.equal((await app.post(url, { command: "  " })).status, 400);
    assert.equal((await app.post(url, {})).status, 400);
    assert.equal((await app.post("/api/sessions/nope/shell", { command: "echo" })).status, 404);
  } finally { await app.close(); }
});
