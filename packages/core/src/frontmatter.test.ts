import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter } from "./frontmatter.ts";

test("frontmatter: flow lists, block lists, block strings and the body", () => {
  const { data, errors, body } = parseFrontmatter([
    "---",
    "name: Designer",
    "tools: [read, grep]   # no shell",
    'quoted: ["a, b", \'c\', d]',
    "empty: []",
    "list:",
    "  - read",
    "  - 'bash'",
    "flat:",
    "- edit",
    "- write # comment",
    "description: |",
    "  Line one.",
    "  Line two.",
    "",
    "folded: >",
    "  one",
    "  two",
    "claude: Read, Edit, Bash(git:*)",
    "after: x",
    "---",
    "You design things.",
    "",
    "More.",
  ].join("\n"), "designer.md");
  assert.deepEqual(errors, []);
  assert.deepEqual(data, {
    name: "Designer",
    tools: ["read", "grep"],
    quoted: ["a, b", "c", "d"],
    empty: [],
    list: ["read", "bash"],
    flat: ["edit", "write"],
    description: "Line one.\nLine two.",
    folded: "one two",
    claude: "Read, Edit, Bash(git:*)",
    after: "x",
  });
  assert.equal(body, "You design things.\n\nMore.");
});

test("frontmatter: malformed lists are errors, the rest still parses", () => {
  const { data, errors } = parseFrontmatter("---\na: [x, [y]]\nb: [x\nc: [x] y\nd: ok\n---\n", "x.md");
  assert.equal(errors.length, 3);
  assert.deepEqual(data, { d: "ok" });
  const none = parseFrontmatter("just text", "agent.md");
  assert.equal(none.data, null);
  assert.match(none.errors[0], /agent\.md has no frontmatter/);
  assert.equal(none.body, "just text");
});
