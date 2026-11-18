import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExportResult, ImportPreview, LibraryAsset } from "@odin/shared/api";
import { startApp } from "../test-helpers.ts";
import { convertClaudePlugin, exportClaudePlugin } from "./plugin-io.ts";
import { gitSourceError } from "./plugin-source.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "odin-plugin-io-")));
after(() => rmSync(root, { recursive: true, force: true }));

const SKILL = "---\nname: notes\ndescription: Notes\n---\nDo it.\n";
const CLAUDE: Record<string, string> = {
  ".claude-plugin/plugin.json": JSON.stringify({ name: "Release Helper", description: "Ships releases", version: "2.0.1" }),
  "skills/notes/SKILL.md": SKILL,
  "skills/notes/ref.md": "reference",
  "agents/reviewer.md": "---\nname: reviewer\ndescription: Reviews\n---\nBody\n",
  "commands/ship.md": "---\ndescription: Ship it\n---\nRun the release.\n",
  "commands/notes.md": "Plain command without frontmatter",
  "hooks/hooks.json": JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/guard.sh" }] }] } }),
  ".mcp.json": JSON.stringify({ mcpServers: { local: { command: "npx", args: ["srv"], env: { TOKEN: "${secret:TOK}", HOME2: "${HOME}" } }, remote: { type: "http", url: "https://x.test/mcp" } } }),
  "README.md": "# Hi",
  "scripts/guard.sh": "#!/bin/sh\n",
};

test("convert: maps skills, agents, commands, hooks and MCP servers into own members and warns about the rest", () => {
  const c = convertClaudePlugin(CLAUDE, { fallbackName: "x", git: { url: "https://git.test/r.git", rev: "main" } });
  assert.deepEqual([c.id, c.name, c.version], ["release-helper", "Release Helper", "2.0.1"]);
  assert.deepEqual(Object.keys(c.files).sort(), [
    "README.md", "agents/reviewer.md", "mcp/local.json", "mcp/remote.json", "plugin.json", "settings/hooks.json",
    "skills/command-notes/SKILL.md", "skills/notes/SKILL.md", "skills/notes/ref.md", "skills/ship/SKILL.md",
  ]);
  assert.deepEqual(JSON.parse(c.files["plugin.json"]!).source, { type: "git", url: "https://git.test/r.git", rev: "main" });
  assert.match(c.files["skills/ship/SKILL.md"]!, /name: ship\ndescription: "Ship it"\n---\n\nRun the release\./);
  assert.deepEqual(c.runs.map((r) => [r.kind, r.member]), [["command", "mcp/local"], ["remote", "mcp/remote"], ["hook", "settings/hooks"]]);
  assert.deepEqual(c.secrets, ["TOK"]);
  const w = c.warnings.join("\n");
  assert.match(w, /command "notes" became skill "command-notes" because a skill named "notes" exists/);
  assert.match(w, /\$\{CLAUDE_PLUGIN_ROOT\}/);
  assert.match(w, /not imported .*scripts\/guard\.sh/);
  assert.match(w, /environment references/);
});

test("convert: invalid members are skipped with a warning; nothing importable is a 400; bad ids are refused", () => {
  const c = convertClaudePlugin({ "skills/bad/SKILL.md": "no frontmatter", "skills/ok/SKILL.md": SKILL.replace("notes", "ok") }, { fallbackName: "p" });
  assert.deepEqual(c.members, [{ kind: "skill", id: "ok" }]);
  assert.match(c.warnings.join("\n"), /skill "bad" was skipped/);
  assert.throws(() => convertClaudePlugin({ "README.md": "x" }, { fallbackName: "p" }), /nothing|no skills/);
  assert.throws(() => convertClaudePlugin({ "skills/ok/SKILL.md": SKILL }, { fallbackName: "p", id: "Bad Id" }), /usable plugin id/);
});

