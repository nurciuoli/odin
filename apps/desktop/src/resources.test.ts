import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { coreEnv } from "./resources.ts";

test("packaged: runs the bundled core with the app's own Node", () => {
  const r = join("C:", "Odin", "resources");
  const got = coreEnv({ packaged: true, resourcesPath: r, repoRoot: "unused", execPath: "Odin.exe" });
  assert.equal(got.command, "Odin.exe");
  assert.deepEqual(got.args, [join(r, "core", "index.js")]);
  assert.deepEqual(got.env, {
    ELECTRON_RUN_AS_NODE: "1",
    ODIN_WEB_DIST: join(r, "web"),
    ODIN_LIBRARY_SEED: join(r, "library"),
    ODIN_ARTIFACT_THEME: join(r, "tokens.css"),
    ODIN_ADAPTER_DIR: join(r, "adapter"),
  });
});

test("dev: runs core from source with node and repo paths", () => {
  const repo = join("C:", "repo");
  const got = coreEnv({ packaged: false, resourcesPath: "unused", repoRoot: repo });
  assert.equal(got.command, "node");
  assert.deepEqual(got.args, [join(repo, "packages", "core", "src", "index.ts")]);
  assert.equal(got.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(got.env.ODIN_ADAPTER_DIR, join(repo, "adapters", "claude-code", "src"));
  assert.equal(got.env.ODIN_ARTIFACT_THEME, join(repo, "packages", "web", "src", "styles", "tokens.css"));
});
