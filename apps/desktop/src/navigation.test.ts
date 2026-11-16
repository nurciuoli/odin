import { test } from "node:test";
import assert from "node:assert/strict";
import { isCoreUrl, isExternalOpenable } from "./navigation.ts";
import { errorPage } from "./error-page.ts";

const origin = "http://127.0.0.1:8790";

test("only the core origin is navigable", () => {
  assert.equal(isCoreUrl("http://127.0.0.1:8790/s/abc", origin), true);
  assert.equal(isCoreUrl("http://localhost:8790/", origin), false);
  assert.equal(isCoreUrl("http://127.0.0.1:8791/", origin), false);
  assert.equal(isCoreUrl("https://github.com/x/y/pull/1", origin), false);
  assert.equal(isCoreUrl("not a url", origin), false);
});

test("only web links go to the system browser", () => {
  assert.equal(isExternalOpenable("https://github.com/"), true);
  assert.equal(isExternalOpenable("file:///C:/Windows/system32/calc.exe"), false);
  assert.equal(isExternalOpenable("javascript:alert(1)"), false);
});

test("error page escapes its text", () => {
  assert.doesNotMatch(errorPage("<script>", "a&b", false), /<script>|Restart/);
});
