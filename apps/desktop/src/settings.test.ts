import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SHORTCUT, openRoots, readShellSettings } from "./settings.ts";
import { launcherShortcut } from "./shortcut.ts";

test("missing settings take the defaults; null shortcut means off", () => {
  assert.deepEqual(readShellSettings({ settings: { notifyOnWaiting: false } }), {
    notifyOnWaiting: false,
    notifyOnFinished: true,
    launcherShortcut: DEFAULT_SHORTCUT,
    editorCommand: null,
  });
  assert.equal(readShellSettings({ settings: { launcherShortcut: null } }).launcherShortcut, null);
  assert.equal(readShellSettings({ settings: { launcherShortcut: " Alt+O " } }).launcherShortcut, "Alt+O");
  assert.equal(readShellSettings({ settings: { editorCommand: "cursor" } }).editorCommand, "cursor");
  assert.equal(readShellSettings("junk").notifyOnFinished, true);
});

test("open roots: project paths plus the worktrees dir", () => {
  assert.deepEqual(openRoots([{ path: "/a" }, { name: "x" }, null, { path: "" }], "/h/worktrees"), ["/a", "/h/worktrees"]);
  assert.deepEqual(openRoots({ error: "x" }, "/h/worktrees"), ["/h/worktrees"]);
});

test("shortcut registers, swaps, turns off and reports failure", () => {
  const registered = new Set<string>();
  const gs = {
    register: (a: string) => {
      if (a === "Taken") return false;
      if (a === "Bad") throw new Error("bad accelerator");
      registered.add(a);
      return true;
    },
    unregister: (a: string) => void registered.delete(a),
  };
  const sc = launcherShortcut(gs, () => {});
  assert.deepEqual(sc.apply("Ctrl+A"), { accelerator: "Ctrl+A", registered: true });
  sc.apply("Ctrl+B");
  assert.deepEqual([...registered], ["Ctrl+B"]);
  const taken = sc.apply("Taken");
  assert.equal(taken.registered, false);
  assert.match(taken.error ?? "", /Another app/);
  assert.equal(registered.size, 0);
  assert.match(sc.apply("Bad").error ?? "", /valid/);
  assert.deepEqual(sc.apply(null), { accelerator: null, registered: false });
  assert.deepEqual(sc.status(), { accelerator: null, registered: false });
});
