import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { HttpError } from "../http/util.ts";
import { join } from "node:path";
import { git, makeRepo, repoCount, root, setup, status } from "./test-repo.ts";


test("removing either configured repository cannot cascade-delete a workspace session", async () => {
  const { deps, projects } = setup();
  for (const name of ["first", "second"]) deps.db.prepare("INSERT INTO projects (name, path, created_at, updated_at) VALUES (?, ?, 't', 't')").run(name, `/${name}`);
  deps.db.prepare("INSERT INTO sessions (id, harness, project, projects, title, origin, state, cwd, metrics, created_at, updated_at) VALUES ('multi', 'claude', 'first', ?, 'Work', 'odin', 'ended', '/first', '{}', 't', 't')").run(JSON.stringify(["first", "second"]));
  for (const name of ["first", "second"]) assert.throws(() => projects.remove(name), (e: unknown) => e instanceof HttpError && e.status === 409);
  assert.ok(deps.db.prepare("SELECT 1 FROM sessions WHERE id = 'multi'").get());
  await projects.close();
});

describe("register", () => {
  test("a repo registers with defaults and emits project.updated", async () => {
    const { deps, projects } = setup();
    const { path } = makeRepo();
    const ref = await projects.create({ path });
    assert.equal(ref.name, `repo${repoCount()}`);
    assert.equal(ref.missing, false);
    assert.equal(ref.manifestError, null);
    assert.deepEqual(ref.settings, { title: ref.name, description: "hi", repo: null, defaultBranch: "main", commands: {} });
    assert.equal(projects.detail(ref.name)!.context.discovered.overview, "README.md");
    assert.equal(projects.detail(ref.name)!.context.provenance.description.kind, "document");
    assert.ok(deps.events.some((e) => e.type === "project.updated"));
    assert.equal(projects.detail(ref.name)!.git.branch, "main");
    assert.equal(projects.get(ref.name)?.path, path);
    assert.equal(projects.list().length, 1);
  });

  test("a non-repo folder works without creating git", async () => {
    const { projects } = setup();
    const dir = join(root, "plain");
    mkdirSync(dir);
    const ref = await projects.create({ path: dir });
    assert.equal(ref.name, "plain");
    assert.equal(ref.missing, false);
    assert.equal(existsSync(join(dir, ".git")), false);
  });

  test("init does not commit", async () => {
    const { projects } = setup();
    const dir = join(root, "plain2");
    mkdirSync(dir);
    await projects.create({ path: dir, init: true });
    assert.throws(() => git(dir, "rev-parse", "--verify", "HEAD"));
  });

  test("mkdir creates the folder, README and git without a commit", async () => {
    const { projects } = setup();
    const dir = join(root, "fresh", "nested", "notes");
    const ref = await projects.create({ path: dir, mkdir: true, readme: true, init: true });
    assert.equal(ref.name, "notes");
    assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "# notes\n");
    assert.equal(existsSync(join(dir, ".git")), true);
    assert.throws(() => git(dir, "rev-parse", "--verify", "HEAD"));
  });

  test("mkdir accepts an empty folder and refuses a used one", async () => {
    const { projects } = setup();
    const empty = join(root, "empty-ok");
    mkdirSync(empty);
    assert.equal((await projects.create({ path: empty, mkdir: true })).name, "empty-ok");
    const used = join(root, "used-no");
    mkdirSync(used);
    writeFileSync(join(used, "a.txt"), "x");
    assert.equal(await status(projects.create({ path: used, mkdir: true })), 409);
    assert.equal(await status(projects.create({ path: join(root, "r1"), readme: true })), 400);
  });

  test("clone validates the source and leaves nothing behind on failure", async () => {
    const { projects } = setup();
    for (const clone of ["-oProxyCommand=x", "ext::sh -c id", "/etc/passwd", "file:///tmp/x", ""]) {
      assert.equal(await status(projects.create({ path: join(root, "c1"), clone })), 400, clone);
    }
    assert.equal(await status(projects.create({ path: join(root, "c1"), clone: "a/b", init: true })), 400);
    const dest = join(root, "cloned", "x");
    assert.equal(await status(projects.create({ path: dest, clone: "https://127.0.0.1:1/x.git" })), 400);
    assert.equal(existsSync(dest), false);
  });

  test("a missing or relative path is 400", async () => {
    const { projects } = setup();
    assert.equal(await status(projects.create({ path: join(root, "nope") })), 400);
    assert.equal(await status(projects.create({ path: "relative/dir" })), 400);
  });

  test("name rules and slugging", async () => {
    const { projects } = setup();
    const a = makeRepo();
    assert.equal(await status(projects.create({ path: a.path, name: "Bad Name" })), 400);
    const dir = join(root, "My Cool_Project");
    mkdirSync(dir);
    git(dir, "init", "--quiet");
    assert.equal((await projects.create({ path: dir })).name, "my-cool-project");
    assert.equal((await projects.create({ path: a.path, name: "custom" })).name, "custom");
  });

  test("duplicates are 409", async () => {
    const { projects } = setup();
    const a = makeRepo();
    const b = makeRepo();
    await projects.create({ path: a.path, name: "one" });
    assert.equal(await status(projects.create({ path: b.path, name: "one" })), 409);
    assert.equal(await status(projects.create({ path: a.path, name: "two" })), 409);
    const link = join(root, `link${repoCount()}`);
    symlinkSync(a.path, link);
    assert.equal(await status(projects.create({ path: link, name: "three" })), 409);
  });

  test("remove unregisters and never deletes files", async () => {
    const { projects } = setup();
    const a = makeRepo();
    await projects.create({ path: a.path, name: "gone" });
    projects.remove("gone");
    assert.equal(projects.get("gone"), null);
    assert.ok(existsSync(a.path));
    assert.throws(() => projects.remove("gone"), (e) => e instanceof HttpError && e.status === 404);
  });
});

