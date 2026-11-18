import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssetDetail, Installation, InstallResult, PluginPreview } from "@odin/shared/api";
import { startApp } from "../test-helpers.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "odin-plugins-")));
after(() => rmSync(root, { recursive: true, force: true }));

const SKILL = (d: string) => `---\nname: notes\ndescription: ${d}\n---\nDo it.\n`;
const AGENT = "---\nname: helper\ndescription: Helps\n---\nHelp.\n";

type T = Awaited<ReturnType<typeof startApp>>;

let n = 0;
function repo(name: string): string {
  const dir = join(root, `${name}-${++n}`);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: dir });
  return dir;
}

async function setup(project = "proj") {
  const t = await startApp();
  const path = repo(project);
  await t.json("/api/projects", { method: "POST", body: JSON.stringify({ path, name: project }) });
  return { t, path };
}

const put = (t: T, kind: string, id: string, files: Record<string, string>) => t.api(`/api/library/${kind}/${id}`, { method: "PUT", body: JSON.stringify({ files }) });
const act = (t: T, project: string, body: Record<string, unknown>) => t.api(`/api/projects/${project}/library`, { method: "POST", body: JSON.stringify(body) });
const actJson = async <R = InstallResult>(t: T, project: string, body: Record<string, unknown>) => {
  const res = await act(t, project, body);
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()) as R;
};
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

async function releasePlugin(t: T, extra: Record<string, string> = {}) {
  await put(t, "agent", "helper", { "helper.md": AGENT });
  const res = await put(t, "plugin", "release", {
    "plugin.json": JSON.stringify({ name: "Release helper", description: "Notes", includes: [{ kind: "agent", id: "helper" }] }),
    "skills/notes/SKILL.md": SKILL("One"),
    "skills/notes/ref.md": "reference",
    "mcp/publish.json": JSON.stringify({ type: "http", url: "https://x.test/mcp" }),
    ...extra,
  });
  assert.equal(res.status, 201, await res.clone().text());
}

test("plugins: save, list and detail like any asset; bad plugins are refused", async () => {
  const { t } = await setup();
  try {
    await releasePlugin(t);
    const detail = await t.json<AssetDetail>("/api/library/plugin/release");
    assert.equal(detail.asset.kind, "plugin");
    assert.equal(detail.asset.error, null);
    assert.deepEqual(Object.keys(detail.files).sort(), ["mcp/publish.json", "plugin.json", "skills/notes/ref.md", "skills/notes/SKILL.md"].sort());
    assert.ok((await t.json<{ id: string }[]>("/api/library?kind=plugin")).some((a) => a.id === "release"));
    assert.equal((await put(t, "plugin", "bad", { "plugin.json": JSON.stringify({ includes: [{ kind: "plugin", id: "x" }] }) })).status, 400);
    assert.equal((await put(t, "plugin", "bad", { "readme.txt": "x" })).status, 400);
  } finally {
    await t.close();
  }
});

test("plugins: install writes own and included members, lists one plugin installation, forget removes them", async () => {
  const { t, path } = await setup();
  try {
    await releasePlugin(t);
    const result = await actJson(t, "proj", { kind: "plugin", id: "release", action: "install" });
    assert.deepEqual([...result.changed].sort(), [".claude/agents/helper.md", ".claude/skills/notes/SKILL.md", ".claude/skills/notes/ref.md", ".mcp.json"].sort());
    assert.equal(readFileSync(join(path, ".claude/skills/notes/SKILL.md"), "utf8"), SKILL("One"));
    assert.equal(JSON.parse(readFileSync(join(path, ".mcp.json"), "utf8")).mcpServers.publish.url, "https://x.test/mcp");

    const inst = result.installation!;
    assert.deepEqual([inst.kind, inst.id, inst.state], ["plugin", "release", "current"]);
    assert.deepEqual(inst.members!.map((m) => [m.kind, m.id, m.origin, m.state]), [["skill", "notes", "own", "current"], ["mcp", "publish", "own", "current"], ["agent", "helper", "library", "current"]]);

    // Own members don't show up as separate installations; the included library agent does, as it always could.
    const list = await t.json<Installation[]>("/api/projects/proj/library");
    assert.deepEqual(list.map((i) => `${i.kind}/${i.id}`).sort(), ["agent/helper", "plugin/release"]);

    const forgot = await actJson(t, "proj", { kind: "plugin", id: "release", action: "forget" });
    assert.equal(forgot.installation, null);
    // Copy files stay on forget, like any library install; Odin's merged .mcp.json entry goes.
    assert.ok(existsSync(join(path, ".claude/skills/notes/SKILL.md")), "copied files stay");
    assert.equal(JSON.parse(readFileSync(join(path, ".mcp.json"), "utf8")).mcpServers?.publish, undefined);
    assert.deepEqual(await t.json("/api/projects/proj/library"), []);
  } finally {
    await t.close();
  }
});

