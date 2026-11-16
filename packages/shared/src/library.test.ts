import { test } from "node:test";
import assert from "node:assert/strict";
import { fillPrompt, isInstallable, libraryAgentId, normaliseContent, promptVariables } from "./library.ts";

test("normaliseContent", () => {
  assert.equal(normaliseContent("a  \r\nb\t\r\n\r\n\r\n"), "a\nb\n");
  assert.equal(normaliseContent("x"), "x\n");
  assert.equal(normaliseContent(normaliseContent("a \n b")), normaliseContent("a \n b"));
});

test("prompt variables and filling", () => {
  const p = "Fix {{ item.title }} in {{project}}; {{project}} again; {{missing}}";
  assert.deepEqual(promptVariables(p), ["item.title", "project", "missing"]);
  assert.equal(fillPrompt(p, { project: "odin", "item.title": "#3" }), "Fix #3 in odin; odin again; {{missing}}");
});

test("kinds and agent ids", () => {
  assert.ok(isInstallable("skill") && !isInstallable("prompt") && !isInstallable("template"));
  assert.equal(libraryAgentId("library:reviewer"), "reviewer");
  assert.equal(libraryAgentId("reviewer"), null);
});
