import { test } from "node:test";
import assert from "node:assert/strict";
import type { Session, UserMessage } from "@odin/shared/api";
import { HttpError } from "../http/util.ts";
import type { SessionsService } from "../services.ts";
import { stubServices, testDeps } from "../test-helpers.ts";
import { SUBMIT_MAX_BYTES } from "./bridge.ts";
import { createArtifactsService, HTML_MAX_BYTES, submitMessage } from "./service.ts";

function setup() {
  const deps = testDeps();
  const at = "2026-10-01T00:00:00Z";
  deps.db.prepare("INSERT INTO projects (name, path, created_at, updated_at) VALUES ('demo', '/x', ?, ?)").run(at, at);
  const addSession = (id: string, state: Session["state"] = "idle") =>
    deps.db
      .prepare("INSERT INTO sessions (id, harness, project, title, origin, state, cwd, created_at, updated_at, metrics) VALUES (?, 'claude', 'demo', 't', 'odin', ?, '/x', ?, ?, '{}')")
      .run(id, state, at, at);
  addSession("s1");
  addSession("s2");
  const sent: { id: string; message: UserMessage }[] = [];
  const sessions = {
    get: (id: string) => {
      const r = deps.db.prepare("SELECT id, state FROM sessions WHERE id = ?").get(id) as { id: string; state: Session["state"] } | undefined;
      return r ? ({ id: r.id, state: r.state } as Session) : null;
    },
    async send(id: string, message: UserMessage) {
      sent.push({ id, message });
      return { id, state: "running" } as Session;
    },
  } as unknown as SessionsService;
  const services = stubServices({ sessions });
  const artifacts = createArtifactsService(deps, services);
  services.artifacts = artifacts;
  const setState = (id: string, state: Session["state"]) => deps.db.prepare("UPDATE sessions SET state = ? WHERE id = ?").run(state, id);
  return { deps, artifacts, sent, setState };
}

const status = (status: number, message?: RegExp) => (err: unknown) => {
  assert.ok(err instanceof HttpError, `expected an HttpError, got ${err}`);
  assert.equal(err.status, status);
  if (message) assert.match(err.message, message);
  return true;
};

test("post: a new artifact, then a new version of it; artifact.updated each time", () => {
  const { artifacts, deps } = setup();
  const first = artifacts.post("s1", { title: "  Pick\none ", html: "<p>é</p>", note: "first" });
  assert.equal(first.version, 1);
  assert.deepEqual(first.artifact, {
    id: first.artifact.id, project: "demo", sessionId: "s1", title: "Pick one", latestVersion: 1,
    createdAt: "2026-10-17T12:00:00.000Z", updatedAt: "2026-10-17T12:00:00.000Z",
  });
  const second = artifacts.post("s1", { title: "Pick one (v2)", html: "<p>two</p>", artifactId: first.artifact.id });
  assert.equal(second.version, 2);
  assert.equal(second.artifact.id, first.artifact.id);
  assert.equal(second.artifact.latestVersion, 2);
  assert.equal(second.artifact.title, "Pick one (v2)");

  const updates = deps.events.filter((e) => e.type === "artifact.updated");
  assert.equal(updates.length, 2);
  assert.deepEqual(updates[1], { type: "artifact.updated", sessionId: "s1", artifact: second.artifact });

  assert.deepEqual(artifacts.forSession("s1"), [second.artifact]);
  assert.deepEqual(artifacts.forSession("s2"), []);
  const detail = artifacts.get(first.artifact.id)!;
  assert.deepEqual(detail.versions.map((v) => [v.version, v.bytes, v.note]), [[1, Buffer.byteLength("<p>é</p>"), "first"], [2, 10, ""]]);
  assert.equal(artifacts.html(first.artifact.id, 1), "<p>é</p>");
  assert.equal(artifacts.html(first.artifact.id, 3), null);
  assert.equal(artifacts.get(999), null);
});

test("post: another session's artifact id is refused and nothing is written", () => {
  const { artifacts, deps } = setup();
  const mine = artifacts.post("s1", { title: "a", html: "<p>a</p>" });
  const before = deps.events.length;
  assert.throws(() => artifacts.post("s2", { title: "b", html: "<p>b</p>", artifactId: mine.artifact.id }), status(404, /isn't one of this session's artifacts/));
  assert.throws(() => artifacts.post("s1", { title: "b", html: "<p>b</p>", artifactId: 4242 }), status(404));
  assert.equal(deps.events.length, before);
  assert.equal(artifacts.get(mine.artifact.id)!.versions.length, 1);
  assert.deepEqual(artifacts.forSession("s2"), []);
});

test("post: 8 MB cap on the HTML's UTF-8 bytes", () => {
  const { artifacts } = setup();
  assert.equal(artifacts.post("s1", { title: "big", html: "x".repeat(HTML_MAX_BYTES) }).version, 1);
  assert.throws(() => artifacts.post("s1", { title: "too big", html: "x".repeat(HTML_MAX_BYTES + 1) }), status(413, /over the 8 MB limit/));
  // Multibyte characters count as bytes, not characters.
  assert.throws(() => artifacts.post("s1", { title: "too big", html: "é".repeat(HTML_MAX_BYTES / 2 + 1) }), status(413));
});

