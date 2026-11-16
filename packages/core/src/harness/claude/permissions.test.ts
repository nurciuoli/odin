import { test } from "node:test";
import assert from "node:assert/strict";
import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import { cancelledResult, DEFAULT_DENY_MESSAGE, toPermissionRequest, toPermissionResult } from "./permissions.ts";
import recording from "./fixtures/sdk-recording.json" with { type: "json" };

const AT = "2026-11-11T00:00:00.000Z";
const rec = recording.canUseToolCall;
const recSuggestions = rec.options.suggestions as PermissionUpdate[];

test("the recorded canUseTool call becomes a tool PermissionRequest", () => {
  const r = toPermissionRequest("s1", rec.toolName, rec.input, { ...rec.options, suggestions: recSuggestions }, AT);
  assert.deepEqual(r, {
    id: "2630c5f0-034c-4ef6-8289-c8cf3eb670cb",
    sessionId: "s1",
    kind: "tool",
    toolName: "Write",
    toolUseId: "toolu_012b7v5WB4odyw4fC1Kiqv9p",
    input: { file_path: "/fixture/proj/hello.txt", content: "hi\n" },
    title: null,
    description: null,
    canAlwaysAllow: true,
    defaultToDeny: false,
    createdAt: AT,
  });
});

test("title, description, suppressAlwaysAllowRule and defaultToNo carry over", () => {
  const r = toPermissionRequest("s1", "Bash", { command: "rm -rf x" }, {
    requestId: "r1",
    toolUseID: "t1",
    title: "Claude wants to run rm -rf x",
    description: "Delete x",
    suppressAlwaysAllowRule: true,
    defaultToNo: true,
  }, AT);
  assert.equal(r.title, "Claude wants to run rm -rf x");
  assert.equal(r.description, "Delete x");
  assert.equal(r.canAlwaysAllow, false);
  assert.equal(r.defaultToDeny, true);
});

test("ExitPlanMode → plan, AskUserQuestion → question", () => {
  assert.equal(toPermissionRequest("s", "ExitPlanMode", { plan: "1." }, { requestId: "a", toolUseID: "b" }, AT).kind, "plan");
  assert.equal(toPermissionRequest("s", "AskUserQuestion", { questions: [] }, { requestId: "a", toolUseID: "b" }, AT).kind, "question");
});

test("allow once: the input (or updatedInput), user_temporary, no permission updates", () => {
  const input = { file_path: "a" };
  assert.deepEqual(toPermissionResult({ behavior: "allow", scope: "once" }, "Write", input, recSuggestions), {
    behavior: "allow",
    updatedInput: input,
    decisionClassification: "user_temporary",
  });
  // Plan approval with an edited plan; question answers.
  assert.deepEqual(toPermissionResult({ behavior: "allow", scope: "once", updatedInput: { plan: "edited" } }, "ExitPlanMode", { plan: "1." }), {
    behavior: "allow",
    updatedInput: { plan: "edited" },
    decisionClassification: "user_temporary",
  });
  const answers = { questions: [{ question: "Which?" }], answers: { "Which?": "A" } };
  const q = toPermissionResult({ behavior: "allow", scope: "once", updatedInput: answers }, "AskUserQuestion", { questions: [{ question: "Which?" }] });
  assert.equal(q.behavior === "allow" && q.updatedInput, answers);
});

test("allow for the session with only a setMode suggestion: a rule for the tool plus the mode change", () => {
  assert.deepEqual(toPermissionResult({ behavior: "allow", scope: "session" }, "Write", rec.input, recSuggestions), {
    behavior: "allow",
    updatedInput: rec.input,
    updatedPermissions: [
      { type: "addRules", rules: [{ toolName: "Write" }], behavior: "allow", destination: "session" },
      { type: "setMode", mode: "acceptEdits", destination: "session" },
    ],
    decisionClassification: "user_permanent",
  });
});

const mixed: PermissionUpdate[] = [
  { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }], behavior: "allow", destination: "localSettings" },
  { type: "setMode", mode: "acceptEdits", destination: "session" },
  { type: "addDirectories", directories: ["/tmp/x"], destination: "session" },
];

for (const [scope, destination] of [["project", "projectSettings"], ["local", "localSettings"], ["user", "userSettings"]] as const) {
  test(`allow with scope ${scope}: addRules suggestions re-targeted to ${destination}; no setMode`, () => {
    assert.deepEqual(toPermissionResult({ behavior: "allow", scope }, "Bash", { command: "npm test" }, mixed), {
      behavior: "allow",
      updatedInput: { command: "npm test" },
      updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }], behavior: "allow", destination }],
      decisionClassification: "user_permanent",
    });
  });
}

test("allow with scope session: addRules re-targeted to session plus setMode", () => {
  const r = toPermissionResult({ behavior: "allow", scope: "session" }, "Bash", { command: "npm test" }, mixed);
  assert.deepEqual(r.behavior === "allow" && r.updatedPermissions, [
    { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }], behavior: "allow", destination: "session" },
    { type: "setMode", mode: "acceptEdits", destination: "session" },
  ]);
});

test("allow with a scope and no suggestions: one rule for the tool", () => {
  const r = toPermissionResult({ behavior: "allow", scope: "user" }, "WebFetch", { url: "x" });
  assert.deepEqual(r.behavior === "allow" && r.updatedPermissions, [{ type: "addRules", rules: [{ toolName: "WebFetch" }], behavior: "allow", destination: "userSettings" }]);
});

test("deny: message (default when empty), interrupt, user_reject", () => {
  assert.deepEqual(toPermissionResult({ behavior: "deny", message: "not that file", interrupt: true }, "Write", {}), {
    behavior: "deny",
    message: "not that file",
    interrupt: true,
    decisionClassification: "user_reject",
  });
  assert.deepEqual(toPermissionResult({ behavior: "deny" }, "Write", {}), {
    behavior: "deny",
    message: DEFAULT_DENY_MESSAGE,
    interrupt: false,
    decisionClassification: "user_reject",
  });
  assert.equal(cancelledResult().behavior, "deny");
});
