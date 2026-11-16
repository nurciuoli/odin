import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_ATTACHMENTS } from "@odin/shared/messages";
import { validateMessage } from "./message.ts";

const attachment = (data: string) => ({ name: "note.txt", mediaType: "text/plain", data });
test("message validation bounds individual, aggregate and count limits", () => {
  assert.equal(validateMessage({ text: "", attachments: [attachment("hello")] }).attachments?.length, 1);
  assert.throws(() => validateMessage({ text: "x", attachments: [attachment("x".repeat(5 * 1024 * 1024 + 1))] }), /5 MiB/);
  assert.throws(() => validateMessage({ text: "x", attachments: Array.from({ length: 5 }, () => attachment("x".repeat(5 * 1024 * 1024))) }), /20 MiB/);
  assert.throws(() => validateMessage({ text: "x", attachments: Array.from({ length: MAX_ATTACHMENTS + 1 }, () => attachment("x")) }), /at most/);
  assert.throws(() => validateMessage({ text: "x", attachments: [{ name: "image.png", mediaType: "image/png", data: "invalid" }] }), /base64/);
});
