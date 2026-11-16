import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_STATE, loadWindowState, saveWindowState, validateState } from "./window-state.ts";

const display = { x: 0, y: 0, width: 1920, height: 1040 };
const second = { x: 1920, y: 0, width: 1920, height: 1040 };

test("keeps an on-screen position", () => {
  assert.deepEqual(validateState({ x: 100, y: 50, width: 1000, height: 700, maximized: true }, [display]), {
    x: 100,
    y: 50,
    width: 1000,
    height: 700,
    maximized: true,
  });
});

test("drops a position off every display but keeps the size", () => {
  const s = validateState({ x: 2500, y: 100, width: 1000, height: 700 }, [display]);
  assert.deepEqual(s, { width: 1000, height: 700, maximized: false });
  assert.equal(validateState({ x: 2500, y: 100, width: 1000, height: 700 }, [display, second]).x, 2500);
  assert.equal(validateState({ x: 100, y: -500, width: 1000, height: 300 + 100 }, [display]).x, undefined);
});

test("garbage falls back to defaults", () => {
  assert.deepEqual(validateState("nope", [display]), DEFAULT_STATE);
  assert.deepEqual(validateState({ width: 10, height: Number.NaN, x: "1" }, [display]), DEFAULT_STATE);
});

test("round-trips through desktop.json and keeps other keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "odin-desktop-"));
  const file = join(dir, "desktop.json");
  assert.deepEqual(loadWindowState(file, [display]), DEFAULT_STATE);
  writeFileSync(file, JSON.stringify({ other: 1 }));
  saveWindowState(file, { x: 10, y: 10, width: 900, height: 600, maximized: false });
  assert.equal(JSON.parse(readFileSync(file, "utf8")).other, 1);
  assert.deepEqual(loadWindowState(file, [display]), { x: 10, y: 10, width: 900, height: 600, maximized: false });
});
