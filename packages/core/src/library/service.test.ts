import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AssetKind, InstallRequest } from "@odin/shared/api";
import { filesHash } from "../hash.ts";
import { HttpError } from "../http/util.ts";
import type { ProjectRef, ProjectsService } from "../services.ts";
import { FIXED_NOW, stubServices, tempConfig, testDeps, tempDir, removeTempDir } from "../test-helpers.ts";
import { createLibraryService } from "./service.ts";

const root = tempDir("odin-library-");
after(() => removeTempDir(root));
let counter = 0;

const AGENT = (desc = "Reviews diffs.") => `---\nname: reviewer\ndescription: ${desc}\ntools: Read, Grep\n---\n\nYou review.\n`;
const SKILL = "---\nname: pdf\ndescription: Reads PDFs.\n---\nUse scripts/run.py.\n";

function write(base: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(base, rel)), { recursive: true });
    writeFileSync(join(base, rel), content);
  }
}

function setup(opts: { seed?: Record<string, string>; library?: Record<string, string> } = {}) {
  const n = ++counter;
  const seedDir = join(root, `seed${n}`);
  mkdirSync(seedDir, { recursive: true });
  write(seedDir, opts.seed ?? { "agents/reviewer.md": AGENT() });
  const config = tempConfig({ librarySeedDir: seedDir });
  if (opts.library) {
    mkdirSync(config.libraryDir, { recursive: true });
    write(config.libraryDir, opts.library);
  }
  const deps = testDeps({ config });
  const projectPath = join(root, `project${n}`);
  mkdirSync(projectPath, { recursive: true });
  const ref: ProjectRef = { name: "app", path: projectPath, settings: { title: "app", description: "", repo: null, defaultBranch: "main", commands: {} }, manifestError: null, missing: false };
  const written: string[][] = [];
  const projects = {
    get: (name: string) => (name === "app" ? ref : null),
    noteWritten: (_name: string, paths: string[]) => written.push(paths),
  } as unknown as ProjectsService;
  deps.db.prepare("INSERT INTO projects (name, path, created_at, updated_at) VALUES (?, ?, ?, ?)").run("app", projectPath, FIXED_NOW.toISOString(), FIXED_NOW.toISOString());
  const lib = createLibraryService(deps, stubServices({ projects }));
  after(() => lib.close());
  const install = (req: Omit<InstallRequest, "action"> & { action?: InstallRequest["action"] }) => lib.install("app", { action: "install", ...req });
  const proj = (rel: string) => join(projectPath, rel);
  const versionRows = (kind: AssetKind, id: string) =>
    (deps.db.prepare("SELECT COUNT(*) AS n FROM library_versions WHERE kind = ? AND asset_id = ?").get(kind, id) as { n: number }).n;
  return { deps, lib, config, ref, projectPath, written, install, proj, versionRows };
}

async function status(p: Promise<unknown> | (() => unknown)): Promise<number> {
  try {
    await (typeof p === "function" ? p() : p);
    return 0;
  } catch (e) {
    return e instanceof HttpError ? e.status : -1;
  }
}