test("plugins: forget keeps an included member that was installed by hand first, or that another plugin lists", async () => {
  const { t, path } = await setup();
  try {
    await releasePlugin(t);
    await actJson(t, "proj", { kind: "agent", id: "helper", action: "install" }); // by hand, first
    await actJson(t, "proj", { kind: "plugin", id: "release", action: "install" });
    await actJson(t, "proj", { kind: "plugin", id: "release", action: "forget" });
    assert.ok(existsSync(join(path, ".claude/agents/helper.md")), "hand-installed agent stays");
    assert.deepEqual((await t.json<Installation[]>("/api/projects/proj/library")).map((i) => i.id), ["helper"]);

    await actJson(t, "proj", { kind: "agent", id: "helper", action: "forget" });
    await put(t, "plugin", "second", { "plugin.json": JSON.stringify({ includes: [{ kind: "agent", id: "helper" }] }) });
    await actJson(t, "proj", { kind: "plugin", id: "release", action: "install" });
    await actJson(t, "proj", { kind: "plugin", id: "second", action: "install" });
    await actJson(t, "proj", { kind: "plugin", id: "release", action: "forget" });
    assert.ok(existsSync(join(path, ".claude/agents/helper.md")), "another plugin still lists the agent");
    await actJson(t, "proj", { kind: "plugin", id: "second", action: "forget" });
    assert.deepEqual(await t.json("/api/projects/proj/library"), [], "last plugin out leaves no installation");
  } finally {
    await t.close();
  }
});

test("plugins: a conflict stops the whole install before anything is written", async () => {
  const { t, path } = await setup();
  try {
    await releasePlugin(t);
    mkdirSync(join(path, ".claude/skills/notes"), { recursive: true });
    writeFileSync(join(path, ".claude/skills/notes/SKILL.md"), "mine");
    const res = await act(t, "proj", { kind: "plugin", id: "release", action: "install" });
    assert.equal(res.status, 409);
    assert.match(await errorOf(res), /already exists/);
    assert.equal(existsSync(join(path, ".claude/agents/helper.md")), false, "nothing else was written");
    assert.equal(existsSync(join(path, ".mcp.json")), false);
    const forced = await actJson(t, "proj", { kind: "plugin", id: "release", action: "install", force: true });
    assert.equal(readFileSync(join(path, ".claude/skills/notes/SKILL.md"), "utf8"), SKILL("One"));
    assert.equal(forced.installation!.state, "current");
  } finally {
    await t.close();
  }
});

test("plugins: an own member cannot take over an id a library asset already installed", async () => {
  const { t } = await setup();
  try {
    await releasePlugin(t);
    await put(t, "skill", "notes", { "SKILL.md": SKILL("library") });
    await actJson(t, "proj", { kind: "skill", id: "notes", action: "install" });
    const res = await act(t, "proj", { kind: "plugin", id: "release", action: "install", force: true });
    assert.equal(res.status, 409);
    assert.match(await errorOf(res), /already installed from library skill notes/);
  } finally {
    await t.close();
  }
});

