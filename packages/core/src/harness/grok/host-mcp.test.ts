import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { hostMcpScript } from "./driver.ts";
import { handleMcp } from "./host-mcp.ts";

test("hostMcpScript: host-mcp.js beside the bundle wins, else the .ts source", () => {
  const dir = mkdtempSync(join(tmpdir(), "odin-hostmcp-"));
  try {
    const base = pathToFileURL(join(dir, "index.js")).href;
    assert.equal(hostMcpScript(base), join(dir, "host-mcp.ts"));
    writeFileSync(join(dir, "host-mcp.js"), "");
    assert.equal(hostMcpScript(base), join(dir, "host-mcp.js"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("host MCP lists and calls tools through the parent bridge", async () => {
  const seen: unknown[] = [];
  const parent = async (message: { method: string; params?: Record<string, unknown> }) => {
    seen.push(message);
    if (message.method === "tools/list") return { result: [{ name: "post_artifact", description: "Post", params: { html: { type: "string", description: "HTML" } } }] };
    return { result: { text: "posted", isError: false } };
  };
  const listed = await handleMcp({ id: 1, method: "tools/list" }, parent);
  assert.equal((listed?.result as { tools: { name: string }[] }).tools[0]?.name, "post_artifact");
  const called = await handleMcp({ id: 2, method: "tools/call", params: { name: "post_artifact", arguments: { html: "<p>" } } }, parent);
  assert.deepEqual((called?.result as { content: { text: string }[] }).content[0], { type: "text", text: "posted" });
  assert.deepEqual(seen[1], { id: 1, method: "tools/call", params: { name: "post_artifact", arguments: { html: "<p>" } } });
  const rejected = await handleMcp({ id: 3, method: "tools/call", params: { name: "Bad Name" } }, parent);
  assert.equal((rejected?.error as { message: string }).message, "Invalid tool name");
});


test("host MCP schemas omit optional implementation metadata and require only mandatory parameters", async () => {
  const result = await handleMcp({ id: 1, method: "tools/list" }, async () => ({ result: [{ name: "post_artifact", description: "Post", params: { html: { type: "string", description: "HTML" }, note: { type: "string", description: "Note", optional: true } } }] }));
  const schema = (result!.result as { tools: { inputSchema: unknown }[] }).tools[0]!.inputSchema;
  assert.deepEqual(schema, { type: "object", properties: { html: { type: "string", description: "HTML" }, note: { type: "string", description: "Note" } }, required: ["html"], additionalProperties: false });
});
