import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerEvent } from "@odin/shared/events";
import { EventBus } from "./events.ts";

const hb = (at: string): ServerEvent => ({ type: "heartbeat", at });

test("batch holds events until fn returns and drops them on throw", () => {
  const bus = new EventBus();
  const seen: string[] = [];
  bus.subscribe((e) => seen.push((e as { at: string }).at));
  bus.batch(() => {
    bus.emit(hb("a"));
    bus.batch(() => bus.emit(hb("b")));
    assert.deepEqual(seen, []);
  });
  assert.deepEqual(seen, ["a", "b"]);
  assert.throws(() => bus.batch(() => { bus.emit(hb("c")); throw new Error("x"); }));
  bus.emit(hb("d"));
  assert.deepEqual(seen, ["a", "b", "d"]);
});