test("plugins: drift rolls up members; editing the plugin offers an update; update adds and drops members", async () => {
  const { t, path } = await setup();
  try {
    await releasePlugin(t);
    await actJson(t, "proj", { kind: "plugin", id: "release", action: "install" });

    // A hand edit of an own file → modified.
    writeFileSync(join(path, ".claude/skills/notes/SKILL.md"), "edited");
    let inst = (await t.json<Installation[]>("/api/projects/proj/library")).find((i) => i.kind === "plugin")!;
    assert.equal(inst.state, "modified");
    const refused = await act(t, "proj", { kind: "plugin", id: "release", action: "update" });
    assert.equal(refused.status, 409);
    await actJson(t, "proj", { kind: "plugin", id: "release", action: "update", force: true });

    // The library moves on: one member changes, one is dropped, a new one appears.
    await put(t, "plugin", "release", {
      "plugin.json": JSON.stringify({ name: "Release helper", description: "Notes", includes: [] }),
      "skills/notes/SKILL.md": SKILL("Two"),
      "agents/reviewer.md": "---\nname: reviewer\ndescription: Reviews\n---\nBody\n",
    });
    inst = (await t.json<Installation[]>("/api/projects/proj/library")).find((i) => i.kind === "plugin")!;
    assert.equal(inst.state, "update-available");
    assert.ok(inst.members!.some((m) => m.id === "reviewer" && m.state === "not-installed"));

    const updated = await actJson(t, "proj", { kind: "plugin", id: "release", action: "update" });
    assert.equal(updated.installation!.state, "current");
    assert.equal(readFileSync(join(path, ".claude/skills/notes/SKILL.md"), "utf8"), SKILL("Two"));
    assert.ok(existsSync(join(path, ".claude/agents/reviewer.md")));
    assert.equal((await t.json<Installation[]>("/api/projects/proj/library")).some((i) => i.id === "helper"), false, "a member the manifest dropped is released");
    assert.equal(existsSync(join(path, ".claude/skills/notes/ref.md")), false, "files the skill no longer has are removed");
    assert.equal(JSON.parse(readFileSync(join(path, ".mcp.json"), "utf8")).mcpServers?.publish, undefined);
  } finally {
    await t.close();
  }
});

test("plugins: a missing included asset blocks install and shows in the preview", async () => {
  const { t } = await setup();
  try {
    await put(t, "plugin", "p", { "plugin.json": JSON.stringify({ includes: [{ kind: "skill", id: "ghost" }] }) });
    const res = await act(t, "proj", { kind: "plugin", id: "p", action: "install" });
    assert.equal(res.status, 409);
    assert.match(await errorOf(res), /skill\/ghost/);
    const pv = (await actJson(t, "proj", { kind: "plugin", id: "p", action: "preview" })).preview!;
    assert.deepEqual(pv.missing, ["skill/ghost"]);
  } finally {
    await t.close();
  }
});

test("plugins: a pinned include installs that version and stays current when the library moves on", async () => {
  const { t, path } = await setup();
  try {
    const v1 = ((await (await put(t, "skill", "notes", { "SKILL.md": SKILL("One") })).json()) as { version: string }).version;
    await put(t, "skill", "notes", { "SKILL.md": SKILL("Two") });
    await put(t, "plugin", "pin", { "plugin.json": JSON.stringify({ includes: [{ kind: "skill", id: "notes", version: v1 }] }) });
    const done = await actJson(t, "proj", { kind: "plugin", id: "pin", action: "install" });
    assert.equal(readFileSync(join(path, ".claude/skills/notes/SKILL.md"), "utf8"), SKILL("One"));
    assert.equal(done.installation!.state, "current");
    await put(t, "skill", "notes", { "SKILL.md": SKILL("Three") });
    assert.equal((await t.json<Installation[]>("/api/projects/proj/library")).find((i) => i.kind === "plugin")!.state, "current");
  } finally {
    await t.close();
  }
});

