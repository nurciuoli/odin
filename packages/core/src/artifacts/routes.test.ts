// Artifacts through the real app: a started session posts through the post_artifact host tool (fake harness script
// step), the page is served under /a/ with the CSP and the bridge, and submit sends the answer into the session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactDetail, Session, SessionDetail } from "@odin/shared/api";
import { fakeHarness, type FakeScript } from "../harness/fake.ts";
import { collectEvents, startApp, type TestApp } from "../test-helpers.ts";
import { ARTIFACT_CSP } from "./routes.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function tempRepo(): { path: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "odin-artifacts-"));
  const path = join(root, "demo");
  mkdirSync(path);
  git(path, "init", "-q", "-b", "main");
  writeFileSync(join(path, "README.md"), "# demo\n");
  git(path, "add", ".");
  git(path, "commit", "-qm", "init");
  return { path, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function until(cond: () => Promise<boolean>, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Choose</title></head><body><button onclick="odin.submit({ choice: 'A' })">A</button></body></html>`;

/** "post" posts a new artifact; "again <id>" a new version of <id>; "ask" opens a permission prompt. */
const script: FakeScript = (message) => {
  const t = message.text;
  const again = /^again (\S+)/.exec(t);
  if (t === "post") return [{ hostTool: "post_artifact", input: { title: "Choose", html: PAGE, note: "first" } }, { text: "posted" }];
  if (again) return [{ hostTool: "post_artifact", input: { title: "Choose v2", html: "<p>two</p>", artifact_id: Number(again[1]) } }, { text: "again" }];
  if (t === "ask") return [{ tool: "Write", input: { file_path: "x.txt", content: "x" }, ask: true }, { text: "asked" }];
  return [{ text: `ok: ${t}` }];
};

const post = (app: TestApp, path: string, body?: unknown) => app.api(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
const detail = (app: TestApp, id: string) => app.json<SessionDetail>(`/api/sessions/${id}`);
const stateIs = (app: TestApp, id: string, state: Session["state"]) => async () => (await detail(app, id)).state === state;

/** The post_artifact tool results in a session's transcript, in order. */
async function toolResults(app: TestApp, id: string): Promise<{ ok: boolean; text: string }[]> {
  const d = await detail(app, id);
  return d.transcript.flatMap((e) => (e.kind === "tool" && e.name === "mcp__odin__post_artifact" && e.result ? [{ ok: e.result.ok, text: e.result.text }] : []));
}

test("artifacts: post through the host tool, new version, refusal, served page, submit", async () => {
  const repo = tempRepo();
  const harness = fakeHarness({ script });
  const app = await startApp({ harnesses: { claude: harness } });
  try {
    assert.equal((await post(app, "/api/projects", { path: repo.path })).status, 201);

    // Start → the tool posts an artifact; artifact.updated goes out over SSE.
    const sse = collectEvents(app.base, (evs) => evs.some((e) => e.type === "artifact.updated"), 3000);
    await new Promise((r) => setTimeout(r, 50));
    const res = await post(app, "/api/sessions", { project: "demo", prompt: { text: "post" } });
    assert.equal(res.status, 201);
    const s1 = (await res.json()) as Session;
    assert.ok(harness.starts[0]!.hostTools!.some(t => t.name === "post_artifact"));
    assert.ok(harness.starts[0]!.hostTools!.some(t => t.name === "notebook_execute"));
    const frames = await sse;
    const update = frames.find((e) => e.type === "artifact.updated");
    assert.ok(update && update.type === "artifact.updated");
    assert.equal(update.sessionId, s1.id);
    assert.equal(update.artifact.title, "Choose");
    assert.equal(update.artifact.project, "demo");
    assert.equal(update.artifact.latestVersion, 1);
    const id = update.artifact.id;

    await until(stateIs(app, s1.id, "idle"), "first turn");
    assert.deepEqual(await toolResults(app, s1.id), [{ ok: true, text: `Posted artifact ${id} v1` }]);
    assert.deepEqual((await detail(app, s1.id)).artifacts.map((a) => [a.id, a.latestVersion]), [[id, 1]]);

    // A new version of the same artifact.
    assert.equal((await post(app, `/api/sessions/${s1.id}/messages`, { text: `again ${id}` })).status, 200);
    await until(async () => (await toolResults(app, s1.id)).length === 2, "second post");
    assert.deepEqual((await toolResults(app, s1.id))[1], { ok: true, text: `Posted artifact ${id} v2` });
    const art = await app.json<ArtifactDetail>(`/api/artifacts/${id}`);
    assert.equal(art.artifact.title, "Choose v2");
    assert.equal(art.artifact.latestVersion, 2);
    assert.deepEqual(art.versions.map((v) => [v.version, v.bytes, v.note]), [[1, Buffer.byteLength(PAGE), "first"], [2, 10, ""]]);
    await until(stateIs(app, s1.id, "idle"), "second turn");

    // Another session can't post a version of s1's artifact.
    const s2 = (await (await post(app, "/api/sessions", { project: "demo", prompt: { text: `again ${id}` } })).json()) as Session;
    await until(async () => (await toolResults(app, s2.id)).length === 1, "refused post");
    const [refused] = await toolResults(app, s2.id);
    assert.equal(refused!.ok, false);
    assert.match(refused!.text, new RegExp(`artifact ${id} isn't one of this session's artifacts`));
    assert.deepEqual((await detail(app, s2.id)).artifacts, []);
    assert.equal((await app.json<ArtifactDetail>(`/api/artifacts/${id}`)).versions.length, 2);

    // The served page: exact CSP, the other headers, the bridge just before </head>.
    const page = await app.api(`/a/${id}/1`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(page.headers.get("content-security-policy"), ARTIFACT_CSP);
    assert.match(ARTIFACT_CSP, /sandbox allow-scripts allow-forms$/);
    assert.ok(!ARTIFACT_CSP.includes("allow-same-origin"));
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    assert.equal(page.headers.get("cross-origin-resource-policy"), "same-origin");
    const html = await page.text();
    const scriptAt = html.indexOf("<script>");
    assert.ok(scriptAt > 0);
    assert.equal(html.slice(scriptAt).indexOf("</script></head>"), html.slice(scriptAt).indexOf("</script>"));
    assert.equal(html.replace(/<script>[\s\S]*?<\/script>/, ""), PAGE);
    assert.match(html, new RegExp(`"artifactId":${id},"version":1,`));
    const v2 = await (await app.api(`/a/${id}/2`)).text();
    assert.ok(v2.startsWith("<script>") && v2.endsWith("</script><p>two</p>"));
    for (const bad of [`/a/${id}/3`, `/a/${id}/0`, `/a/0${id}/1`, `/a/abc/1`, `/a/${id}/1e0`, `/a/999/1`]) {
      const r = await app.api(bad);
      assert.equal(r.status, 404, bad);
      assert.equal(r.headers.get("content-security-policy"), null);
    }
    assert.equal((await app.api("/api/artifacts/999")).status, 404);
    assert.equal((await app.api("/api/artifacts/x")).status, 404);

    // Submit: validation, then the user message it sends.
    assert.equal((await post(app, `/api/artifacts/${id}/submit`, { version: 9, data: {} })).status, 404);
    assert.equal((await post(app, `/api/artifacts/${id}/submit`, { version: 1, data: "x".repeat(70 * 1024) })).status, 413);
    assert.equal((await post(app, `/api/artifacts/${id}/submit`, { version: 1 })).status, 400);
    assert.equal((await post(app, `/api/artifacts/${id}/submit`, [1])).status, 400);
    assert.equal((await post(app, "/api/artifacts/999/submit", { version: 1, data: {} })).status, 404);
    const sub = await post(app, `/api/artifacts/${id}/submit`, { version: 1, data: { choice: "A" } });
    assert.equal(sub.status, 200);
    assert.equal(((await sub.json()) as Session).id, s1.id);
    const sent = harness.handles.get(s1.id)!.sent;
    assert.equal(sent.at(-1)!.text, 'Answer from "Choose v2" (v1):\n\n```json\n{\n  "choice": "A"\n}\n```');
    await until(stateIs(app, s1.id, "idle"), "submit turn");

    // While the session waits on a prompt, submit is a 409 and sends nothing.
    await post(app, `/api/sessions/${s1.id}/messages`, { text: "ask" });
    await until(stateIs(app, s1.id, "waiting"), "prompt");
    const count = harness.handles.get(s1.id)!.sent.length;
    const busy = await post(app, `/api/artifacts/${id}/submit`, { version: 2, data: 1 });
    assert.equal(busy.status, 409);
    assert.equal(harness.handles.get(s1.id)!.sent.length, count);
  } finally {
    await app.close();
    repo.cleanup();
  }
});
