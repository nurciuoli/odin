import { test } from "node:test";
import assert from "node:assert/strict";
import { channelFor, DEV, STABLE } from "./channel.ts";

test("the packaged app is stable and running from source is dev, with nothing shared", () => {
  assert.deepEqual(channelFor(true, {}), STABLE);
  assert.deepEqual(channelFor(false, {}), DEV);
  for (const k of ["productName", "appId", "home", "port"] as const) assert.notEqual(STABLE[k], DEV[k]);
});

test("ODIN_HOME and ODIN_PORT override the channel's folder and port", () => {
  const c = channelFor(false, { ODIN_HOME: "/tmp/x", ODIN_PORT: "9000" });
  assert.equal(c.home, "/tmp/x");
  assert.equal(c.port, 9000);
  assert.equal(c.appId, DEV.appId);
  assert.equal(channelFor(true, { ODIN_PORT: "nope" }).port, STABLE.port);
});