describe("seeding and scanning", () => {
  test("an absent library is seeded from librarySeedDir", () => {
    const { lib, config } = setup();
    assert.ok(existsSync(join(config.libraryDir, "agents/reviewer.md")));
    assert.deepEqual(lib.list().map((a) => `${a.kind}/${a.id}`), ["agent/reviewer"]);
    assert.equal(lib.root, config.libraryDir);
  });

  test("an existing library is never re-seeded", () => {
    const { lib, config } = setup({ library: { "prompts/mine.md": "Hi {{who}}\n" } });
    assert.ok(!existsSync(join(config.libraryDir, "agents/reviewer.md")));
    assert.deepEqual(lib.list().map((a) => `${a.kind}/${a.id}`), ["skill/mine"]);
  });

  test("the repo's own templates/library seeds without errors", () => {
    const deps = testDeps();
    const lib = createLibraryService(deps, stubServices({}));
    const assets = lib.list();
    assert.ok(assets.length > 0);
    for (const a of assets) assert.equal(a.error, null, `${a.kind}/${a.id}: ${a.error}`);
    lib.close();
  });

  test("every kind is read from its layout; junk, dotfiles, bad ids and symlinks are skipped", () => {
    const outside = join(root, `outside${counter}.md`);
    writeFileSync(outside, AGENT());
    const { lib, config } = setup({
      library: {
        "agents/reviewer.md": AGENT(),
        "agents/README.txt": "not an agent",
        "agents/.hidden.md": AGENT(),
        "agents/Bad_Id.md": AGENT(),
        "skills/pdf/SKILL.md": SKILL,
        "skills/pdf/scripts/run.py": "print(1)\n",
        "skills/pdf/.DS_Store": "junk",
        "commands/ship.md": "Ship it.\n",
        "prompts/fix.md": "Fix {{item.title}}\n",
        "templates/fix.json": JSON.stringify({ name: "Fix", promptId: "fix" }),
        "mcp/gh.json": JSON.stringify({ name: "GitHub", type: "stdio", command: "gh-mcp" }),
        "settings/safe.json": JSON.stringify({ permissions: { allow: ["Read"] } }),
      },
    });
    symlinkSync(outside, join(config.libraryDir, "agents/linked.md"));
    lib.rescan();
    assert.deepEqual(lib.list().map((a) => `${a.kind}/${a.id}`), ["agent/reviewer", "mcp/gh", "settings/safe", "skill/fix", "skill/pdf", "skill/ship", "skill/template-fix"]);
    const skill = lib.get("skill", "pdf")!;
    assert.deepEqual(skill.files, ["SKILL.md", "scripts/run.py"]);
    assert.equal(skill.version, filesHash({ "SKILL.md": SKILL, "scripts/run.py": "print(1)\n" }));
    assert.equal(lib.get("agent", "reviewer")!.version, filesHash({ "reviewer.md": AGENT() }));
    assert.deepEqual(lib.list("mcp").map((a) => a.name), ["GitHub"]);
  });

  test("broken files are listed with their error", () => {
    const { lib } = setup({ library: { "mcp/bad.json": "{ nope", "skills/empty/notes.md": "x" } });
    assert.match(lib.get("mcp", "bad")!.error!, /not valid JSON/);
    assert.match(lib.get("skill", "empty")!.error!, /missing SKILL.md/);
  });

  test("rescan picks up outside edits, additions and deletions, and emits library.updated", () => {
    const { lib, config, deps, versionRows } = setup();
    const before = lib.get("agent", "reviewer")!.version;
    deps.events.length = 0;
    lib.rescan();
    assert.equal(deps.events.length, 0, "nothing changed, nothing emitted");
    writeFileSync(join(config.libraryDir, "agents/reviewer.md"), AGENT("Changed."));
    write(config.libraryDir, { "skills/ship/SKILL.md": SKILL });
    lib.rescan();
    assert.notEqual(lib.get("agent", "reviewer")!.version, before);
    assert.equal(lib.get("agent", "reviewer")!.description, "Changed.");
    assert.ok(lib.get("skill", "ship"));
    assert.equal(versionRows("agent", "reviewer"), 2);
    assert.deepEqual(deps.events.map((e) => e.type === "library.updated" && `${e.kind}/${e.id}`).sort(), ["agent/reviewer", "skill/ship"]);
    rmSync(join(config.libraryDir, "skills/ship"), { recursive: true });
    lib.rescan();
    assert.equal(lib.get("skill", "ship"), null);
  });

  test("versions are recorded once per content", () => {
    const { lib, config, versionRows } = setup();
    lib.rescan();
    lib.rescan();
    assert.equal(versionRows("agent", "reviewer"), 1);
    // Whitespace-only differences normalise to the same version.
    writeFileSync(join(config.libraryDir, "agents/reviewer.md"), AGENT().replace(/\n/g, "\r\n"));
    lib.rescan();
    assert.equal(versionRows("agent", "reviewer"), 1);
    lib.save("agent", "reviewer", { "reviewer.md": AGENT("v2") });
    lib.save("agent", "reviewer", { "reviewer.md": AGENT("v2") });
    lib.rescan();
    assert.equal(versionRows("agent", "reviewer"), 2);
    const d = lib.detail("agent", "reviewer")!;
    assert.equal(d.versions.length, 2);
    assert.equal(d.files["reviewer.md"], AGENT("v2"));
  });
});