describe("missing", () => {
  test("a gone path stays registered and is flagged", async () => {
    const { projects } = setup();
    const a = makeRepo({ files: { "PROJECT.md": "---\ntitle: Kept\n---\n" } });
    await projects.create({ path: a.path, name: "x" });
    rmSync(a.path, { recursive: true, force: true });
    await projects.refresh("x");
    const ref = projects.get("x")!;
    assert.equal(ref.missing, true);
    assert.match(ref.manifestError ?? "", /path not found/);
    assert.equal(ref.settings.title, "Kept");
    assert.equal(projects.detail("x")!.missing, true);
  });
});

describe("agents", () => {
  test("parsed with versions, and libraryId from installations", async () => {
    const { deps, projects } = setup();
    const file = "---\nname: Reviewer\ndescription: Reviews\nmodel: sonnet\ntools: Read, Grep\n---\nReview.\n";
    const a = makeRepo({ files: { ".claude/agents/reviewer.md": file, ".claude/agents/other.md": "no frontmatter" } });
    await projects.create({ path: a.path, name: "ag" });
    const agents = projects.agents("ag");
    assert.deepEqual(agents.map((x) => x.id), ["other", "reviewer"]);
    const r = agents.find((x) => x.id === "reviewer")!;
    assert.equal(r.name, "Reviewer");
    assert.equal(r.model, "sonnet");
    assert.deepEqual(r.tools, ["Read", "Grep"]);
    assert.equal(r.path, ".claude/agents/reviewer.md");
    assert.match(r.version, /^[0-9a-f]{64}$/);
    assert.equal(r.libraryId, null);
    assert.ok(agents.find((x) => x.id === "other")!.error);

    deps.db.prepare("INSERT INTO installations (project, kind, asset_id, installed_version, installed_at) VALUES (?, 'agent', 'reviewer', ?, ?)").run("ag", r.version, "t");
    assert.equal(projects.agents("ag").find((x) => x.id === "reviewer")!.libraryId, "reviewer");
    assert.equal(projects.detail("ag")!.agents.length, 2);

    writeFileSync(join(a.path, ".claude/agents/reviewer.md"), file + "More.\n");
    await projects.refresh("ag");
    assert.notEqual(projects.agents("ag").find((x) => x.id === "reviewer")!.version, r.version);
    assert.deepEqual(projects.agents("nope"), []);
  });
});

