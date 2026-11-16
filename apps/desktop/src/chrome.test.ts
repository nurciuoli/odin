import { test } from "node:test";
import assert from "node:assert/strict";
import { hidesMenuBar, shellCommand, windowChrome, TITLE_BAR_HEIGHT, type KeyInput } from "./chrome.ts";

const down = (key: string, extra: Partial<KeyInput> = {}): KeyInput => ({
  type: "keyDown",
  key,
  control: false,
  meta: false,
  alt: false,
  shift: false,
  ...extra,
});

test("Windows and Linux hide the menu and overlay the app header", () => {
  for (const platform of ["win32", "linux"] as const) {
    assert.equal(hidesMenuBar(platform), true);
    const chrome = windowChrome(platform);
    assert.equal(chrome.titleBarStyle, "hidden");
    assert.equal(chrome.autoHideMenuBar, true);
    assert.equal(chrome.titleBarOverlay?.height, TITLE_BAR_HEIGHT);
    assert.equal(chrome.titleBarOverlay?.color, "#121211");
    assert.equal(chrome.titleBarOverlay?.symbolColor, "#eceae4");
  }
});

test("macOS keeps the system title bar and menu", () => {
  assert.equal(hidesMenuBar("darwin"), false);
  const chrome = windowChrome("darwin");
  assert.equal(chrome.titleBarStyle, "default");
  assert.equal(chrome.titleBarOverlay, undefined);
  assert.equal(chrome.autoHideMenuBar, false);
});

test("edit, view and quit shortcuts survive a hidden menu", () => {
  assert.equal(shellCommand(down("c", { control: true })), "copy");
  assert.equal(shellCommand(down("v", { meta: true })), "paste");
  assert.equal(shellCommand(down("z", { control: true, shift: true })), "redo");
  assert.equal(shellCommand(down("y", { control: true })), "redo");
  assert.equal(shellCommand(down("a", { control: true })), "selectAll");
  assert.equal(shellCommand(down("r", { control: true })), "reload");
  assert.equal(shellCommand(down("R", { control: true, shift: true })), "forceReload");
  assert.equal(shellCommand(down("I", { control: true, shift: true })), "toggleDevTools");
  assert.equal(shellCommand(down("F12")), "toggleDevTools");
  assert.equal(shellCommand(down("=", { control: true })), "zoomIn");
  assert.equal(shellCommand(down("-", { control: true })), "zoomOut");
  assert.equal(shellCommand(down("0", { control: true })), "resetZoom");
  assert.equal(shellCommand(down("F11")), "toggleFullscreen");
  assert.equal(shellCommand(down("q", { control: true })), "quit");
});

test("page keys and key-ups are left alone", () => {
  assert.equal(shellCommand(down("k", { control: true })), null);
  assert.equal(shellCommand(down("c", { control: true, shift: true })), null);
  assert.equal(shellCommand(down("c", { control: true, alt: true })), null);
  assert.equal(shellCommand(down("c")), null);
  assert.equal(shellCommand(down("c", { control: true, type: "keyUp" })), null);
  assert.equal(shellCommand(down("q", { control: true, isAutoRepeat: true })), null);
  assert.equal(shellCommand(down("c", { control: true, isComposing: true })), null);
});