describe("save and remove", () => {
  test("save creates and replaces atomically, records the version and emits library.updated", () => {
    const { lib, config, deps } = setup();
    const created = lib.save("instruction", "global", { "AGENTS.md": "Work carefully.\n" });
    assert.equal(created.name, "Global AGENTS.md");
    assert.ok(deps.events.some(e => e.type === "library.updated" && e.kind === "instruction"));
    assert.equal(readFileSync(join(config.libraryDir, "instructions/global/AGENTS.md"), "utf8"), "Work carefully.\n");

    lib.save("skill", "pdf", { "SKILL.md": SKILL, "old.md": "old", "deep/a.txt": "a" });
    const v2 = lib.save("skill", "pdf", { "SKILL.md": SKILL, "new.md": "new" });
    assert.deepEqual(v2.files, ["SKILL.md", "new.md"]);
    assert.deepEqual(readdirSync(join(config.libraryDir, "skills")), ["pdf"], "no temp dirs left behind");
    assert.deepEqual(readdirSync(join(config.libraryDir, "skills/pdf")).sort(), ["SKILL.md", "new.md"]);
    const old = lib.detail("skill", "pdf")!.versions.at(-1)!.version;
    assert.deepEqual(lib.files("skill", "pdf", old), { "SKILL.md": SKILL, "old.md": "old", "deep/a.txt": "a" });
    assert.equal(lib.files("skill", "pdf", "nope"), null);
    // A rescan agrees with what save reported.
    lib.rescan();
    assert.equal(lib.get("skill", "pdf")!.version, v2.version);
  });

  test("save refuses bad ids, kinds, layouts, unsafe paths and parse errors", async () => {
    const { lib, config } = setup();
    assert.equal(await status(() => lib.save("agent", "Bad Id", { "Bad Id.md": AGENT() })), 400);
    assert.equal(await status(() => lib.save("widget" as AssetKind, "x", { "x.md": "" })), 400);
    assert.equal(await status(() => lib.save("agent", "x", { "y.md": AGENT() })), 400);
    assert.equal(await status(() => lib.save("skill", "x", { "SKILL.md": SKILL, "../escape.md": "x" })), 400);
    assert.equal(await status(() => lib.save("skill", "x", { "SKILL.md": SKILL, "/etc/x": "x" })), 400);
    assert.equal(await status(() => lib.save("mcp", "x", { "x.json": "{}" })), 400);
    assert.equal(await status(() => lib.save("agent", "x", { "x.md": "no frontmatter" })), 400);
    assert.ok(!existsSync(join(root, "escape.md")));
    assert.ok(!existsSync(join(config.libraryDir, "skills/x")));
  });

  test("remove deletes the files and the asset; unknown is 404", async () => {
    const { lib, config, deps } = setup();
    lib.save("skill", "pdf", { "SKILL.md": SKILL });
    lib.remove("skill", "pdf");
    lib.remove("agent", "reviewer");
    assert.ok(!existsSync(join(config.libraryDir, "skills/pdf")));
    assert.ok(!existsSync(join(config.libraryDir, "agents/reviewer.md")));
    assert.equal(lib.get("skill", "pdf"), null);
    assert.equal(lib.detail("agent", "reviewer"), null);
    assert.ok(deps.events.some((e) => e.type === "library.updated" && e.kind === "agent"));
    assert.equal(await status(() => lib.remove("agent", "reviewer")), 404);
  });

  test("historical agent version counts remain available", () => {
    const { lib, deps } = setup();
    const v1 = lib.get("agent", "reviewer")!.version;
    const insert = deps.db.prepare(
      "INSERT INTO sessions (id, harness, project, title, origin, state, cwd, agent_version, template_id, created_at, updated_at, metrics) VALUES (?, 'claude', 'app', 't', 'odin', 'idle', '/x', ?, ?, ?, ?, '{}')",
    );
    insert.run("s1", v1, "fix", FIXED_NOW.toISOString(), FIXED_NOW.toISOString());
    insert.run("s2", v1, null, FIXED_NOW.toISOString(), FIXED_NOW.toISOString());
    assert.equal(lib.detail("agent", "reviewer")!.versions[0]!.sessionCount, 2);
    lib.save("agent", "reviewer", { "reviewer.md": AGENT("v2") });
    const versions = lib.detail("agent", "reviewer")!.versions;
    assert.deepEqual(versions.map((v) => [v.version === v1, v.sessionCount]).sort(), [[false, 0], [true, 2]]);
  });
});

