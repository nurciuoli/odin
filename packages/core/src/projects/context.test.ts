import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { documentIntro, readProject, repoFromRemote } from "./context.ts";
import { tempDir } from "../test-helpers.ts";

test("a remote URL becomes owner/name and a heading is not the package name", () => {
  assert.equal(repoFromRemote("git@github.com:acme/widgets.git"), "acme/widgets");
  assert.equal(repoFromRemote("https://github.com/acme/widgets"), "acme/widgets");
  assert.equal(repoFromRemote("C:/repos/widgets.git"), null);
  const intro = documentIntro("# Yes Chef\n\nA kitchen app.\n\nMore.");
  assert.equal(intro.title, "Yes Chef");
  assert.equal(intro.description, "A kitchen app.");
  assert.equal(documentIntro("Just a paragraph.\n").title, undefined);
});

test("discovery fills empty fields and a saved selection wins", () => {
  const root = tempDir("odin-context-");
  mkdirSync(join(root, "docs", "plans"), { recursive: true });
  writeFileSync(join(root, "README.md"), "# Yes Chef\n\nCooks things.\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "chefai", scripts: { test: "vitest", build: "vite build" } }));
  writeFileSync(join(root, "docs", "STATUS.md"), "# Now\n\nThe oven is on.\n");
  writeFileSync(join(root, "docs", "plans", "story.md"), "---\nstatus: parked\n---\n# Story\n\nOne thread.\n");
  const discovered = readProject(root, "chef", {}, { detectedRepo: "acme/chef" }, null);
  assert.equal(discovered.settings.title, "Yes Chef");
  assert.equal(discovered.settings.description, "Cooks things.");
  assert.equal(discovered.settings.repo, "acme/chef");
  assert.equal(discovered.settings.commands.install, "npm install");
  assert.equal(discovered.settings.commands.check, "npm test");
  assert.equal(discovered.settings.commands.build, "npm run build");
  assert.equal(discovered.context.provenance.title.kind, "document");
  assert.equal(discovered.context.provenance.repo.kind, "git");
  assert.equal(discovered.context.excerpts[0]?.text, "The oven is on.");
  assert.equal(discovered.context.planning[0]?.status, "parked");
  assert.equal(discovered.status?.includes("The oven is on."), true);

  const saved = readProject(root, "chef", { title: "Mine" }, { detectedRepo: "acme/chef" }, { overview: null, status: [], planning: ["docs/plans"] });
  assert.equal(saved.settings.title, "Mine");
  assert.equal(saved.context.customized, true);
  assert.equal(saved.context.provenance.title.kind, "override");
  assert.equal(saved.context.excerpts.length, 0);
  assert.equal(saved.context.missing.includes("docs/STATUS.md"), false);
  assert.equal(saved.status, null);
});