test("post: input validation with messages a model can act on", () => {
  const { artifacts } = setup();
  assert.throws(() => artifacts.post("nope", { title: "a", html: "<p/>" }), status(404, /unknown session/));
  assert.throws(() => artifacts.post("s1", { title: " \n ", html: "<p/>" }), status(400, /title is required/));
  assert.throws(() => artifacts.post("s1", { title: "x".repeat(201), html: "<p/>" }), status(400, /over 200/));
  assert.throws(() => artifacts.post("s1", { title: "a", html: "  " }), status(400, /html is required/));
  assert.throws(() => artifacts.post("s1", { title: "a", html: 5 as unknown as string }), status(400, /html is required/));
  assert.throws(() => artifacts.post("s1", { title: "a", html: "<p/>", note: 3 as unknown as string }), status(400, /note/));
  assert.throws(() => artifacts.post("s1", { title: "a", html: "<p/>", artifactId: -1 }), status(400, /artifact_id/));
  assert.throws(() => artifacts.post("s1", { title: "a", html: "<p/>", artifactId: 1.5 }), status(400, /artifact_id/));
});

test("hostTools: post_artifact answers `Posted artifact <id> v<n>`, errors as isError text", async () => {
  const { artifacts } = setup();
  const tools = artifacts.hostTools("s1");
  assert.deepEqual(tools.map((t) => t.name), ["post_artifact"]);
  const tool = tools[0]!;
  assert.deepEqual(Object.keys(tool.params), ["title", "html", "note", "artifact_id"]);
  assert.equal(tool.params.title!.optional, undefined);
  assert.equal(tool.params.html!.optional, undefined);
  assert.equal(tool.params.note!.optional, true);
  assert.equal(tool.params.artifact_id!.type, "number");
  assert.equal(tool.params.artifact_id!.optional, true);

  const a = await tool.handler({ title: "Choose", html: "<p>1</p>", note: "n" });
  const id = artifacts.forSession("s1")[0]!.id;
  assert.deepEqual(a, { text: `Posted artifact ${id} v1` });
  // A quoted number is fine (models sometimes send one).
  assert.deepEqual(await tool.handler({ title: "Choose", html: "<p>2</p>", artifact_id: String(id) }), { text: `Posted artifact ${id} v2` });

  const other = await artifacts.hostTools("s2")[0]!.handler({ title: "x", html: "<p/>", artifact_id: id });
  assert.equal(other.isError, true);
  assert.match(other.text, /^post_artifact failed: artifact \d+ isn't one of this session's artifacts; omit artifact_id/);
  const missing = await tool.handler({ html: "<p/>" });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /title is required/);
});

test("submit: validates, then sends the answer into the artifact's session", async () => {
  const { artifacts, sent, setState } = setup();
  const { artifact } = artifacts.post("s1", { title: "Pick one", html: "<p/>" });
  artifacts.post("s1", { title: "Pick one", html: "<p>2</p>", artifactId: artifact.id });

  await assert.rejects(artifacts.submit(999, { version: 1, data: 1 }), status(404, /unknown artifact/));
  await assert.rejects(artifacts.submit(artifact.id, { version: 3, data: 1 }), status(404, /no version 3/));
  await assert.rejects(artifacts.submit(artifact.id, { version: "1" as unknown as number, data: 1 }), status(400, /version/));
  await assert.rejects(artifacts.submit(artifact.id, { version: 1 } as never), status(400, /data is required/));
  await assert.rejects(artifacts.submit(artifact.id, { version: 1, data: undefined }), status(400, /must be JSON/));
  await assert.rejects(artifacts.submit(artifact.id, { version: 1, data: "x".repeat(SUBMIT_MAX_BYTES - 1) }), status(413, /65536 bytes/));
  setState("s1", "waiting");
  await assert.rejects(artifacts.submit(artifact.id, { version: 1, data: { choice: "A" } }), status(409));
  assert.equal(sent.length, 0);

  setState("s1", "idle");
  // Exactly at the limit is accepted.
  await artifacts.submit(artifact.id, { version: 2, data: "x".repeat(SUBMIT_MAX_BYTES - 2) });
  const session = await artifacts.submit(artifact.id, { version: 1, data: { choice: "A", n: 2 } });
  assert.equal(session.id, "s1");
  assert.equal(sent.length, 2);
  assert.equal(sent[1]!.id, "s1");
  assert.equal(sent[1]!.message.text, 'Answer from "Pick one" (v1):\n\n```json\n{\n  "choice": "A",\n  "n": 2\n}\n```');
});

test("submitMessage: the fence is longer than any backtick run in the data", () => {
  const text = submitMessage("T", 1, { s: "a ```` b" });
  assert.equal(text, 'Answer from "T" (v1):\n\n`````json\n{\n  "s": "a ```` b"\n}\n`````');
});

test("forProject: newest updatedAt first, limit, other projects excluded", () => {
  const { artifacts, deps } = setup();
  let clock = 0;
  deps.now = () => new Date(Date.UTC(2026, 9, 1, 0, 0, clock++));
  const a = artifacts.post("s1", { title: "A", html: "<p>a</p>" }).artifact;
  const b = artifacts.post("s2", { title: "B", html: "<p>b</p>" }).artifact;
  artifacts.post("s1", { title: "A2", html: "<p>a2</p>", artifactId: a.id });
  assert.deepEqual(artifacts.forProject("demo").map((x) => x.id), [a.id, b.id]);
  assert.deepEqual(artifacts.forProject("demo", 1).map((x) => x.id), [a.id]);
  assert.deepEqual(artifacts.forProject("other"), []);
});
