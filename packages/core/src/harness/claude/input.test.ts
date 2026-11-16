import { test } from "node:test";
import assert from "node:assert/strict";
import { InputQueue, toSdkUserMessage } from "./input.ts";

const UUID = "00000000-0000-4000-8000-000000000001";

test("a plain message is sent as a string with the driver's uuid", () => {
  assert.deepEqual(toSdkUserMessage({ text: "hello" }, UUID), {
    type: "user",
    message: { role: "user", content: "hello" },
    parent_tool_use_id: null,
    uuid: UUID,
  });
});

test("images become base64 image blocks (announced by name); text files are inlined", () => {
  const m = toSdkUserMessage(
    {
      text: "look",
      attachments: [
        { name: "a.PNG", mediaType: "Image/PNG", data: "iVBOR" },
        { name: 'x"y.md', mediaType: "text/markdown", data: "# Hi" },
      ],
    },
    UUID,
  );
  assert.deepEqual(m.message.content, [
    { type: "text", text: "look" },
    { type: "text", text: '<attachment name="a.PNG" media-type="Image/PNG" />' },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } },
    { type: "text", text: '<attachment name="x&quot;y.md" media-type="text/markdown">\n# Hi\n</attachment>' },
  ]);
});

test("the queue delivers in order, waits for items, and ends", async () => {
  const q = new InputQueue<number>();
  q.push(1);
  const it = q[Symbol.asyncIterator]();
  assert.deepEqual(await it.next(), { value: 1, done: false });
  const pending = it.next();
  q.push(2);
  assert.deepEqual(await pending, { value: 2, done: false });
  const last = it.next();
  q.end();
  assert.deepEqual(await last, { value: undefined, done: true });
  q.push(3);
  assert.deepEqual(await it.next(), { value: undefined, done: true });
  assert.equal(q.ended, true);
});
