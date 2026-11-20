import { test } from "node:test";
import assert from "node:assert/strict";
import { attachmentPreview } from "./attachment-preview.ts";

test("image bytes are served as an image and text is forced to plain text", () => {
  const png = attachmentPreview({ name: "shot.png", mediaType: "image/png", data: Buffer.from("png").toString("base64"), encoding: "base64" });
  assert.equal(png?.mediaType, "image/png");
  assert.equal(png?.body.toString(), "png");
  assert.match(png?.disposition ?? "", /filename="shot.png"/);

  const note = attachmentPreview({ name: "a<b>.md", mediaType: "text/markdown", data: "# hi", encoding: "utf8" });
  assert.equal(note?.mediaType, "text/plain; charset=utf-8");
  assert.equal(note?.body.toString(), "# hi");
  assert.doesNotMatch(note?.disposition ?? "", /[\r\n]/);

  assert.equal(attachmentPreview({ name: "page.svg", mediaType: "image/svg+xml", data: Buffer.from("<svg/>").toString("base64"), encoding: "base64" }), null);
  assert.equal(attachmentPreview({ name: "empty.txt", mediaType: "text/plain", data: "", encoding: "utf8" }), null);
});
