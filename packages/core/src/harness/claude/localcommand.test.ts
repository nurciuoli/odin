import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { historyEntries } from "./history.ts";
import { parseLocalCommand } from "./localcommand.ts";
import { createMapState, mapMessage } from "./map.ts";

const INVOKE = "<command-name>/mcp</command-name>\n            <command-message>mcp</command-message>\n            <command-args></command-args>";
const STDOUT = "<local-command-stdout>No MCP servers loaded. See https://code.claude.com/docs/en/mcp</local-command-stdout>";

test("a slash command invocation reads as what the user typed", () => {
  assert.deepEqual(parseLocalCommand(INVOKE), { typed: "/mcp", outputs: [] });
  assert.equal(parseLocalCommand("<command-name>/model</command-name><command-message>model</command-message><command-args>opus</command-args>")?.typed, "/model opus");
  assert.equal(parseLocalCommand("<command-message>init</command-message>")?.typed, "/init");
});

test("local command output, caveats and shell wrappers are unwrapped", () => {
  assert.deepEqual(parseLocalCommand(STDOUT), { typed: null, outputs: [{ level: "info", text: "No MCP servers loaded. See https://code.claude.com/docs/en/mcp" }] });
  assert.deepEqual(parseLocalCommand("<system-reminder>x</system-reminder><local-command-caveat>Caveat: ignore</local-command-caveat>"), { typed: null, outputs: [] });
  assert.deepEqual(parseLocalCommand("<local-command-stderr>\u001b[31mboom\u001b[0m</local-command-stderr>"), { typed: null, outputs: [{ level: "error", text: "boom" }] });
  assert.deepEqual(parseLocalCommand("<bash-input>ls -la</bash-input>"), { typed: "!ls -la", outputs: [] });
  assert.deepEqual(parseLocalCommand("<bash-stdout>a\nb</bash-stdout><bash-stderr>warn &lt;x&gt;</bash-stderr>"), { typed: null, outputs: [{ level: "info", text: "a\nb" }, { level: "error", text: "warn <x>" }] });
});

test("a truncated wrapper still unwraps", () => {
  assert.deepEqual(parseLocalCommand("<local-command-stdout>partial"), { typed: null, outputs: [{ level: "info", text: "partial" }] });
});

test("user text that only mentions a wrapper is left alone", () => {
  for (const text of ["what is <command-name>?", "<command-name>/x</command-name> and then some words", "<local-command-stdout>a</local-command-stdout> hi", "<unknown>x</unknown>", ""]) {
    assert.equal(parseLocalCommand(text), null, text);
  }
});

test("history shows the command and its output instead of raw tags", () => {
  const messages = [
    { type: "user", uuid: "u1", message: { role: "user", content: INVOKE }, timestamp: "2026-01-01T00:00:00Z" },
    { type: "user", uuid: "u2", message: { role: "user", content: STDOUT }, timestamp: "2026-01-01T00:00:01Z" },
    { type: "user", uuid: "u3", message: { role: "user", content: [{ type: "text", text: "<local-command-caveat>Caveat</local-command-caveat>" }] } },
  ] as unknown as SessionMessage[];
  const entries = historyEntries(messages);
  assert.deepEqual(entries.map((e) => [e.kind, "text" in e ? e.text : null]), [["user", "/mcp"], ["system", "No MCP servers loaded. See https://code.claude.com/docs/en/mcp"]]);
  assert.equal(new Set(entries.map((e) => e.id)).size, entries.length);
});

test("live output of a local command becomes a system entry, never user text", () => {
  const events = mapMessage(createMapState(), { type: "user", uuid: "u9", message: { role: "user", content: STDOUT } });
  assert.deepEqual(events.map((e) => (e.type === "entry" ? [e.entry.kind, "text" in e.entry ? e.entry.text.slice(0, 7) : null] : e.type)), [["system", "No MCP "]]);
  assert.deepEqual(mapMessage(createMapState(), { type: "user", uuid: "u8", message: { role: "user", content: INVOKE } }), []);
});
