import { test } from "node:test";
import assert from "node:assert/strict";
import { codexSlashCommands, nativeSkills, parseCodexCommand } from "./commands.ts";

test("parseCodexCommand recognises /compact and the /review target forms", () => {
  assert.deepEqual(parseCodexCommand("/compact"), { kind: "compact" });
  assert.equal(parseCodexCommand("/compact now please"), null);
  assert.deepEqual(parseCodexCommand("/review"), { kind: "review", target: { type: "uncommittedChanges" } });
  assert.deepEqual(parseCodexCommand(" /review uncommitted"), { kind: "review", target: { type: "uncommittedChanges" } });
  assert.deepEqual(parseCodexCommand("/review branch main"), { kind: "review", target: { type: "baseBranch", branch: "main" } });
  assert.deepEqual(parseCodexCommand("/review commit abc1234 Fix it"), { kind: "review", target: { type: "commit", sha: "abc1234", title: "Fix it" } });
  assert.deepEqual(parseCodexCommand("/review the auth code"), { kind: "review", target: { type: "custom", instructions: "the auth code" } });
  assert.equal(parseCodexCommand("/deploy"), null);
  assert.equal(parseCodexCommand("review this"), null);
});

test("native skills skip disabled and duplicate entries; library wins clashes", () => {
  const native = nativeSkills({ data: [
    { skills: [{ name: "a", path: "/a", description: "long", shortDescription: "short" }, { name: "off", path: "/o", enabled: false }] },
    { skills: [{ name: "a", path: "/a2" }, { name: "lib", path: "/n" }] },
  ] });
  assert.deepEqual(native, [{ name: "a", path: "/a", description: "short" }, { name: "lib", path: "/n", description: "" }]);
  const list = codexSlashCommands([{ name: "lib", path: "/l", description: "mine" }, { name: "review", path: "/r" }], native);
  assert.deepEqual(list.map((c) => [c.name, c.source]), [["compact", "builtin"], ["review", "builtin"], ["lib", "library"], ["a", "custom"]]);
  assert.equal(nativeSkills(null).length, 0);
});