test("plugins: hooks and local commands need the preview's confirm; remote servers do not", async () => {
  const { t, path } = await setup();
  try {
    const files = {
      "plugin.json": JSON.stringify({ includes: [] }),
      "settings/guard.json": JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo guarded" }] }] } }),
      "mcp/local.json": JSON.stringify({ type: "stdio", command: "npx", args: ["server", "--flag"] }),
      "mcp/remote.json": JSON.stringify({ type: "http", url: "https://x.test/mcp", oauth: {}, headers: { K: "${secret:MY_KEY}" } }),
    };
    await put(t, "plugin", "risky", files);

    const pv = (await actJson(t, "proj", { kind: "plugin", id: "risky", action: "preview" })).preview!;
    assert.deepEqual(pv.runs.map((r) => [r.kind, r.member]), [["command", "mcp/local"], ["remote", "mcp/remote"], ["hook", "settings/guard"]]);
    assert.equal(pv.runs[0]!.text, "npx server --flag");
    assert.deepEqual([pv.secrets, pv.oauth], [[{ name: "MY_KEY", set: false }], ["remote"]]);
    assert.match(pv.confirm!, /^[0-9a-f]{16}$/);
    assert.equal(existsSync(join(path, ".mcp.json")), false, "preview writes nothing");

    const no = await act(t, "proj", { kind: "plugin", id: "risky", action: "install" });
    assert.equal(no.status, 409);
    assert.match(await errorOf(no), /2 hooks or local commands/);
    assert.equal((await act(t, "proj", { kind: "plugin", id: "risky", action: "install", confirm: "0000000000000000" })).status, 409);
    assert.equal(existsSync(join(path, ".mcp.json")), false);

    await actJson(t, "proj", { kind: "plugin", id: "risky", action: "install", confirm: pv.confirm });
    assert.ok(existsSync(join(path, ".claude/settings.json")));

    // An update that changes nothing about what runs needs no new confirmation; one that adds a command does.
    await put(t, "plugin", "risky", { ...files, "mcp/remote.json": JSON.stringify({ type: "http", url: "https://y.test/mcp" }) });
    await actJson(t, "proj", { kind: "plugin", id: "risky", action: "update" });
    await put(t, "plugin", "risky", { ...files, "mcp/extra.json": JSON.stringify({ type: "stdio", command: "other" }) });
    const again = await act(t, "proj", { kind: "plugin", id: "risky", action: "update" });
    assert.equal(again.status, 409);
    assert.match(await errorOf(again), /changed since you confirmed/);
    const pv2 = (await actJson(t, "proj", { kind: "plugin", id: "risky", action: "preview" })).preview!;
    await actJson(t, "proj", { kind: "plugin", id: "risky", action: "update", confirm: pv2.confirm });

    // A plugin with only remote servers installs without one.
    await put(t, "plugin", "calm", { "plugin.json": JSON.stringify({ includes: [] }), "mcp/r.json": JSON.stringify({ type: "http", url: "https://z.test/mcp" }) });
    assert.equal(((await actJson(t, "proj", { kind: "plugin", id: "calm", action: "preview" })).preview as PluginPreview).confirm, null);
    await actJson(t, "proj", { kind: "plugin", id: "calm", action: "install" });
  } finally {
    await t.close();
  }
});

test("plugins: bad requests", async () => {
  const { t } = await setup();
  try {
    await releasePlugin(t);
    assert.equal((await act(t, "proj", { kind: "plugin", id: "release", action: "push" })).status, 400);
    assert.equal((await act(t, "proj", { kind: "plugin", id: "nope", action: "install" })).status, 404);
    assert.equal((await act(t, "proj", { kind: "plugin", id: "release", action: "update" })).status, 404);
    assert.equal((await act(t, "proj", { kind: "agent", id: "helper", action: "preview" })).status, 400);
    assert.equal((await act(t, "proj", { kind: "plugin", id: "release", action: "install", confirm: 5 })).status, 400);
    await actJson(t, "proj", { kind: "plugin", id: "release", action: "install" });
    assert.equal((await act(t, "proj", { kind: "plugin", id: "release", action: "install" })).status, 409);
    assert.equal((await t.api("/api/projects/proj/library/plugin/release/files")).status, 400);
  } finally {
    await t.close();
  }
});
