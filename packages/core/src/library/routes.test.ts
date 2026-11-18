import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssetDetail, Installation, InstallResult, LibraryAsset } from "@odin/shared/api";
import { startApp } from "../test-helpers.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "odin-library-routes-")));
after(() => rmSync(root, { recursive: true, force: true }));

const AGENT = (d: string) => `---\nname: helper\ndescription: ${d}\n---\nHelp.\n`;

function repo(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: dir });
  return dir;
}

test("library routes: list, save, detail, versions, delete, rescan", async () => {
  const t = await startApp();
  try {
    const put = (kind: string, id: string, files: unknown) => t.api(`/api/library/${kind}/${id}`, { method: "PUT", body: JSON.stringify({ files }) });

    const created = await put("agent", "helper", { "helper.md": AGENT("One") });
    assert.equal(created.status, 201);
    const v1 = ((await created.json()) as LibraryAsset).version;
    const replaced = await put("agent", "helper", { "helper.md": AGENT("Two") });
    assert.equal(replaced.status, 200);
    assert.equal(((await replaced.json()) as LibraryAsset).description, "Two");

    const list = await t.json<LibraryAsset[]>("/api/library?kind=agent");
    assert.ok(list.some((a) => a.id === "helper"));
    assert.ok(list.every((a) => a.kind === "agent"));
    assert.equal((await t.api("/api/library?kind=widget")).status, 400);

    const detail = await t.json<AssetDetail>("/api/library/agent/helper");
    assert.equal(detail.files["helper.md"], AGENT("Two"));
    assert.equal(detail.versions.length, 2);
    assert.deepEqual(await t.json(`/api/library/agent/helper/versions/${v1}`), { "helper.md": AGENT("One") });
    assert.equal((await t.api("/api/library/agent/helper/versions/nope")).status, 404);
    assert.equal((await t.api("/api/library/agent/nope")).status, 404);
    assert.equal((await t.api("/api/library/agent/Bad_Id")).status, 400);

    const bad = await put("skill", "x", { "SKILL.md": "---\nname: x\ndescription: y\n---\n", "../evil": "x" });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /invalid file path/);
    assert.equal((await put("mcp", "x", { "x.json": "{ nope" })).status, 400);
    assert.equal((await t.api("/api/library/agent/helper", { method: "PUT", body: "{}" })).status, 400);

    assert.equal((await t.api("/api/library/agent/helper", { method: "DELETE" })).status, 204);
    assert.equal((await t.api("/api/library/agent/helper", { method: "DELETE" })).status, 404);
    assert.equal((await t.api("/api/library/rescan", { method: "POST" })).status, 204);
  } finally {
    await t.close();
  }
});

