import { test } from "node:test";
import assert from "node:assert/strict";
import { slashCommandsFromNames, slashCommandsFromSdk } from "./commands.ts";

test("SDK commands keep details, hide Odin-owned ones and prefer built-ins", () => {
  const list = slashCommandsFromSdk([
    { name: "compact", description: "Compact", argumentHint: "<instructions>", builtin: true },
    { name: "review", description: "Plugin review" },
    { name: "review", description: "Built-in review", builtin: true },
    { name: "review", description: "Later plugin" },
    { name: "context", description: "Usage", aliases: ["ctx", "new"] },
    { name: "clear" }, { name: "model" }, { name: "send" }, { name: "now" }, { name: "__debug" }, { name: "" }, null,
  ]);
  assert.deepEqual(list, [
    { name: "compact", description: "Compact", argumentHint: "<instructions>", source: "builtin" },
    { name: "review", description: "Built-in review", argumentHint: "", source: "builtin" },
    { name: "context", description: "Usage", argumentHint: "", aliases: ["ctx"], source: "custom" },
  ]);
  assert.deepEqual(slashCommandsFromNames(["/init", "rename", 3]), [{ name: "init", description: "", argumentHint: "", source: "custom" }]);
});