describe("noteWritten and dirtyFiles", () => {
  test("only files git still shows as changed are listed", async () => {
    const { projects } = setup();
    const a = makeRepo();
    await projects.create({ path: a.path, name: "d" });
    writeFileSync(join(a.path, "hooks.json"), "{}");
    writeFileSync(join(a.path, "other.txt"), "not reported");
    projects.noteWritten("d", ["hooks.json", "README.md", "../escape"]);
    await projects.refresh("d");
    assert.deepEqual(projects.detail("d")!.dirtyFiles, ["hooks.json"]);
    assert.equal(projects.detail("d")!.git.dirty, true);
    git(a.path, "add", "hooks.json");
    git(a.path, "commit", "--quiet", "-m", "hooks");
    await projects.refresh("d");
    assert.deepEqual(projects.detail("d")!.dirtyFiles, []);
  });
});

describe("resolveCwd", () => {
  test("repo, subdir, unrelated, nested projects and relative paths", async () => {
    const { projects } = setup();
    const a = makeRepo();
    await projects.create({ path: a.path, name: "rc" });
    assert.equal(projects.resolveCwd(a.path), "rc");
    assert.equal(projects.resolveCwd(join(a.path, "src", "deep")), "rc");
    assert.equal(projects.resolveCwd(root), null);
    assert.equal(projects.resolveCwd(`${a.path}-sibling`), null);
    assert.equal(projects.resolveCwd("relative"), null);
    assert.equal(projects.resolveCwd(join(a.path, "..", "elsewhere")), null);
    const link = join(root, `rclink${repoCount()}`);
    symlinkSync(a.path, link);
    assert.equal(projects.resolveCwd(link), "rc");
  });
});

describe("sources and inferred metadata", () => {
  test("overrides win, a saved selection is kept, and a status edit is noticed", async () => {
    const { deps, projects } = setup();
    const a = makeRepo({
      origin: true,
      files: {
        "README.md": "# Yes Chef\n\nCooks.\n",
        "package.json": JSON.stringify({ name: "chefai", scripts: { build: "vite build" } }),
        "docs/STATUS.md": "# Now\n\nStanding.\n",
        "docs/plans/story.md": "# Story\n",
      },
    });
    git(a.path, "remote", "set-url", "origin", "git@github.com:acme/chef.git");
    const ref = await projects.create({ path: a.path, name: "chef" });
    assert.equal(ref.settings.title, "Yes Chef");
    assert.equal(ref.settings.repo, "acme/chef");
    assert.equal(ref.settings.commands.build, "npm run build");
    assert.equal(ref.settings.commands.install, "npm install");
    const detail = projects.detail("chef")!;
    assert.equal(detail.context.provenance.title.kind, "document");
    assert.equal(detail.context.excerpts[0]?.path, "docs/STATUS.md");
    assert.equal(detail.context.planning[0]?.path, "docs/plans/story.md");
    const over = await projects.updateSettings("chef", { title: "Mine", commands: { check: "npm test" } });
    assert.equal(over.settings.title, "Mine");
    assert.deepEqual(over.settings.commands, { check: "npm test" });
    await projects.updateSources("chef", { overview: "README.md", status: [], planning: ["docs/plans"] });
    const chosen = projects.detail("chef")!;
    assert.equal(chosen.context.customized, true);
    assert.equal(chosen.status, null);
    assert.equal(chosen.context.planning.length, 1);
    assert.equal(await status(projects.updateSources("chef", { overview: "../secret", status: [], planning: [] })), 400);
    await projects.updateSources("chef", null);
    assert.equal(projects.detail("chef")!.context.customized, false);
    deps.events.length = 0;
    writeFileSync(join(a.path, "docs", "STATUS.md"), "# Now\n\nMoved.\n");
    await projects.refresh("chef");
    assert.ok(deps.events.some((event) => event.type === "project.updated"));
    assert.equal(projects.detail("chef")!.context.excerpts[0]?.text, "Moved.");
  });
});
