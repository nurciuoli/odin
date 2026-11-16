import { test } from "node:test";
import assert from "node:assert/strict";
import { artifactPdfUrl } from "./pdf.ts";
test("PDF export accepts only saved numeric versions on the local core", () => {
  assert.equal(artifactPdfUrl("http://127.0.0.1:8790", 1, 2), "http://127.0.0.1:8790/a/1/2");
  for (const id of ["1", "../api", 0, -1, 1.5, NaN]) assert.throws(() => artifactPdfUrl("http://127.0.0.1:8790", id, 1));
  assert.throws(() => artifactPdfUrl("https://example.com", 1, 1));
});
