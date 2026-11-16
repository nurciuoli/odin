import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearRuntime, instanceId, readRuntime, writeRuntime } from "./runtime.ts";

function home(): string {
  return mkdtempSync(join(tmpdir(), "odin-runtime-"));
}

test("instanceId is created once and then reused", () => {
  const h = home();
  try {
    const id = instanceId(h);
    assert.match(id, /^[A-Za-z0-9_-]{16}$/);
    assert.equal(instanceId(h), id);
    assert.equal(readFileSync(join(h, "instance"), "utf8").trim(), id);
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test("instanceId keeps an id written by someone else and replaces garbage", () => {
  const h = home();
  try {
    writeFileSync(join(h, "instance"), "from-the-shell-123\n");
    assert.equal(instanceId(h), "from-the-shell-123");
    writeFileSync(join(h, "instance"), "<bad>");
    const id = instanceId(h);
    assert.notEqual(id, "<bad>");
    assert.equal(instanceId(h), id);
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test("runtime.json round-trips and is cleared only by its own process", () => {
  const h = home();
  try {
    assert.equal(readRuntime(h), null);
    const info = { port: 8795, pid: 42, instance: "abcdefgh", startedAt: "2026-11-15T00:00:00.000Z" };
    writeRuntime(h, info);
    assert.deepEqual(readRuntime(h), info);
    clearRuntime(h, 7);
    assert.deepEqual(readRuntime(h), info);
    clearRuntime(h, 42);
    assert.equal(readRuntime(h), null);
    writeFileSync(join(h, "runtime.json"), JSON.stringify({ port: "x", pid: 1, instance: "a" }));
    assert.equal(readRuntime(h), null);
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});
