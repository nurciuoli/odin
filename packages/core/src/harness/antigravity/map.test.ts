import assert from "node:assert/strict";
import { test } from "node:test";
import {
  toNativeMode,
  modelsFrom,
  usageFrom,
  permissionRequest,
  permissionOptions,
  optionFor,
  toolCallName,
  toolCallInput,
  toolResult,
  FALLBACK_MODELS,
} from "./map.ts";

test("toNativeMode maps permission modes to Antigravity native modes", () => {
  assert.equal(toNativeMode("plan"), "plan");
  assert.equal(toNativeMode("acceptEdits"), "accept-edits");
  assert.equal(toNativeMode("default"), "auto");
  assert.equal(toNativeMode("auto"), "auto");
  assert.equal(toNativeMode("bypassPermissions"), "auto");
});

test("modelsFrom extracts Gemini models and context windows", () => {
  const fallback = modelsFrom({});
  assert.equal(fallback.length, FALLBACK_MODELS.length);
  assert.equal(fallback[0]!.value, "gemini-3.8-flash");

  const custom = modelsFrom({
    models: [
      {
        id: "gemini-custom",
        name: "Custom Gemini",
        description: "Specialized model",
        contextWindow: 500000,
        _meta: { reasoningEffort: "high" },
      },
    ],
  });
  assert.equal(custom.length, 1);
  assert.equal(custom[0]!.value, "gemini-custom");
  assert.equal(custom[0]!.contextWindow, 500000);
  assert.equal(custom[0]!.defaultEffort, "high");
});

test("usageFrom maps token usage and computes totals", () => {
  const event = usageFrom(
    {
      _meta: {
        modelId: "gemini-3.8-flash",
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          reasoningTokens: 25,
          cachedReadTokens: 10,
          cacheCreationTokens: 5,
          costUsd: 0.05,
        },
      },
    },
    1000000,
  );
  assert.ok(event && event.type === "usage");
  assert.equal(event.model, "gemini-3.8-flash");
  assert.equal(event.usage.input, 100);
  assert.equal(event.usage.output, 75); // output + reasoning
  assert.equal(event.usage.cacheRead, 10);
  assert.equal(event.usage.cacheWrite, 5);
  assert.equal(event.costUsd, 0.05);
  assert.equal(event.contextWindow, 1000000);
});

test("toolCallName and toolCallInput normalize Antigravity tools", () => {
  assert.equal(toolCallName({ name: "read_file" }), "Read");
  assert.equal(toolCallName({ name: "edit_file" }), "Edit");
  assert.equal(toolCallName({ name: "run_command" }), "Bash");
  assert.equal(toolCallName({ name: "invoke_subagent" }), "Subagent");

  const input = toolCallInput({ rawInput: { Path: "C:\\test\\file.txt", CommandLine: "npm test" } });
  assert.equal(input.path, "C:\\test\\file.txt");
  assert.equal(input.command, "npm test");
});

test("permission options and selection", () => {
  const raw = [
    { optionId: "opt-1", kind: "allow_once" },
    { optionId: "opt-2", kind: "allow_always" },
    { optionId: "opt-3", kind: "reject_once" },
  ];
  const options = permissionOptions(raw);
  assert.equal(options.length, 3);
  assert.equal(optionFor(options, "allow", "once"), "opt-1");
  assert.equal(optionFor(options, "allow", "project"), "opt-2");
  assert.equal(optionFor(options, "deny", "once"), "opt-3");
});

test("permissionRequest detects questions and plans", () => {
  const reqQuestion = permissionRequest("1", "sess-1", { toolCall: { name: "ask_question", title: "Question" } }, "now");
  assert.equal(reqQuestion.kind, "question");

  const reqTool = permissionRequest("2", "sess-1", { toolCall: { name: "run_command", title: "Bash" } }, "now");
  assert.equal(reqTool.kind, "tool");
});
