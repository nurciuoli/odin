import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { imageProblem, imagePromptsAccepted, promptBlocks } from "./input.ts";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]).toString("base64");

test("prompt blocks send a checked image and an embedded text file", () => {
  const built = promptBlocks({
    text: "look",
    attachments: [
      { name: "red.png", mediaType: "image/png", data: png },
      { name: "notes.txt", mediaType: "text/plain", data: "PELICAN" },
      { name: "icon.svg", mediaType: "image/svg+xml", data: "<svg/>" },
    ],
  }, true);
  assert.deepEqual(built.blocks, [
    { type: "text", text: "look" },
    { type: "text", text: '<attachment name="red.png" media-type="image/png" />' },
    { type: "image", data: png, mimeType: "image/png" },
    { type: "resource", resource: { uri: "file:///odin-attachment/notes.txt", mimeType: "text/plain", text: "PELICAN" } },
  ]);
  assert.deepEqual(built.skipped, ["icon.svg: unsupported image format. It was not sent."]);
  assert.match(imageProblem({ name: "x.png", mediaType: "image/png", data: "!!!" }) ?? "", /invalid image data/);
});

test("image prompts follow the advertised capability", () => {
  assert.equal(imagePromptsAccepted({}), true);
  assert.equal(imagePromptsAccepted({ agentCapabilities: { promptCapabilities: { image: false } } }), false);
  const built = promptBlocks({ text: "", attachments: [{ name: "red.png", mediaType: "image/png", data: png }] }, false);
  assert.deepEqual(built.blocks, [{ type: "text", text: "" }]);
  assert.equal(built.skipped.length, 1);
});
