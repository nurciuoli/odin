import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { planOpen, splitCommand, which, wslPath, type PlanDeps } from "./open.ts";

const win = (over: Partial<PlanDeps> = {}): PlanDeps => ({
  platform: "win32",
  which: () => null,
  isDirectory: (p) => !p.endsWith(".ts"),
  ...over,
});

test("files opens the path itself", () => {
  assert.deepEqual(planOpen("C:\\w\\p\\a.ts", "files", null, win()), { kind: "files", path: "C:\\w\\p\\a.ts" });
});

test("terminal on Windows: Windows Terminal, else PowerShell, in the file's folder", () => {
  const plan = planOpen("C:\\w\\p\\a.ts", "terminal", null, win());
  assert.equal(plan.kind, "spawn");
  if (plan.kind !== "spawn") return;
  assert.equal(plan.attempts[0]!.cmd, "wt.exe");
  assert.equal(plan.attempts[0]!.args[1]!.toLowerCase(), "c:\\w\\p");
  assert.equal(plan.attempts[1]!.cmd, "powershell.exe");
});

test("terminal for a WSL project opens its distro at the Linux path", () => {
  assert.deepEqual(wslPath("\\\\wsl.localhost\\Ubuntu\\home\\me\\proj"), { distro: "Ubuntu", linuxPath: "/home/me/proj" });
  assert.deepEqual(wslPath("\\\\wsl$\\Debian"), { distro: "Debian", linuxPath: "/" });
  assert.equal(wslPath("C:\\x"), null);
  const plan = planOpen("\\\\wsl$\\Ubuntu\\home\\me\\proj", "terminal", null, win());
  if (plan.kind !== "spawn") throw new Error("expected spawn");
  assert.deepEqual(plan.attempts[1], { cmd: "wsl.exe", args: ["-d", "Ubuntu", "--cd", "/home/me/proj"] });
});

test("editor runs the configured command with argv; default code", () => {
  const plan = planOpen("/w/p", "editor", '"/opt/my editor/ed" --wait', { platform: "linux", which: () => null, isDirectory: () => true });
  assert.deepEqual(plan, { kind: "spawn", attempts: [{ cmd: "/opt/my editor/ed", args: ["--wait", "/w/p"], cwd: "/w/p" }] });
  const def = planOpen("/w/p", "editor", null, { platform: "linux", which: () => "/usr/bin/code", isDirectory: () => true });
  if (def.kind !== "spawn") throw new Error("expected spawn");
  assert.equal(def.attempts[0]!.cmd, "/usr/bin/code");
});

test("a .cmd editor shim on Windows runs through cmd.exe, refusing cmd metacharacters", () => {
  const deps = win({ which: () => "C:\\bin\\code.cmd" });
  const plan = planOpen("C:\\w\\p", "editor", "code", deps);
  if (plan.kind !== "spawn") throw new Error("expected spawn");
  const a = plan.attempts[0]!;
  assert.match(a.cmd, /cmd\.exe$/i);
  assert.deepEqual(a.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(a.args[3], '""C:\\bin\\code.cmd" "C:\\w\\p""');
  assert.equal(a.verbatim, true);
  assert.throws(() => planOpen("C:\\w\\a&calc", "editor", "code", deps), /cmd\.exe/);
});

test("splitCommand handles quotes and empty", () => {
  assert.deepEqual(splitCommand("code -n"), ["code", "-n"]);
  assert.deepEqual(splitCommand(`"C:\\Program Files\\E\\e.exe"  --x 'a b'`), ["C:\\Program Files\\E\\e.exe", "--x", "a b"]);
  assert.deepEqual(splitCommand("   "), []);
});

test("which searches PATH with PATHEXT on Windows", () => {
  const exists = (p: string) => p === join("C:\\b", "code.cmd");
  assert.equal(which("code", { PATH: "C:\\a;C:\\b", PATHEXT: ".EXE;.CMD" }, "win32", exists), join("C:\\b", "code.cmd"));
  assert.equal(which("nope", { PATH: "C:\\a" }, "win32", exists), null);
});
