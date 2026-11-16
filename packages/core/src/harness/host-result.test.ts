import assert from "node:assert/strict";
import { test } from "node:test";
import { boundHostToolResult, HOST_RESULT_IMAGE_BYTES, HOST_RESULT_TEXT_BYTES, hostResultSummary } from "./host-result.ts";
import { hostToolDefinitions } from "./claude/tools.ts";
import { handleMcp } from "./grok/host-mcp.ts";
import { startHostBridge } from "./grok/bridge.ts";
import { parentClient } from "./grok/host-mcp.ts";
import { fakeHarness } from "./fake.ts";
import type { HostToolResult } from "./types.ts";

const image = { type: "image" as const, mimeType: "image/png" as const, data: "aW1hZ2U=" };

test("host results bound oversized text and images without dropping the useful summary", () => {
  const result = boundHostToolResult({ text: "✅".repeat(HOST_RESULT_TEXT_BYTES), content: [
    image,
    { ...image, data: "a".repeat(HOST_RESULT_IMAGE_BYTES + 4) },
    { ...image, data: "https://secret.example/image" },
  ] });
  assert.match(result.text, /truncated/);
  assert.match(result.text, /Additional output omitted/);
  assert.ok(Buffer.byteLength(result.text) < HOST_RESULT_TEXT_BYTES + 100);
  assert.deepEqual(result.content, [image]);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 8 * 1024 * 1024);
});

test("obvious credential values are redacted from text blocks and fallback summaries", () => {
  const result = boundHostToolResult({ text: "Bearer abc.DEF GH_TOKEN=private", content: [{ type: "text", text: "MY_API_KEY=sensitive" }, image] });
  const summary = hostResultSummary(result);
  for (const value of ["abc.DEF", "private", "sensitive", image.data]) assert.ok(!summary.includes(value), value);
  assert.match(summary, /Image: image\/png/);
  assert.match(summary, /redacted/);
});

test("Claude and shared Grok/Antigravity MCP transport preserve image blocks", async t => {
  const output: HostToolResult = { text: "Plot", content: [image, { type: "text", text: "caption" }] };
  const [definition] = hostToolDefinitions([{ name: "plot", description: "Plot", params: {}, handler: async () => output }]);
  const expected = [{ type: "text", text: "Plot" }, image, { type: "text", text: "caption" }];
  assert.deepEqual((await definition!.handler({}, {})).content, expected);
  const bridge = await startHostBridge([{ name: "plot", description: "Plot", params: {}, handler: async () => output }]);
  t.after(() => bridge.close());
  const parent = parentClient(bridge.port);
  t.after(() => parent.close());
  const answer = await handleMcp({ id: 2, method: "tools/call", params: { name: "plot" } }, parent);
  assert.deepEqual((answer?.result as { content: unknown }).content, expected);
});

test("thrown host errors cannot leak credentials over MCP", async () => {
  const [definition] = hostToolDefinitions([{ name: "broken", description: "Broken", params: {}, handler: async () => { throw new Error("secret credential"); } }]);
  assert.ok(!JSON.stringify(await definition!.handler({}, {})).includes("secret credential"));
});

test("fake harness records image summaries without base64 transcript payloads", async () => {
  const harness = fakeHarness({ script: () => [{ hostTool: "plot", input: {} }] });
  const handle = harness.start({ cwd: "/repo", prompt: { text: "plot" }, hostTools: [{ name: "plot", description: "Plot", params: {}, handler: async () => ({ text: "Plot", content: [image] }) }] });
  let result: unknown;
  for await (const event of handle.events) {
    if (event.type === "tool.result") result = event.result;
    if (event.type === "turn.end") { await handle.close(); break; }
  }
  assert.match(JSON.stringify(result), /Image: image\/png/);
  assert.ok(!JSON.stringify(result).includes(image.data));
});
