import { test } from "node:test";
import assert from "node:assert/strict";
import { codexFailure } from "./errors.ts";

test("usage exhaustion is actionable without exposing raw runtime messages", () => {
  assert.match(codexFailure({ codexErrorInfo: "usageLimitExceeded", message: "SECRET" }), /usage limit reached/);
  assert.match(codexFailure({ codexErrorInfo: { usageLimitExceeded: {} } }), /session is preserved/);
  assert.equal(codexFailure({ message: "SECRET" }), "Codex turn failed");
});
