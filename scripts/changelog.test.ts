import assert from "node:assert/strict";
import { test } from "node:test";
import { assemble, checkFragment } from "./changelog.ts";

const base = "# Changelog\n\nintro\n\n## [Unreleased]\n\n- old entry\n\n## [0.1.0]\n\nFirst.\n";

test("assemble moves Unreleased and fragments under the new version", () => {
  const out = assemble(base, "0.2.0", ["- one\n", "- two\n"]);
  assert.equal(out, "# Changelog\n\nintro\n\n## [Unreleased]\n\n## [0.2.0]\n\n- old entry\n- one\n- two\n\n## [0.1.0]\n\nFirst.\n");
});

test("assemble keeps CRLF line endings and handles a changelog with no older version", () => {
  const out = assemble("## [Unreleased]\r\n\r\n- a\r\n", "1.0.0", ["- b"]);
  assert.equal(out, "## [Unreleased]\r\n\r\n## [1.0.0]\r\n\r\n- a\r\n- b\r\n\r\n");
});

test("assemble refuses an empty release", () => {
  assert.throws(() => assemble("## [Unreleased]\n\n## [0.1.0]\n", "0.2.0", []), /nothing to release/);
});

test("checkFragment", () => {
  assert.deepEqual(checkFragment("- ok\n"), []);
  assert.deepEqual(checkFragment("  \n"), ["is empty"]);
  assert.equal(checkFragment("plain text").length, 1);
  assert.equal(checkFragment("- a\n## h").length, 1);
});
