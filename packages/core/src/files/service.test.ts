import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, linkSync } from "node:fs";
import { join } from "node:path";
import { testDeps, stubServices } from "../test-helpers.ts";
import { createFilesService, MAX_FILE_BYTES } from "./service.ts";

test("session files preserve text and reject stale writes, traversal, binaries and symlinks", (t) => {
  const deps = testDeps();
  const root = join(deps.config.home, "workspace");
  mkdirSync(root, { recursive: true });
  t.after(() => { deps.db.close(); rmSync(join(deps.config.home, ".."), { recursive: true, force: true }); });
  const services = { sessions: {}, projects: {} } as ReturnType<typeof stubServices>;
  services.sessions.get = id => id === "known" ? { cwd: root, project: "test" } as ReturnType<typeof services.sessions.get> : null;
  services.projects.get = () => null;
  const files = createFilesService(deps, services);
  const original = "\ufeff# Heading\r\n\r\n00123\r\n";
  writeFileSync(join(root, "README.md"), original);
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, "binary"), Buffer.from([0, 1, 2]));
  writeFileSync(join(root, "large"), Buffer.alloc(MAX_FILE_BYTES + 1, 65));
  assert.equal(files.read("known", "README.md").content, original);
  const opened = files.read("known", "README.md");
  const saved = files.save("known", opened.path, original + "next", opened.version);
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), saved.content);
  assert.notEqual(saved.version, opened.version);
  writeFileSync(join(root, "README.md"), "external edit");
  assert.throws(() => files.save("known", opened.path, "draft", saved.version), { status: 409 });
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), "external edit");
  for (const path of ["../outside", ".git/config", "C:/Windows/file", "file:stream"]) assert.throws(() => files.read("known", path));
  assert.throws(() => files.read("missing", "README.md"), { status: 404 });
  assert.throws(() => files.read("known", "binary"), { status: 415 });
  assert.throws(() => files.read("known", "large"), { status: 413 });
  assert.ok(!files.list("known").entries.some(e => e.name === ".git"));
  linkSync(join(root, "README.md"), join(root, "hardlink.md"));
  const hardlink = files.read("known", "hardlink.md");
  assert.throws(() => files.save("known", hardlink.path, "overwrite", hardlink.version), { status: 403 });
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), "external edit");
  try { symlinkSync(root, join(root, "link"), "junction"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error; return; }
  assert.throws(() => files.read("known", "link/README.md"), { status: 403 });
});


