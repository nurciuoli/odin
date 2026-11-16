import assert from "node:assert/strict";
import { test } from "node:test";
import { acpMcpServers, authMethod, costUsd, historyEntries, optionFor, permissionRequest, slashCommands, textOf, toolCallInput, toolCallName, usageFrom } from "./map.ts";

test("auth prefers a cached login and refuses an interactive-only method", () => {
  assert.equal(authMethod({ authMethods: [{ id: "grok.com" }, { id: "cached_token" }] }), "cached_token");
  assert.throws(() => authMethod({ authMethods: [{ id: "grok.com" }], _meta: { defaultAuthMethodId: "grok.com" } }), /grok login/);
});

test("usage converts ticks and folds reasoning into output", () => {
  assert.equal(costUsd(116586000), 0.116586);
  const event = usageFrom({
    stopReason: "end_turn",
    _meta: { modelId: "grok-4.7", usage: { inputTokens: 10, outputTokens: 2, reasoningTokens: 3, cachedReadTokens: 4, cacheCreationTokens: 5, costUsdTicks: 1e9, modelUsage: { "grok-4.7": { inputTokens: 10, outputTokens: 2, reasoningTokens: 3, cachedReadTokens: 4, cacheCreationTokens: 5, costUsdTicks: 1e9 } } } },
  }, 256000);
  assert.equal(event?.type, "usage");
  if (event?.type !== "usage") return;
  assert.equal(event.model, "grok-4.7");
  assert.equal(event.cumulative, false);
  assert.equal(event.costUsd, 1);
  assert.equal(event.contextTokens, null);
  assert.equal(event.contextWindow, 256000);
  assert.deepEqual(event.usage, { input: 10, output: 5, cacheRead: 4, cacheWrite: 5 });
});

test("tool rows keep a short name and drop a long ACP title", () => {
  const verbose = { title: "Execute `npm test -- --run packages/web`", kind: "execute", rawInput: { command: "npm test" } };
  assert.equal(toolCallName(verbose), "Bash");
  assert.equal(toolCallName({ name: "read_file", title: "Read the session side panel and compare every tool row" }), "read_file");
  assert.equal(toolCallName({ title: "Read" }, "previous"), "Read");
  assert.equal(toolCallName({ title: "Web search: marked", kind: "search", _meta: { backend: true } }), "WebSearch");
  assert.equal(toolCallName({ status: "completed" }, "read_file"), "read_file");
  assert.deepEqual(toolCallInput({ rawInput: { target_file: "a.ts" } }), { target_file: "a.ts", file_path: "a.ts" });
  const request = permissionRequest("1", "s", { toolCall: verbose, options: [] }, "t");
  assert.equal(request.toolName, "Bash");
  assert.equal(request.title, null);
  assert.equal(request.input.command, "npm test");
});

test("commands, mcp servers, history and permission options", () => {
  assert.equal(slashCommands([{ name: "compact", description: "Shrink", input: null }])[0]?.source, "builtin");
  assert.equal(slashCommands([{ name: "help", description: "Docs", input: { hint: "<topic>" }, _meta: { scope: "user" } }])[0]?.source, "custom");
  assert.deepEqual(acpMcpServers({
    local: { type: "stdio", command: "node", args: ["s.js"], env: { A: "1" } },
    remote: { type: "http", url: "http://127.0.0.1:9", headers: { Authorization: "nope" } },
  }), [
    { name: "local", command: "node", args: ["s.js"], env: [{ name: "A", value: "1" }] },
    { type: "http", name: "remote", url: "http://127.0.0.1:9", headers: [{ name: "Authorization", value: "nope" }] },
  ]);
  const entries = historyEntries([
    { type: "system", content: "hidden" },
    { type: "user", content: [{ type: "text", text: "hi" }] },
    { type: "assistant", content: "pong" },
  ]);
  assert.deepEqual(entries.map((entry) => entry.kind === "user" || entry.kind === "assistant" ? entry.text : entry.kind), ["hi", "pong"]);
  const options = [{ optionId: "once", kind: "allow_once" }, { optionId: "always", kind: "allow_always" }, { optionId: "no", kind: "reject_once" }];
  assert.equal(optionFor(options, "allow", "session"), "always");
  assert.equal(optionFor(options, "deny", "once"), "no");
  assert.equal(optionFor([{ optionId: "once", kind: "allow_once" }], "allow", "project"), "once");
});

