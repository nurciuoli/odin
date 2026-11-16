import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, makeRepo, setup, status } from "./test-repo.ts";

describe("settings", () => {
  const MANIFEST = `---
title: From File
description: The file says
repo: acme/widgets
default_branch: trunk
commands:
  install: npm ci
  check: npm test
---

# Body
`;

  test("defaultWorktree is a boolean override; null clears it", async () => {
    const { projects } = setup();
    const a = makeRepo({});
    const ref = await projects.create({ path: a.path, name: "dw" });
    assert.equal("defaultWorktree" in ref.settings, false);
    assert.equal((await projects.updateSettings("dw", { defaultWorktree: true })).settings.defaultWorktree, true);
    assert.equal((await projects.updateSettings("dw", { defaultWorktree: false })).settings.defaultWorktree, false);
    await assert.rejects(projects.updateSettings("dw", { defaultWorktree: "yes" as never }), /defaultWorktree must be true or false/);
    assert.equal("defaultWorktree" in (await projects.updateSettings("dw", { defaultWorktree: null })).settings, false);
  });

  test("override ?? PROJECT.md ?? default, and null clears", async () => {
    const { projects } = setup();
    const a = makeRepo({ files: { "PROJECT.md": MANIFEST } });
    const ref = await projects.create({ path: a.path, name: "p" });
    assert.deepEqual(ref.settings, {
      title: "From File", description: "The file says", repo: "acme/widgets", defaultBranch: "trunk",
      commands: { install: "npm ci", check: "npm test" },
    });
    const over = await projects.updateSettings("p", { title: "Mine", commands: { build: "make" } });
    assert.equal(over.settings.title, "Mine");
    assert.equal(over.settings.description, "The file says");
    assert.deepEqual(over.settings.commands, { build: "make" });
    const cleared = await projects.updateSettings("p", { title: null, commands: null });
    assert.equal(cleared.settings.title, "From File");
    assert.deepEqual(cleared.settings.commands, { install: "npm ci", check: "npm test" });
    // PROJECT.md is never written.
    assert.equal(git(a.path, "status", "--porcelain"), "");
  });

  test("without PROJECT.md the defaults apply and the default branch is detected", async () => {
    const { projects } = setup();
    const a = makeRepo();
    git(a.path, "branch", "-m", "develop");
    const ref = await projects.create({ path: a.path, name: "q" });
    assert.equal(ref.manifestError, null);
    assert.equal(ref.settings.title, "q");
    assert.equal(ref.settings.defaultBranch, "develop");
  });

  test("validation", async () => {
    const { projects } = setup();
    const a = makeRepo();
    await projects.create({ path: a.path, name: "v" });
    assert.equal(await status(projects.updateSettings("v", { repo: "not a repo" })), 400);
    assert.equal(await status(projects.updateSettings("v", { defaultBranch: "-x" })), 400);
    assert.equal(await status(projects.updateSettings("v", { title: "" })), 400);
    assert.equal(await status(projects.updateSettings("v", { commands: { deploy: "x" } as never })), 400);
    assert.equal(await status(projects.updateSettings("nope", { title: "x" })), 404);
  });

  test("malformed PROJECT.md is a manifestError and the rest still applies", async () => {
    const { projects } = setup();
    const a = makeRepo({ files: { "PROJECT.md": "---\ntitle: Ok\nrepo: [broken\n---\n" } });
    const ref = await projects.create({ path: a.path, name: "m" });
    assert.match(ref.manifestError ?? "", /unclosed/);
    assert.equal(ref.settings.title, "Ok");
    const b = makeRepo({ files: { "PROJECT.md": "no frontmatter here\n" } });
    const ref2 = await projects.create({ path: b.path, name: "m2" });
    assert.match(ref2.manifestError ?? "", /no frontmatter/);
    assert.equal(ref2.settings.title, "m2");
  });

  test("editing PROJECT.md is picked up by refresh", async () => {
    const { deps, projects } = setup();
    const a = makeRepo();
    await projects.create({ path: a.path, name: "r" });
    deps.events.length = 0;
    writeFileSync(join(a.path, "PROJECT.md"), "---\ntitle: New\n---\n");
    await projects.refresh("r");
    assert.equal(projects.get("r")!.settings.title, "New");
    assert.ok(deps.events.some((e) => e.type === "project.updated"));
    deps.events.length = 0;
    await projects.refresh("r");
    assert.equal(deps.events.length, 0);
  });
});

