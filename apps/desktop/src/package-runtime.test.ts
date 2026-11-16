import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimePackages } from "./package-runtime.ts";

test("runtime staging retains nested dependency versions and installed optional packages", () => {
  const root = mkdtempSync(join(tmpdir(), "odin-package-"));
  const modules = join(root, "node_modules");
  function pkg(name: string, spec: object) {
    const dir = join(modules, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(spec));
    return dir;
  }
  try {
    const a = pkg("a", { dependencies: { shared: "1" }, optionalDependencies: { native: "1", absent: "1" } });
    const nested = pkg("a/node_modules/shared", {});
    const b = pkg("b", { dependencies: { shared: "2" } });
    const shared = pkg("shared", {});
    const native = pkg("native", {});
    assert.deepEqual(new Set(runtimePackages(modules, ["a", "b"])), new Set([a, nested, b, shared, native]));
    assert.throws(() => runtimePackages(modules, ["missing"]), /Missing runtime package/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a package installed only above this repo is not part of the runtime", () => {
  const parent = mkdtempSync(join(tmpdir(), "odin-package-parent-"));
  const modules = join(parent, "repo", "node_modules");
  function pkg(name: string, spec: object) {
    const dir = join(modules, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(spec));
    return dir;
  }
  try {
    for (const name of ["@sinclair/typebox", "only-outside"]) {
      const dir = join(parent, "node_modules", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name }));
    }
    const peerOnly = pkg("peer-only", {
      peerDependencies: { "@sinclair/typebox": ">=0.34.8" },
      peerDependenciesMeta: { "@sinclair/typebox": { optional: true } },
    });
    pkg("app", { dependencies: { "only-outside": "1" } });
    assert.deepEqual(runtimePackages(modules, ["peer-only"]), [peerOnly]);
    assert.throws(() => runtimePackages(modules, ["app"]), /Missing runtime dependency only-outside/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("installed optional peers are left to the host; required peers are staged", () => {
  const root = mkdtempSync(join(tmpdir(), "odin-package-"));
  const modules = join(root, "node_modules");
  function pkg(name: string, spec: object) {
    const dir = join(modules, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(spec));
    return dir;
  }
  try {
    const plugin = pkg("plugin", {
      peerDependencies: { electron: "*", schema: "1" },
      peerDependenciesMeta: { electron: { optional: true } },
    });
    pkg("electron", {});
    const schema = pkg("schema", {});
    assert.deepEqual(new Set(runtimePackages(modules, ["plugin"])), new Set([plugin, schema]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