test("export: Claude Code layout, secrets stay placeholders, OAuth dropped, unportable members skipped", () => {
  const out = exportClaudePlugin({ id: "rel", name: "Rel", description: "D", version: "1.0.0" }, [
    { kind: "skill", id: "notes", files: { "SKILL.md": SKILL, "ref.md": "r" }, meta: {} },
    { kind: "agent", id: "reviewer", files: { "reviewer.md": "agent" }, meta: {} },
    { kind: "mcp", id: "remote", files: {}, meta: { type: "http", url: "https://x.test/mcp", oauth: {}, headers: { K: "${secret:KEY}" } } },
    { kind: "settings", id: "guard", files: {}, meta: { hooks: { PreToolUse: [{ matcher: "Bash" }] } } },
    { kind: "settings", id: "perms", files: {}, meta: { permissions: { allow: ["Bash(ls)"] } } },
    { kind: "instruction", id: "style", files: {}, meta: {} },
  ]);
  assert.deepEqual(Object.keys(out.files).sort(), [".claude-plugin/plugin.json", ".mcp.json", "agents/reviewer.md", "hooks/hooks.json", "skills/notes/SKILL.md", "skills/notes/ref.md"]);
  assert.deepEqual(JSON.parse(out.files[".claude-plugin/plugin.json"]!), { name: "rel", description: "D", version: "1.0.0" });
  const mcp = JSON.parse(out.files[".mcp.json"]!).mcpServers.remote;
  assert.equal(mcp.oauth, undefined);
  assert.equal(mcp.headers.K, "${secret:KEY}");
  assert.deepEqual(out.skipped.map((s) => `${s.kind}/${s.id}`), ["settings/perms", "instruction/style"]);
  assert.ok(out.notes.some((n) => /OAuth/.test(n)) && out.notes.some((n) => n.includes("${secret:KEY}")));
});

test("git sources: only https, ssh and git@ addresses and plain ref names", () => {
  assert.equal(gitSourceError("https://github.com/a/b.git", "v1.2"), null);
  assert.equal(gitSourceError("git@github.com:a/b.git"), null);
  assert.ok(gitSourceError("file:///etc"));
  assert.ok(gitSourceError("--upload-pack=x"));
  assert.ok(gitSourceError("https://a.test/r", "--evil"));
  assert.ok(gitSourceError("https://a.test/r", "a..b"));
});

function writeTree(dir: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
}

test("routes: import previews first, writes only when confirmed, then installs and exports", async () => {
  const t = await startApp();
  try {
    const src = join(root, "src-plugin");
    writeTree(src, CLAUDE);
    symlinkSync("/etc/passwd", join(src, "link.txt"));

    const bad = await t.api("/api/library/import", { method: "POST", body: JSON.stringify({ source: { type: "git", url: "file:///x" } }) });
    assert.equal(bad.status, 400);
    assert.equal((await t.api("/api/library/import", { method: "POST", body: JSON.stringify({ source: { type: "local", path: "relative" } }) })).status, 400);

    const pv = await t.json<ImportPreview>("/api/library/import", { method: "POST", body: JSON.stringify({ source: { type: "local", path: src } }) });
    assert.equal(pv.id, "release-helper");
    assert.ok(pv.runs.some((r) => r.kind === "hook"));
    assert.ok(pv.warnings.some((w) => /link\.txt/.test(w)));
    assert.deepEqual((await t.json<LibraryAsset[]>("/api/library?kind=plugin")), [], "preview writes nothing");

    const done = await t.api(`/api/library/import/${pv.previewId}`, { method: "POST" });
    assert.equal(done.status, 201);
    assert.equal(((await done.json()) as LibraryAsset).error, null);
    assert.equal((await t.api(`/api/library/import/${pv.previewId}`, { method: "POST" })).status, 404, "a preview is single use");
    const again = await t.api("/api/library/import", { method: "POST", body: JSON.stringify({ source: { type: "local", path: src } }) });
    assert.equal(again.status, 409);

    const dest = join(root, "exported");
    const ex = await t.json<ExportResult>("/api/library/plugin/release-helper/export", { method: "POST", body: JSON.stringify({ path: dest }) });
    assert.ok(ex.files.includes(".claude-plugin/plugin.json") && ex.files.includes("hooks/hooks.json"));
    assert.equal(JSON.parse(readFileSync(join(dest, ".mcp.json"), "utf8")).mcpServers.local.env.TOKEN, "${secret:TOK}");
    assert.ok(existsSync(join(dest, "skills/notes/ref.md")));
    assert.equal((await t.api("/api/library/plugin/release-helper/export", { method: "POST", body: JSON.stringify({ path: dest }) })).status, 409, "not into a full folder");
    assert.equal((await t.api("/api/library/plugin/ghost/export", { method: "POST", body: JSON.stringify({ path: join(root, "g") }) })).status, 404);
  } finally {
    await t.close();
  }
});
