import { test } from "node:test";
import assert from "node:assert/strict";
import { notifier, sessionIdFromUrl } from "./notify.ts";
import type { SessionLite } from "./counts.ts";

const on = { notifyOnWaiting: true, notifyOnFinished: true };
const away = { focused: false, sessionId: null };
const s = (id: string, state: string, extra: Partial<SessionLite> = {}): SessionLite => ({ id, title: `T ${id}`, state, ...extra });

test("one notification per waiting episode, titles only", () => {
  const n = notifier();
  assert.equal(n.observe(s("a", "running"), on, away), null);
  assert.deepEqual(n.observe(s("a", "waiting", { waitingFor: "permission" }), on, away), {
    kind: "waiting",
    sessionId: "a",
    title: "T a",
    body: "Wants your permission",
  });
  assert.equal(n.observe(s("a", "waiting"), on, away), null, "repeated update");
  assert.deepEqual(n.seed([s("a", "waiting")], on, away), [], "reconnect");
  n.observe(s("a", "running"), on, away);
  assert.equal(n.observe(s("a", "waiting"), on, away)?.kind, "waiting", "new episode");
});

test("no notification for the session the focused window shows; the episode still counts as seen", () => {
  const n = notifier();
  assert.equal(n.observe(s("a", "waiting"), on, { focused: true, sessionId: "a" }), null);
  assert.equal(n.observe(s("a", "waiting"), on, away), null);
  assert.equal(n.observe(s("b", "waiting"), on, { focused: true, sessionId: "a" })?.sessionId, "b");
});

test("notifyOnWaiting off suppresses waiting notifications", () => {
  const n = notifier();
  assert.equal(n.observe(s("a", "waiting"), { ...on, notifyOnWaiting: false }, away), null);
});

test("finished notifies only when the window is hidden or unfocused, and only from a live state", () => {
  const n = notifier();
  n.observe(s("a", "running"), on, away);
  assert.equal(n.observe(s("a", "idle"), on, away)?.kind, "finished");
  assert.equal(n.observe(s("a", "idle"), on, away), null, "already idle");
  n.observe(s("b", "running"), on, away);
  assert.equal(n.observe(s("b", "ended"), on, { focused: true, sessionId: null }), null);
  n.observe(s("c", "running"), on, away);
  assert.equal(n.observe(s("c", "failed"), { ...on, notifyOnFinished: false }, away), null);
  assert.equal(n.observe(s("d", "idle"), on, away), null, "first sight of an idle session");
  n.observe(s("e", "waiting"), on, away);
  assert.equal(n.observe(s("e", "failed"), on, away)?.body, "Stopped with an error");
});

test("a session missing from a reseed is forgotten, so its next waiting episode notifies", () => {
  const n = notifier();
  n.observe(s("a", "waiting"), on, away);
  n.seed([], on, away);
  assert.equal(n.seed([s("a", "waiting")], on, away).length, 1);
});

test("side threads and archived sessions never notify", () => {
  const n = notifier();
  assert.equal(n.observe(s("a", "waiting", { aside: true }), on, away), null);
  assert.equal(n.observe(s("b", "waiting", { archived: true }), on, away), null);
});

test("session id from the window URL", () => {
  assert.equal(sessionIdFromUrl("http://127.0.0.1:8790/s/abc-1?x=1"), "abc-1");
  assert.equal(sessionIdFromUrl("http://127.0.0.1:8790/s/abc/files"), "abc");
  assert.equal(sessionIdFromUrl("http://127.0.0.1:8790/"), null);
  assert.equal(sessionIdFromUrl("not a url"), null);
});
