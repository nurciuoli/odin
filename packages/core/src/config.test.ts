import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { extraHostsFrom, harnessesFrom, loadConfig } from "./config.ts";

const home = join(tmpdir(), "odin-config-test");

test("config: repo-layout paths by default", () => {
  const c = loadConfig({ ODIN_HOME: home });
  const norm = (p: string) => p.replace(/\\+/g, "/");
  assert.ok(norm(c.webDist).endsWith("packages/web/dist"));
  assert.ok(norm(c.librarySeedDir).endsWith("templates/library"));
  assert.ok(norm(c.artifactThemePath).endsWith("packages/web/src/styles/tokens.css"));
  assert.ok(norm(c.adapterDir).endsWith("adapters/claude-code/src"));
  assert.ok(existsSync(c.librarySeedDir) && existsSync(c.artifactThemePath));
  assert.ok(existsSync(join(c.adapterDir, "odin-hook.ts")));
});

test("config: ODIN_WEB_DIST, ODIN_LIBRARY_SEED, ODIN_ARTIFACT_THEME, ODIN_ADAPTER_DIR override the paths", () => {
  const c = loadConfig({
    ODIN_HOME: home,
    ODIN_WEB_DIST: join(home, "web"),
    ODIN_LIBRARY_SEED: join(home, "seed"),
    ODIN_ARTIFACT_THEME: join(home, "tokens.css"),
    ODIN_ADAPTER_DIR: join(home, "adapter"),
  });
  assert.equal(c.webDist, resolve(home, "web"));
  assert.equal(c.librarySeedDir, resolve(home, "seed"));
  assert.equal(c.artifactThemePath, resolve(home, "tokens.css"));
  assert.equal(c.adapterDir, resolve(home, "adapter"));
});

test("config: blank overrides fall back to the defaults", () => {
  const blank = loadConfig({ ODIN_HOME: home, ODIN_WEB_DIST: "  ", ODIN_ADAPTER_DIR: "" });
  const plain = loadConfig({ ODIN_HOME: home });
  assert.equal(blank.webDist, plain.webDist);
  assert.equal(blank.adapterDir, plain.adapterDir);
});

test("ODIN_EXTRA_HOSTS accepts hostnames and rejects ports and schemes", () => {
  assert.deepEqual(extraHostsFrom(" Mac.Example.ts.net, mac.example.ts.net "), ["mac.example.ts.net"]);
  assert.deepEqual(loadConfig({ ODIN_HOME: home, ODIN_EXTRA_HOSTS: "odin.tail.ts.net" }).extraHosts, ["odin.tail.ts.net"]);
  assert.throws(() => extraHostsFrom("https://odin.tail.ts.net"), /hostname/);
  assert.throws(() => extraHostsFrom("odin.tail.ts.net:443"), /hostname/);
  assert.throws(() => extraHostsFrom("*.ts.net"), /hostname/);
  assert.equal(loadConfig({ ODIN_HOME: home }).allowedLogin, "");
  assert.equal(loadConfig({ ODIN_HOME: home, ODIN_ALLOWED_LOGIN: " Me@Example.com " }).allowedLogin, "me@example.com");
});

test("ODIN_HARNESSES defaults to Claude only and accepts a list or all", () => {
  assert.deepEqual(harnessesFrom(undefined), ["claude"]);
  assert.deepEqual(harnessesFrom(" Claude, codex ,codex"), ["claude", "codex"]);
  assert.equal(harnessesFrom("all"), null);
});
