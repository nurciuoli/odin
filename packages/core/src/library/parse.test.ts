import { test } from "node:test";
import assert from "node:assert/strict";
import { filesError, parseAsset, pathError, promptBody } from "./parse.ts";
import { addSettings, deepEqual, mcpEntry, parseJsonObject, presentSettings, removeMcpEntry, removeSettings, setMcpEntry } from "./merge.ts";

const AGENT = "---\nname: Reviewer\ndescription: Reviews diffs.\ntools: Read, Grep\nmodel: sonnet\n---\n\nYou review.\n";

test("agents parse through agents/parse.ts and report errors", () => {
  const a = parseAsset("agent", "reviewer", { "reviewer.md": AGENT });
  assert.deepEqual(a, { name: "Reviewer", description: "Reviews diffs.", meta: { model: "sonnet", tools: ["Read", "Grep"] }, error: null });
  const bad = parseAsset("agent", "reviewer", { "reviewer.md": "no frontmatter here" });
  assert.match(bad.error!, /no frontmatter/);
});

test("skills need SKILL.md with frontmatter and a description; other files ride along", () => {
  const ok = parseAsset("skill", "pdf", { "SKILL.md": "---\nname: pdf\ndescription: Reads PDFs.\n---\nUse it.\n", "scripts/run.py": "print(1)\n" });
  assert.equal(ok.error, null);
  assert.equal(ok.description, "Reads PDFs.");
  assert.match(parseAsset("skill", "pdf", { "SKILL.md": "---\nname: pdf\n---\n" }).error!, /needs a description/);
  assert.match(parseAsset("skill", "pdf", { "SKILL.md": "plain" }).error!, /no frontmatter/);
  assert.match(parseAsset("skill", "pdf", { "x.md": "plain" }).error!, /missing SKILL.md/);
});

test("commands and prompts: frontmatter optional; prompts list their {{variables}}", () => {
  const c = parseAsset("command", "ship", { "ship.md": "---\ndescription: Ship it\nargument-hint: <pr>\n---\nShip $ARGUMENTS\n" });
  assert.deepEqual(c, { name: "ship", description: "Ship it", meta: { argumentHint: "<pr>", model: null }, error: null });
  assert.equal(parseAsset("command", "plain", { "plain.md": "Just do it.\n" }).error, null);

  const p = parseAsset("prompt", "fix", { "fix.md": "---\nname: Fix item\n---\nFix #{{item.number}} in {{ project }}: {{item.title}} ({{project}})\n" });
  assert.equal(p.name, "Fix item");
  assert.deepEqual(p.meta, { variables: ["item.number", "project", "item.title"] });
  assert.deepEqual(parseAsset("prompt", "bare", { "bare.md": "Hello {{who}}" }).meta, { variables: ["who"] });
  assert.equal(promptBody("---\nname: x\n---\nBody {{a}}\n"), "Body {{a}}\n");
  assert.equal(promptBody("Body"), "Body");
  const broken = parseAsset("prompt", "broken", { "broken.md": "---\nname: [a, b\n---\nx" });
  assert.ok(broken.error);
});

test("templates validate into a full TemplateSpec with clear errors", () => {
  const t = parseAsset("template", "fix", { "fix.json": JSON.stringify({ name: "Fix", description: "Fix an item", promptId: "fix", agent: "library:builder", worktree: true, mcp: ["gh", "gh"], tags: ["bug"] }) });
  assert.equal(t.error, null);
  assert.equal(t.name, "Fix");
  assert.deepEqual(t.meta, { prompt: "", promptId: "fix", model: null, permissionMode: null, agent: "library:builder", worktree: true, mcp: ["gh"], tags: ["bug"] });

  const bad = parseAsset("template", "bad", { "bad.json": JSON.stringify({ permissionMode: "yolo", worktree: "yes", mcp: "gh", promptID: "x" }) });
  assert.match(bad.error!, /unknown field promptID/);
  assert.match(bad.error!, /permissionMode must be one of/);
  assert.match(bad.error!, /worktree must be true or false/);
  assert.match(bad.error!, /mcp must be a list/);
  assert.match(parseAsset("template", "x", { "x.json": "{ nope" }).error!, /not valid JSON/);
  assert.match(parseAsset("template", "x", { "x.json": "[1]" }).error!, /JSON object/);
});

test("mcp specs: stdio, http, sse; a bare command means stdio", () => {
  assert.deepEqual(parseAsset("mcp", "gh", { "gh.json": JSON.stringify({ name: "GitHub", command: "gh-mcp", args: ["--x"] }) }).meta, { type: "stdio", command: "gh-mcp", args: ["--x"] });
  const http = parseAsset("mcp", "docs", { "docs.json": JSON.stringify({ type: "http", url: "https://example.test/mcp", headers: { a: "b" } }) });
  assert.equal(http.error, null);
  assert.deepEqual(http.meta, { type: "http", url: "https://example.test/mcp", headers: { a: "b" } });
  assert.match(parseAsset("mcp", "x", { "x.json": JSON.stringify({ type: "stdio" }) }).error!, /needs a command/);
  assert.match(parseAsset("mcp", "x", { "x.json": JSON.stringify({ type: "sse", url: "ftp://x" }) }).error!, /http\(s\) url/);
  assert.match(parseAsset("mcp", "x", { "x.json": JSON.stringify({}) }).error!, /needs a type/);
  assert.match(parseAsset("mcp", "x", { "x.json": JSON.stringify({ command: "a", env: { A: 1 } }) }).error!, /env must map/);
});

