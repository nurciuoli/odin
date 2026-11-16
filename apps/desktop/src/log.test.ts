import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rotatingLog } from "./log.ts";

test("rotates past the limit and keeps one previous file", () => {
  const dir = mkdtempSync(join(tmpdir(), "odin-desktop-"));
  const file = join(dir, "desktop.log");
  writeFileSync(file, "x".repeat(90));
  const log = rotatingLog(file, { maxBytes: 100 });
  log.write("a".repeat(20)); // 110 > 100: rotate first
  assert.equal(readFileSync(file + ".1", "utf8"), "x".repeat(90));
  assert.equal(readFileSync(file, "utf8"), "a".repeat(20));
  log.write("b".repeat(90)); // rotate again, the oldest is dropped
  assert.equal(readFileSync(file + ".1", "utf8"), "a".repeat(20));
  assert.equal(readFileSync(file, "utf8"), "b".repeat(90));
});

test("line() stamps shell lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "odin-desktop-"));
  const file = join(dir, "sub", "desktop.log");
  const log = rotatingLog(file, { now: () => new Date(0) });
  log.line("hello");
  assert.equal(readFileSync(file, "utf8"), "[1970-01-01T00:00:00.000Z] [desktop] hello\n");
  assert.equal(existsSync(file + ".1"), false);
});