test("project library routes: install, list, files, forget", async () => {
  const t = await startApp();
  try {
    const path = repo("proj");
    await t.json("/api/projects", { method: "POST", body: JSON.stringify({ path, name: "proj" }) });
    await t.json("/api/library/agent/helper", { method: "PUT", body: JSON.stringify({ files: { "helper.md": AGENT("One") } }) });

    const result = await t.json<InstallResult>("/api/projects/proj/library", { method: "POST", body: JSON.stringify({ kind: "agent", id: "helper", action: "install" }) });
    assert.deepEqual(result.changed, [".claude/agents/helper.md"]);
    assert.equal(readFileSync(join(path, ".claude/agents/helper.md"), "utf8"), AGENT("One"));

    const installs = await t.json<Installation[]>("/api/projects/proj/library");
    assert.deepEqual(installs.map((i) => [i.id, i.state]), [["helper", "current"]]);
    assert.deepEqual(await t.json("/api/projects/proj/library/agent/helper/files"), { "helper.md": AGENT("One") });
    assert.equal((await t.api("/api/projects/proj/library/skill/nope/files")).status, 404);

    // The projects service sees the install: the agent carries its libraryId, and the file is dirty. noteWritten
    // re-reads the project in the background, so wait for that read to land.
    let detail = await t.json("/api/projects/proj");
    for (let i = 0; i < 200 && !detail.agents.some((a: { id: string }) => a.id === "helper"); i++) {
      await new Promise((r) => setTimeout(r, 10));
      detail = await t.json("/api/projects/proj");
    }
    assert.equal(detail.agents.find((a: { id: string }) => a.id === "helper")?.libraryId, "helper");
    assert.ok(detail.dirtyFiles.includes(".claude/agents/helper.md"));

    const again = await t.api("/api/projects/proj/library", { method: "POST", body: JSON.stringify({ kind: "agent", id: "other", action: "install" }) });
    assert.equal(again.status, 404);
    assert.equal((await t.api("/api/projects/proj/library", { method: "POST", body: JSON.stringify({ kind: "prompt", id: "x", action: "install" }) })).status, 400);
    assert.equal((await t.api("/api/projects/proj/library", { method: "POST", body: JSON.stringify({ kind: "agent", id: "helper", action: "install", force: "yes" }) })).status, 400);
    assert.equal((await t.api("/api/projects/ghost/library")).status, 404);

    const forgot = await t.json<InstallResult>("/api/projects/proj/library", { method: "POST", body: JSON.stringify({ kind: "agent", id: "helper", action: "forget" }) });
    assert.equal(forgot.installation, null);
    assert.ok(existsSync(join(path, ".claude/agents/helper.md")));
    assert.deepEqual(await t.json("/api/projects/proj/library"), []);
  } finally {
    await t.close();
  }
});

test("library routes: disabling an asset blocks install and launch use but keeps the asset", async () => {
  const t = await startApp();
  try {
    const put = (kind: string, id: string, files: unknown) => t.api(`/api/library/${kind}/${id}`, { method: "PUT", body: JSON.stringify({ files }) });
    const patch = (kind: string, id: string, body: unknown) => t.api(`/api/library/${kind}/${id}`, { method: "PATCH", body: JSON.stringify(body) });
    await put("agent", "helper", { "helper.md": AGENT("One") });
    assert.equal((await t.json<LibraryAsset[]>("/api/library?kind=agent")).find((a) => a.id === "helper")?.enabled, true);

    assert.equal((await patch("agent", "helper", { enabled: "no" })).status, 400);
    assert.equal((await patch("agent", "nope", { enabled: false })).status, 404);
    const off = await patch("agent", "helper", { enabled: false });
    assert.equal(off.status, 200);
    assert.equal(((await off.json()) as LibraryAsset).enabled, false);
    assert.equal((await t.json<AssetDetail>("/api/library/agent/helper")).asset.enabled, false);

    // Editing a disabled asset keeps it disabled.
    await put("agent", "helper", { "helper.md": AGENT("Two") });
    assert.equal((await t.json<LibraryAsset[]>("/api/library?kind=agent")).find((a) => a.id === "helper")?.enabled, false);

    const dir = repo("enabled-project");
    const added = await t.api("/api/projects", { method: "POST", body: JSON.stringify({ path: dir }) });
    assert.ok(added.status < 300);
    const name = ((await added.json()) as { name: string }).name;
    const install = (action: string) => t.api(`/api/projects/${name}/library`, { method: "POST", body: JSON.stringify({ kind: "agent", id: "helper", action }) });
    assert.equal((await install("install")).status, 409);

    await patch("agent", "helper", { enabled: true });
    assert.equal((await install("install")).status, 200);
    // An installed copy can still be forgotten while the asset is disabled.
    await patch("agent", "helper", { enabled: false });
    assert.equal((await install("forget")).status, 200);

    // Deleting clears the flag, so a recreated asset starts enabled.
    assert.equal((await t.api("/api/library/agent/helper", { method: "DELETE" })).status, 204);
    await put("agent", "helper", { "helper.md": AGENT("Three") });
    assert.equal((await t.json<LibraryAsset[]>("/api/library?kind=agent")).find((a) => a.id === "helper")?.enabled, true);
  } finally {
    await t.close();
  }
});
