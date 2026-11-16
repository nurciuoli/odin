import { test } from "node:test";
import assert from "node:assert/strict";
import { startApp } from "../test-helpers.ts";
import { ARTIFACT_CSP } from "./routes.ts";

test("browser report print shell keeps report HTML in the artifact sandbox", async () => {
  const app = await startApp();
  try {
    const db = app.app.deps.db, at = new Date().toISOString();
    db.prepare("INSERT INTO projects(name,path,created_at,updated_at) VALUES('print',?,?,?)").run(app.config.home, at, at);
    db.prepare("INSERT INTO sessions(id,project,title,harness,origin,state,cwd,created_at,updated_at,metrics) VALUES('print','print','report','claude','odin','idle',?,?,?,'{}')").run(app.config.home, at, at);
    const posted = app.app.services.artifacts.post("print", { title: "report", html: "<p>private report body</p>" });
    const shell = await app.api(`/api/artifacts/${posted.artifact.id}/print/1`);
    assert.equal(shell.status, 200);
    const html = await shell.text();
    assert.match(html, /sandbox="allow-scripts allow-forms"/);
    assert.doesNotMatch(html, /private report body|allow-same-origin|srcdoc/);
    const frame = await app.api(`/a/${posted.artifact.id}/1/print`);
    assert.equal(frame.headers.get("content-security-policy"), ARTIFACT_CSP);
    assert.match(await frame.text(), /private report body/);
    assert.equal((await app.api(`/api/artifacts/${posted.artifact.id}/print/0`)).status, 404);
  } finally { await app.close(); }
});
