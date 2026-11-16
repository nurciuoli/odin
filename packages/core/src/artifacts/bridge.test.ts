import { loadConfig } from "../config.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { bridgeScript, injectBridge, loadTheme, parseThemeTokens, scriptJson, SUBMIT_MAX_BYTES } from "./bridge.ts";

/** Runs the bridge in a fresh realm with a fake window/parent; returns window.odin and the posted messages. */
function runBridge(script: string) {
  const m = /^<script>([\s\S]*)<\/script>$/.exec(script);
  assert.ok(m, "a single <script> element");
  const posted: { message: unknown; origin: string }[] = [];
  const context: Record<string, unknown> = {
    parent: { postMessage: (message: unknown, origin: string) => posted.push({ message, origin }) },
    TextEncoder,
  };
  context.window = context;
  runInNewContext(m[1]!, context);
  const odin = context.odin as { submit(data: unknown): void; theme: Record<string, string> };
  // Objects from another realm have other prototypes: compare them as JSON.
  const plain = () => JSON.parse(JSON.stringify(posted));
  return { odin, plain };
}

test("submit posts { type, artifactId, version, data } to the parent with '*'", () => {
  const { odin, plain } = runBridge(bridgeScript(7, 3, { "--iu-accent": "#e07b4a" }));
  assert.deepEqual(JSON.parse(JSON.stringify(odin.theme)), { "--iu-accent": "#e07b4a" });
  odin.submit({ choice: "B", n: 2, skip: undefined });
  odin.submit(null);
  assert.deepEqual(plain(), [
    { message: { type: "odin.submit", artifactId: 7, version: 3, data: { choice: "B", n: 2 } }, origin: "*" },
    { message: { type: "odin.submit", artifactId: 7, version: 3, data: null }, origin: "*" },
  ]);
});

test("submit refuses non-JSON and oversized data, posting nothing", () => {
  const { odin, plain } = runBridge(bridgeScript(1, 1, {}));
  assert.throws(() => odin.submit(undefined), /must be JSON/);
  assert.throws(() => odin.submit(() => 1), /must be JSON/);
  assert.throws(() => odin.submit("x".repeat(SUBMIT_MAX_BYTES)), /over 65536 bytes/);
  odin.submit("x".repeat(SUBMIT_MAX_BYTES - 2)); // two quote characters make it exactly the limit
  assert.equal(plain().length, 1);
});

test("theme values can't break out of the script element", () => {
  const theme = { "--iu-evil": "</script><script>alert(1)</script>", "--iu-sep": "a b c" };
  const script = bridgeScript(1, 1, theme);
  assert.equal(script.indexOf("</script>"), script.length - "</script>".length);
  assert.ok(!script.slice(8, -9).includes("<"));
  const { odin } = runBridge(script);
  assert.deepEqual(JSON.parse(JSON.stringify(odin.theme)), theme);
  assert.equal(scriptJson("<!--"), '"\\u003c!--"');
});

test("injectBridge: before </head>, else after a doctype, else at the start", () => {
  const s = "<script>B</script>";
  assert.equal(injectBridge("<html><head><title>t</title></HEAD ><body></body></html>", s), `<html><head><title>t</title>${s}</HEAD ><body></body></html>`);
  assert.equal(injectBridge("<!DOCTYPE html>\n<p>hi</p>", s), `<!DOCTYPE html>${s}\n<p>hi</p>`);
  assert.equal(injectBridge("<p>hi</p>", s), `${s}<p>hi</p>`);
  assert.equal(injectBridge("﻿<p>hi</p>", s), `${s}<p>hi</p>`);
  assert.equal(injectBridge("", s), s);
});

test("theme: --iu-* properties from :root, comments ignored; the real tokens.css has the accent", () => {
  const css = `/* --iu-commented: red; */\n:root {\n  --iu-a: #111; /* note */\n  --iu-font: 'IBM Plex Sans', system-ui;\n  --other: 1px;\n}\n.x { --iu-not-root: 1; }\n:root{--iu-b:2px}`;
  assert.deepEqual(parseThemeTokens(css), { "--iu-a": "#111", "--iu-font": "'IBM Plex Sans', system-ui", "--iu-b": "2px" });
  const theme = loadTheme(loadConfig({}).artifactThemePath);
  assert.match(theme["--iu-accent"] ?? "", /^#[0-9a-f]{6}$/i);
  assert.ok(theme["--iu-font-sans"]);
  assert.ok(theme["--iu-radius-md"]);
});

test("theme: a configured path (ODIN_ARTIFACT_THEME) is read; a missing one gives an empty theme", () => {
  const dir = mkdtempSync(join(tmpdir(), "odin-theme-"));
  try {
    const file = join(dir, "tokens.css");
    writeFileSync(file, ":root { --iu-accent: #123456; }");
    assert.deepEqual(loadTheme(file), { "--iu-accent": "#123456" });
    assert.deepEqual(loadTheme(join(dir, "missing.css")), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