test("native prompt envelopes hide scaffolding and preserve the actual query", () => {
  const entries = historyEntries([
    { type: "user", content: { type: "text", text: "<user_info>private rules</user_info><rules>hidden</rules>" } },
    { type: "user", synthetic_reason: "system_reminder", content: "hidden skills" },
    { type: "user", content: "<user_query>Fix this\n<system-reminder>hidden</system-reminder>\nplease</user_query>" },
    { type: "user", content: "The user interrupted the previous turn:\n<user_query>continue</user_query>\nResume previous work." },
    { type: "user", content: "Explain <example>XML</example>" },
    { type: "reasoning", encrypted_content: "opaque", summary: [] },
  ]);
  assert.deepEqual(entries.map(entry => "text" in entry ? entry.text : entry.kind), ["Fix this\n\nplease", "continue", "Explain <example>XML</example>"]);
});

test("native assistant tool calls keep their arguments, results and ordering", () => {
  const entries = historyEntries([
    { type: "assistant", content: "Reading", model_id: "grok-4.7", tool_calls: [{ id: "read", name: "read_file", arguments: '{"path":"a.ts"}' }, { id: "bad", name: "run", arguments: "invalid" }] },
    { type: "tool_result", tool_call_id: "read", content: "file contents" },
    { type: "tool_result", tool_call_id: "bad", content: "Tool execution was halted by the harness (user_cancel)" },
    { type: "tool_result", tool_call_id: "missing", content: "orphan" },
    { type: "assistant", content: "Done" },
  ]);
  assert.deepEqual(entries.map(entry => entry.kind), ["assistant", "tool", "tool", "assistant"]);
  assert.ok(entries[1]?.kind === "tool");
  assert.deepEqual(entries[1].input, { path: "a.ts" });
  assert.equal(entries[1].result?.text, "file contents");
  assert.ok(entries[2]?.kind === "tool");
  assert.equal(entries[2].result?.ok, false);
});

test("history keeps reasoning, web search, attachments and a dropped-image notice", () => {
  assert.equal(textOf({ type: "ListDir", NotFound: "missing" }), "missing");
  assert.equal(textOf({ type: "diff", path: "a.ts", oldText: "a", newText: "b" }), "a.ts\n---\na\n+++\nb");
  const entries = historyEntries([
    { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Look it up" }], encrypted_content: "opaque" },
    { type: "backend_tool_call", kind: { tool_type: "web_search", action: { type: "search", query: "marked", sources: [{ type: "url", url: "https://example.com" }] }, id: "ws_1" }, status: "completed" },
    {
      type: "user",
      content: [
        { type: "text", text: "<image_files>\n1. C:\\sessions\\assets\\image-1.png\n</image_files>\n\n<user_query>\nWhat color is <attachment name=\"red.png\" media-type=\"image/png\" /> it?\n</user_query>\n\n<system-reminder><image_dropped_notice>\nImage 1 was dropped before send: bad\n</image_dropped_notice>\n<attached_files>\n<file_contents path=\"/odin-attachment/notes.txt\" isFullFile=\"true\">\n1→PELICAN\n</file_contents>\n</attached_files></system-reminder>" },
        { type: "image", url: "data:image/png;base64,AAAA" },
      ],
    },
  ]);
  assert.equal(entries[0]?.kind, "thinking");
  if (entries[0]?.kind === "thinking") assert.equal(entries[0].text, "Look it up");
  assert.equal(entries[1]?.kind, "tool");
  if (entries[1]?.kind === "tool") {
    assert.equal(entries[1].name, "WebSearch");
    assert.equal(entries[1].id, "ws_1");
    assert.deepEqual(entries[1].input, { query: "marked" });
    assert.equal(entries[1].result?.text, "https://example.com");
  }
  assert.equal(entries[2]?.kind, "system");
  if (entries[2]?.kind === "system") assert.match(entries[2].text, /dropped before send/);
  assert.equal(entries[3]?.kind, "user");
  if (entries[3]?.kind === "user") {
    assert.equal(entries[3].text, "What color is  it?");
    assert.deepEqual(entries[3].attachments, [
      { name: "image-1.png", mediaType: "image/png" },
      { name: "notes.txt", mediaType: "text/plain" },
    ]);
  }
});


test("Grok permission options never broaden a once grant or infer opaque scope", () => {
  assert.equal(optionFor([{ optionId: "allow_always", kind: "allow_always" }], "allow", "once"), null);
  assert.equal(optionFor([{ optionId: "allow_mystery", kind: "unknown" }], "allow", "once"), null);
  assert.equal(optionFor([{ optionId: "x", kind: "allow_once" }], "allow", "session"), "x");
  assert.equal(optionFor([{ optionId: "reject_always", kind: "reject_always" }], "deny", "once"), null);
});