describe("copy installs", () => {
  test("agent, command and skill are copied into .claude/ and reported through noteWritten", async () => {
    const { lib, install, proj, written, deps } = setup();
    lib.save("skill", "ship", { "SKILL.md": SKILL });
    lib.save("skill", "pdf", { "SKILL.md": SKILL, "scripts/run.py": "print(1)\n" });
    deps.events.length = 0;

    const a = await install({ kind: "agent", id: "reviewer" });
    assert.deepEqual(a.changed, [".claude/agents/reviewer.md"]);
    assert.equal(readFileSync(proj(".claude/agents/reviewer.md"), "utf8"), AGENT());
    assert.equal(a.installation!.state, "current");
    assert.equal(a.installation!.projectVersion, lib.get("agent", "reviewer")!.version);

    const c = await install({ kind: "skill", id: "ship" });
    assert.deepEqual(c.installation!.paths, [".claude/skills/ship/SKILL.md"]);

    const s = await install({ kind: "skill", id: "pdf" });
    assert.deepEqual(s.changed, [".claude/skills/pdf/SKILL.md", ".claude/skills/pdf/scripts/run.py"]);
    assert.equal(readFileSync(proj(".claude/skills/pdf/scripts/run.py"), "utf8"), "print(1)\n");
    assert.equal(s.installation!.state, "current");

    assert.deepEqual(written, [[".claude/agents/reviewer.md"], [".claude/skills/ship/SKILL.md"], [".claude/skills/pdf/SKILL.md", ".claude/skills/pdf/scripts/run.py"]]);
    assert.equal(deps.events.filter((e) => e.type === "install.updated").length, 3);
    assert.deepEqual(lib.installations("app").map((i) => `${i.kind}/${i.id}:${i.state}`), ["agent/reviewer:current", "skill/pdf:current", "skill/ship:current"]);
    assert.deepEqual(lib.detail("agent", "reviewer")!.installs.map((i) => i.project), ["app"]);
    assert.deepEqual(lib.projectFiles("app", "skill", "pdf"), { "SKILL.md": SKILL, "scripts/run.py": "print(1)\n" });
  });

  test("each drift state", async () => {
    const { lib, install, proj } = setup();
    await install({ kind: "agent", id: "reviewer" });
    const state = () => lib.installations("app")[0]!.state;
    assert.equal(state(), "current");

    lib.save("agent", "reviewer", { "reviewer.md": AGENT("Library moved on.") });
    assert.equal(state(), "update-available");

    writeFileSync(proj(".claude/agents/reviewer.md"), AGENT("Edited in the project."));
    assert.equal(state(), "conflict");

    lib.save("agent", "reviewer", { "reviewer.md": AGENT() }); // library back to the installed version
    assert.equal(state(), "modified");

    writeFileSync(proj(".claude/agents/reviewer.md"), AGENT());
    assert.equal(state(), "current");

    rmSync(proj(".claude/agents/reviewer.md"));
    const missing = lib.installations("app")[0]!;
    assert.equal(missing.state, "missing");
    assert.equal(missing.projectVersion, null);
    assert.equal(lib.projectFiles("app", "agent", "reviewer"), null);
  });

  test("install over an untracked file is 409 unless force; identical content is adopted", async () => {
    const { lib, install, proj } = setup();
    write(proj(""), { ".claude/agents/reviewer.md": AGENT("Mine.") });
    assert.equal(await status(install({ kind: "agent", id: "reviewer" })), 409);
    assert.equal(readFileSync(proj(".claude/agents/reviewer.md"), "utf8"), AGENT("Mine."));
    const forced = await install({ kind: "agent", id: "reviewer", force: true });
    assert.equal(forced.installation!.state, "current");

    lib.save("skill", "pdf", { "SKILL.md": SKILL });
    write(proj(""), { ".claude/skills/pdf/SKILL.md": SKILL });
    const adopted = await install({ kind: "skill", id: "pdf" });
    assert.equal(adopted.installation!.state, "current");
  });

  test("update over modified/conflict is 409 unless force; update replaces a skill's files", async () => {
    const { lib, install, proj } = setup();
    lib.save("skill", "pdf", { "SKILL.md": SKILL, "old.md": "old" });
    await install({ kind: "skill", id: "pdf" });
    lib.save("skill", "pdf", { "SKILL.md": SKILL, "new.md": "new" });
    assert.equal(lib.installations("app")[0]!.state, "update-available");
    const up = await lib.install("app", { kind: "skill", id: "pdf", action: "update" });
    assert.deepEqual(up.changed.sort(), [".claude/skills/pdf/SKILL.md", ".claude/skills/pdf/new.md", ".claude/skills/pdf/old.md"]);
    assert.ok(!existsSync(proj(".claude/skills/pdf/old.md")));
    assert.equal(up.installation!.state, "current");

    await install({ kind: "agent", id: "reviewer" });
    writeFileSync(proj(".claude/agents/reviewer.md"), AGENT("Local edit."));
    assert.equal(await status(lib.install("app", { kind: "agent", id: "reviewer", action: "update" })), 409);
    lib.save("agent", "reviewer", { "reviewer.md": AGENT("Library edit.") });
    assert.equal(lib.installations("app").find((i) => i.kind === "agent")!.state, "conflict");
    assert.equal(await status(lib.install("app", { kind: "agent", id: "reviewer", action: "update" })), 409);
    const forced = await lib.install("app", { kind: "agent", id: "reviewer", action: "update", force: true });
    assert.equal(forced.installation!.state, "current");
    assert.equal(readFileSync(proj(".claude/agents/reviewer.md"), "utf8"), AGENT("Library edit."));
    assert.equal(await status(lib.install("app", { kind: "skill", id: "nope", action: "update" })), 404);
  });

  test("push saves the project's files as a new library version and makes it the installed one", async () => {
    const { lib, install, proj, versionRows } = setup();
    await install({ kind: "agent", id: "reviewer" });
    writeFileSync(proj(".claude/agents/reviewer.md"), AGENT("Improved in the project."));
    assert.equal(lib.installations("app")[0]!.state, "modified");
    const pushed = await lib.install("app", { kind: "agent", id: "reviewer", action: "push" });
    assert.deepEqual(pushed.changed, []);
    assert.equal(pushed.installation!.state, "current");
    assert.equal(pushed.installation!.installedVersion, lib.get("agent", "reviewer")!.version);
    assert.equal(lib.get("agent", "reviewer")!.description, "Improved in the project.");
    assert.equal(versionRows("agent", "reviewer"), 2);

    // A project-only command can be pushed into the library too.
    write(proj(""), { ".claude/skills/local/SKILL.md": SKILL });
    const fresh = await lib.install("app", { kind: "skill", id: "local", action: "push" });
    assert.equal(fresh.installation!.state, "current");
    assert.ok(lib.get("skill", "local"));
    assert.equal(await status(lib.install("app", { kind: "skill", id: "gone", action: "push" })), 409);
  });

  test("forget drops the row and leaves the files", async () => {
    const { lib, install, proj, deps } = setup();
    await install({ kind: "agent", id: "reviewer" });
    deps.events.length = 0;
    const r = await lib.install("app", { kind: "agent", id: "reviewer", action: "forget" });
    assert.deepEqual(r, { installation: null, changed: [] });
    assert.ok(existsSync(proj(".claude/agents/reviewer.md")));
    assert.deepEqual(lib.installations("app"), []);
    assert.equal(deps.events.filter((e) => e.type === "install.updated").length, 1);
    assert.equal(await status(lib.install("app", { kind: "agent", id: "reviewer", action: "forget" })), 404);
  });

  test("bad requests: prompts/templates aren't installed, unknown project/asset/action, escaping symlinks", async () => {
    const { lib, install, proj } = setup();
    assert.equal(await status(install({ kind: "prompt", id: "p" })), 400);
    assert.equal(await status(install({ kind: "template", id: "t" })), 400);
    assert.equal(await status(install({ kind: "agent", id: "nope" })), 404);
    assert.equal(await status(lib.install("ghost", { kind: "agent", id: "reviewer", action: "install" })), 404);
    assert.equal(await status(lib.install("app", { kind: "agent", id: "reviewer", action: "zap" as "install" })), 400);
    assert.equal(await status(() => lib.installations("ghost")), 404);
    assert.equal(await status(() => lib.projectFiles("app", "prompt", "p")), 400);

    // .claude pointing outside the project: refused, nothing written outside.
    const outside = join(root, `outside-claude${counter}`);
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, proj(".claude"));
    assert.equal(await status(install({ kind: "agent", id: "reviewer" })), 409);
    assert.deepEqual(readdirSync(outside), []);
  });
});

