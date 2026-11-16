import { test } from "node:test";
import assert from "node:assert/strict";
import { fileHash, filesHash } from "./hash.ts";

test("hash ignores line endings, trailing whitespace and key order; names count", () => {
  assert.equal(fileHash("a.md", "x\r\ny  \n"), fileHash("a.md", "x\ny"));
  assert.notEqual(fileHash("a.md", "x"), fileHash("b.md", "x"));
  assert.equal(filesHash({ "SKILL.md": "s", "ref.md": "r" }), filesHash({ "ref.md": "r", "SKILL.md": "s" }));
  assert.notEqual(filesHash({ "SKILL.md": "s" }), filesHash({ "SKILL.md": "s", "ref.md": "" }));
  assert.match(fileHash("a", "b"), /^[0-9a-f]{64}$/);
});