test("settings profiles: permission lists and hook entries", () => {
  const s = parseAsset("settings", "safe", { "safe.json": JSON.stringify({ name: "Safe", permissions: { allow: ["Bash(ls:*)"], deny: ["Bash(rm:*)"] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] } }) });
  assert.equal(s.error, null);
  assert.deepEqual(s.meta.permissions, { allow: ["Bash(ls:*)"], deny: ["Bash(rm:*)"] });
  assert.match(parseAsset("settings", "x", { "x.json": JSON.stringify({ permissions: { allow: "Bash" } }) }).error!, /permissions.allow must be a list/);
  assert.match(parseAsset("settings", "x", { "x.json": JSON.stringify({ hooks: { Stop: [{ command: "x" }] } }) }).error!, /hooks.Stop must be a list/);
  assert.match(parseAsset("settings", "x", { "x.json": JSON.stringify({ env: {} }) }).error!, /unknown field env/);
});

test("file keys: no absolute paths, no .., at most 64 files of 1 MB, layout per kind", () => {
  assert.equal(pathError("a/b.md"), null);
  for (const bad of ["/etc/passwd", "../x", "a/../b", "a//b", "./a", "C:/x", "a\\b", "a\u0000b", ""]) assert.ok(pathError(bad), bad);
  assert.equal(filesError("agent", "r", { "r.md": "x" }), null);
  assert.match(filesError("agent", "r", { "other.md": "x" })!, /one file named r.md/);
  assert.match(filesError("agent", "r", { "r.md": "x", "s.md": "y" })!, /one file/);
  assert.match(filesError("skill", "s", { "a.md": "x" })!, /needs SKILL.md/);
  assert.match(filesError("skill", "s", { "SKILL.md": "x", "../evil": "y" })!, /invalid file path/);
  assert.match(filesError("skill", "s", { "SKILL.md": "x", "/abs": "y" })!, /absolute/);
  const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`f${i}.md`, "x"]));
  assert.match(filesError("skill", "s", { ...many, "SKILL.md": "x" })!, /too many files/);
  assert.match(filesError("skill", "s", { "SKILL.md": "x".repeat(1024 * 1024 + 1) })!, /larger than 1 MB/);
  assert.match(filesError("agent", "r", {})!, /at least one file/);
  assert.match(filesError("agent", "r", { "r.md": 3 })!, /must be text/);
  assert.match(filesError("agent", "r", null)!, /object/);
});

test("mcp merge keeps the rest of .mcp.json", () => {
  const doc = { mcpServers: { mine: { command: "x" } }, other: true };
  const next = setMcpEntry(doc, "gh", { type: "stdio", command: "gh" });
  assert.deepEqual(next, { mcpServers: { mine: { command: "x" }, gh: { type: "stdio", command: "gh" } }, other: true });
  assert.deepEqual(doc.mcpServers, { mine: { command: "x" } }, "input untouched");
  assert.deepEqual(mcpEntry(next, "gh"), { type: "stdio", command: "gh" });
  assert.deepEqual(removeMcpEntry(next, "gh"), doc);
  assert.deepEqual(setMcpEntry(null, "a", { command: "b" }), { mcpServers: { a: { command: "b" } } });
  assert.throws(() => mcpEntry({ mcpServers: [] }, "a"), /must be an object/);
  assert.throws(() => parseJsonObject("{", ".mcp.json"), /not valid JSON/);
  assert.equal(parseJsonObject(null, "x"), null);
});

test("settings merge: rules deduped, hooks added, removal leaves the user's own entries", () => {
  const hook = { matcher: "Bash", hooks: [{ type: "command", command: "lint" }] };
  const userHook = { matcher: "Edit", hooks: [{ type: "command", command: "fmt" }] };
  const doc = { model: "opus", permissions: { allow: ["Read", "Bash(ls:*)"] }, hooks: { PreToolUse: [userHook] } };
  const spec = { permissions: { allow: ["Bash(ls:*)", "Bash(git status)"], deny: ["Bash(rm:*)"] }, hooks: { PreToolUse: [hook], Stop: [hook] } };
  const { doc: merged, added } = addSettings(doc, spec);
  assert.deepEqual(merged, {
    model: "opus",
    permissions: { allow: ["Read", "Bash(ls:*)", "Bash(git status)"], deny: ["Bash(rm:*)"] },
    hooks: { PreToolUse: [userHook, hook], Stop: [hook] },
  });
  assert.deepEqual(added, { permissions: { allow: ["Bash(git status)"], deny: ["Bash(rm:*)"] }, hooks: { PreToolUse: [hook], Stop: [hook] } });
  // Adding again changes nothing.
  assert.deepEqual(addSettings(merged, spec).added, {});
  assert.deepEqual(presentSettings(merged, spec), spec);
  const removed = removeSettings(merged, added);
  assert.equal(removed.changed, true);
  assert.deepEqual(removed.doc, doc);
  assert.ok(deepEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 }));
  assert.ok(!deepEqual({ a: 1 }, { a: 1, b: 2 }));
});
