import assert from "node:assert/strict";
import test from "node:test";
import { findModel, type ModelInfo } from "./api.ts";

const m = (value: string, resolved: string | null): ModelInfo => ({ value, resolved, displayName: value, description: "" });

test("findModel: exact value first, then the alias that resolves to the id", () => {
  const models = [m("default", "claude-fable-5-2"), m("opus", "claude-opus-5-5"), m("fable", "claude-fable-5-2")];
  assert.equal(findModel(models, "opus")?.value, "opus");
  assert.equal(findModel(models, "claude-opus-5-5")?.value, "opus");
  assert.equal(findModel(models, " Claude-Opus-5-5 ")?.value, "opus");
  assert.equal(findModel(models, "fable")?.value, "fable");
  assert.equal(findModel(models, "claude-haiku-5-5"), undefined);
  assert.equal(findModel(models, null), undefined);
});
