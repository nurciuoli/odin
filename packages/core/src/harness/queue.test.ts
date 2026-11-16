import assert from "node:assert/strict";
import { test } from "node:test";
import { EventQueue } from "./queue.ts";
import { InputQueue } from "./claude/input.ts";

for (const Queue of [EventQueue, InputQueue]) {
  test(Queue.name + " drains before ending and ignores late events", async () => {
    const queue = new Queue<number>();
    queue.push(1); queue.push(2); queue.end(); queue.end(); queue.push(3);
    const entries: number[] = [];
    for await (const value of queue) entries.push(value);
    assert.deepEqual(entries, [1, 2]);
    assert.equal(queue.ended, true);
  });
  test(Queue.name + " wakes an idle consumer once on close", async () => {
    const queue = new Queue<number>();
    const iterator = queue[Symbol.asyncIterator]();
    const waiting = iterator.next();
    queue.end(); queue.end();
    assert.deepEqual(await waiting, { value: undefined, done: true });
    assert.deepEqual(await iterator.next(), { value: undefined, done: true });
  });
}

test("breaking a Claude input consumer ends further input", async () => {
  const queue = new InputQueue<number>(); queue.push(1);
  for await (const value of queue) { assert.equal(value, 1); break; }
  assert.equal(queue.ended, true);
});
