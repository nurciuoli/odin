import { test } from "node:test";
import assert from "node:assert/strict";
import { fileHash } from "../hash.ts";
import { parseAgentFile } from "./parse.ts";

const FILE = `---
name: Builder
description: >
  Implements   items
  well.
tools: Read, Edit, Bash
model: sonnet
---

You build things.
`;

test("parseAgentFile reads Claude Code subagent frontmatter", () => {
  const a = parseAgentFile("builder", FILE);
  assert.deepEqual(a, {
    id: "builder",
    name: "Builder",
    description: "Implements items well.",
    model: "sonnet",
    tools: ["Read", "Edit", "Bash"],
    prompt: "You build things.",
    version: fileHash("builder.md", FILE),
    error: null,
  });
});

test("defaults and errors", () => {
  const a = parseAgentFile("x", "---\nname: x\n---\nbody");
  assert.equal(a.tools, null);
  assert.equal(a.model, null);
  assert.equal(a.error, null);
  const b = parseAgentFile("y", "no frontmatter");
  assert.match(b.error ?? "", /frontmatter/);
  assert.equal(b.name, "y");
});

test("tools as a YAML list", () => {
  assert.deepEqual(parseAgentFile("z", "---\ntools:\n  - Read\n  - Grep\n---\n").tools, ["Read", "Grep"]);
});