describe("merge installs", () => {
  test("AGENTS.md installation preserves user text, tracks drift and removes only unchanged owned fragments", async () => {
    const { lib, install, proj } = setup();
    const original = "# My instructions\r\n\r\nKeep this text.\r\n";
    writeFileSync(proj("AGENTS.md"), original);
    lib.save("instruction", "checks", { "AGENTS.md": "Run the checks.\n" });
    const first = await install({ kind: "instruction", id: "checks" });
    assert.equal(first.installation!.state, "current");
    assert.ok(readFileSync(proj("AGENTS.md"), "utf8").startsWith(original));
    lib.save("instruction", "checks", { "AGENTS.md": "Run all checks.\n" });
    assert.equal(lib.installations("app")[0]!.state, "update-available");
    await install({ kind: "instruction", id: "checks", action: "update" });
    let text = readFileSync(proj("AGENTS.md"), "utf8");
    assert.ok(text.startsWith(original));
    assert.match(text, /Run all checks/);
    writeFileSync(proj("AGENTS.md"), text.replace("Run all checks.", "Run my own checks."));
    assert.equal(lib.installations("app")[0]!.state, "modified");
    assert.equal(await status(install({ kind: "instruction", id: "checks", action: "update" })), 409);
    await install({ kind: "instruction", id: "checks", action: "push" });
    assert.equal(lib.files("instruction", "checks")!["AGENTS.md"], "Run my own checks.\n");
    await install({ kind: "instruction", id: "checks", action: "forget" });
    text = readFileSync(proj("AGENTS.md"), "utf8");
    assert.ok(text.startsWith(original));
    assert.doesNotMatch(text, /odin:checks|Run my own checks/);
  });

  test("forget preserves edited instructions and malformed markers refuse writes", async () => {
    const { lib, install, proj } = setup();
    lib.save("instruction", "checks", { "AGENTS.md": "Run checks.\n" });
    await install({ kind: "instruction", id: "checks" });
    const edited = readFileSync(proj("AGENTS.md"), "utf8").replace("Run checks.", "Edited instructions.");
    writeFileSync(proj("AGENTS.md"), edited);
    await install({ kind: "instruction", id: "checks", action: "forget" });
    assert.equal(readFileSync(proj("AGENTS.md"), "utf8"), edited);
    assert.equal(await status(install({ kind: "instruction", id: "checks" })), 409);
    assert.equal(await status(() => lib.save("instruction", "injection", { "AGENTS.md": "<!-- odin:checks:end -->" })), 400);
    writeFileSync(proj("AGENTS.md"), "<!-- odin:checks:start -->\nUnclosed section.\n");
    assert.equal(await status(install({ kind: "instruction", id: "checks", force: true })), 409);
    assert.match(readFileSync(proj("AGENTS.md"), "utf8"), /Unclosed section/);
  });

  test("legacy task migration keeps sources and configuration references, and never overwrites skills or repeats", () => {
    const source = JSON.stringify({ promptId: "task", model: "opus", worktree: true });
    const { lib, config, deps, ref } = setup({ library: {
      "skills/task/SKILL.md": SKILL,
      "prompts/task.md": "Implement {{item.title}} carefully.\n",
      "templates/work.json": source,
    } });
    assert.equal(lib.files("skill", "task")!["SKILL.md"], SKILL);
    assert.match(lib.files("skill", "prompt-task")!["SKILL.md"]!, /<item.title>/);
    assert.equal(lib.files("skill", "work")!["references/former-template.json"], source);
    assert.equal(readFileSync(join(config.libraryDir, "templates/work.json"), "utf8"), source);
    lib.remove("skill", "work");
    lib.close();
    const restarted = createLibraryService(deps, stubServices({ projects: { get: () => ref } as unknown as ProjectsService }));
    assert.equal(restarted.get("skill", "work"), null);
    restarted.close();
  });

  const MCP = { name: "GitHub", type: "stdio", command: "gh-mcp", args: ["--stdio"] };

  test("mcp is merged under mcpServers.<id>; the rest of .mcp.json is kept; forget takes only ours out", async () => {
    const { lib, install, proj, written } = setup();
    lib.save("mcp", "gh", { "gh.json": JSON.stringify(MCP) });
    const original = { mcpServers: { mine: { command: "my-server" } }, extra: { keep: true } };
    write(proj(""), { ".mcp.json": JSON.stringify(original) });

    const r = await install({ kind: "mcp", id: "gh" });
    assert.deepEqual(r.changed, [".mcp.json"]);
    assert.deepEqual(written, [[".mcp.json"]]);
    const doc = JSON.parse(readFileSync(proj(".mcp.json"), "utf8"));
    assert.deepEqual(doc, { mcpServers: { mine: { command: "my-server" }, gh: { type: "stdio", command: "gh-mcp", args: ["--stdio"] } }, extra: { keep: true } });
    assert.equal(r.installation!.state, "current");
    assert.deepEqual(r.installation!.paths, [".mcp.json"]);
    const files = lib.projectFiles("app", "mcp", "gh")!;
    assert.deepEqual(JSON.parse(files["gh.json"]!), { name: "GitHub", description: "", type: "stdio", command: "gh-mcp", args: ["--stdio"] });

    // The user edits our entry: modified. Library moves too: conflict.
    doc.mcpServers.gh.args = ["--verbose"];
    writeFileSync(proj(".mcp.json"), JSON.stringify(doc));
    assert.equal(lib.installations("app")[0]!.state, "modified");
    lib.save("mcp", "gh", { "gh.json": JSON.stringify({ ...MCP, args: [] }) });
    assert.equal(lib.installations("app")[0]!.state, "conflict");
    assert.equal(await status(lib.install("app", { kind: "mcp", id: "gh", action: "update" })), 409);
    await lib.install("app", { kind: "mcp", id: "gh", action: "update", force: true });
    assert.equal(lib.installations("app")[0]!.state, "current");

    const f = await lib.install("app", { kind: "mcp", id: "gh", action: "forget" });
    assert.deepEqual(f.changed, [".mcp.json"]);
    assert.deepEqual(JSON.parse(readFileSync(proj(".mcp.json"), "utf8")), original);
  });

  test("mcp: update-available, missing, untracked server 409, push, broken .mcp.json", async () => {
    const { lib, install, proj } = setup();
    lib.save("mcp", "gh", { "gh.json": JSON.stringify(MCP) });
    write(proj(""), { ".mcp.json": JSON.stringify({ mcpServers: { gh: { command: "someone-elses" } } }) });
    assert.equal(await status(install({ kind: "mcp", id: "gh" })), 409);
    await install({ kind: "mcp", id: "gh", force: true });
    lib.save("mcp", "gh", { "gh.json": JSON.stringify({ ...MCP, args: ["--new"] }) });
    assert.equal(lib.installations("app")[0]!.state, "update-available");

    // Push the project's entry back: the library returns to it and it is current.
    const pushed = await lib.install("app", { kind: "mcp", id: "gh", action: "push" });
    assert.equal(pushed.installation!.state, "current");
    assert.deepEqual(lib.get("mcp", "gh")!.meta, { type: "stdio", command: "gh-mcp", args: ["--stdio"] });
    assert.equal(lib.get("mcp", "gh")!.name, "GitHub");

    writeFileSync(proj(".mcp.json"), JSON.stringify({ mcpServers: {} }));
    assert.equal(lib.installations("app")[0]!.state, "missing");
    writeFileSync(proj(".mcp.json"), "{ broken");
    assert.equal(lib.installations("app")[0]!.state, "missing");
    assert.equal(await status(lib.install("app", { kind: "mcp", id: "gh", action: "update", force: true })), 409);
    assert.equal(readFileSync(proj(".mcp.json"), "utf8"), "{ broken", "a file we can't parse is never overwritten");
  });

  test("settings: rules deduped, hooks added, drift, forget leaves the user's own entries", async () => {
    const { lib, install, proj } = setup();
    const hook = { matcher: "Bash", hooks: [{ type: "command", command: "lint" }] };
    const profile = { name: "Safe", permissions: { allow: ["Read", "Bash(git status)"], deny: ["Bash(rm:*)"] }, hooks: { PreToolUse: [hook] } };
    lib.save("settings", "safe", { "safe.json": JSON.stringify(profile) });
    const original = { model: "opus", permissions: { allow: ["Read", "Edit"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } };
    write(proj(""), { ".claude/settings.json": JSON.stringify(original) });

    const r = await install({ kind: "settings", id: "safe" });
    assert.deepEqual(r.changed, [".claude/settings.json"]);
    assert.equal(r.installation!.state, "current");
    const doc = JSON.parse(readFileSync(proj(".claude/settings.json"), "utf8"));
    assert.deepEqual(doc.permissions, { allow: ["Read", "Edit", "Bash(git status)"], deny: ["Bash(rm:*)"] });
    assert.deepEqual(doc.hooks, { Stop: original.hooks.Stop, PreToolUse: [hook] });
    assert.equal(doc.model, "opus");

    // Installing again doesn't duplicate anything.
    await install({ kind: "settings", id: "safe" });
    assert.deepEqual(JSON.parse(readFileSync(proj(".claude/settings.json"), "utf8")), doc);

    // The user removes one of the profile's rules: modified.
    const edited = structuredClone(doc);
    edited.permissions.deny = [];
    writeFileSync(proj(".claude/settings.json"), JSON.stringify(edited));
    assert.equal(lib.installations("app")[0]!.state, "modified");
    writeFileSync(proj(".claude/settings.json"), JSON.stringify(doc));
    assert.equal(lib.installations("app")[0]!.state, "current");
    lib.save("settings", "safe", { "safe.json": JSON.stringify({ ...profile, permissions: { allow: ["Grep"] } }) });
    assert.equal(lib.installations("app")[0]!.state, "update-available");
    await lib.install("app", { kind: "settings", id: "safe", action: "update" });
    const updated = JSON.parse(readFileSync(proj(".claude/settings.json"), "utf8"));
    assert.deepEqual(updated.permissions, { allow: ["Read", "Edit", "Grep"] }, "the old version's rules are replaced; the user's Read stays");

    const f = await lib.install("app", { kind: "settings", id: "safe", action: "forget" });
    assert.deepEqual(f.changed, [".claude/settings.json"]);
    assert.deepEqual(JSON.parse(readFileSync(proj(".claude/settings.json"), "utf8")), original);

    rmSync(proj(".claude/settings.json"));
    await install({ kind: "settings", id: "safe" });
    rmSync(proj(".claude/settings.json"));
    assert.equal(lib.installations("app")[0]!.state, "missing");
  });
});
