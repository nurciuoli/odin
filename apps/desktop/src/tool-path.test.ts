import { test } from "node:test";
import assert from "node:assert/strict";
import { buildToolPath, dedupePath, expandWindowsVars, parseRegPath } from "./tool-path.ts";

const USER_OUT = "\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\bin;C:\\Tools\\\r\n\r\n";
const MACHINE_OUT = "\r\nHKEY_LOCAL_MACHINE\\...\\Environment\r\n    Path    REG_SZ    C:\\Windows\\system32;c:\\tools\r\n";

test("parseRegPath reads REG_SZ and REG_EXPAND_SZ values", () => {
  assert.equal(parseRegPath(USER_OUT), "%USERPROFILE%\\bin;C:\\Tools\\");
  assert.equal(parseRegPath(MACHINE_OUT), "C:\\Windows\\system32;c:\\tools");
  assert.equal(parseRegPath(""), "");
});

test("expandWindowsVars is case-insensitive and keeps unknown names", () => {
  assert.equal(expandWindowsVars("%userprofile%\\x;%NOPE%", { USERPROFILE: "C:\\Users\\a" }), "C:\\Users\\a\\x;%NOPE%");
});

test("dedupePath ignores case and trailing slashes on Windows only", () => {
  assert.equal(dedupePath(["C:\\A", "c:\\a\\", "", "C:\\B"], "win32"), "C:\\A;C:\\B");
  assert.equal(dedupePath(["/a", "/A", "/a/"], "linux"), "/a:/A");
});

test("Windows: process PATH, then registry user and machine PATH, then install locations", async () => {
  const calls: string[][] = [];
  const got = await buildToolPath({
    platform: "win32",
    home: "C:\\Users\\a",
    env: { Path: "C:\\Windows\\System32;C:\\proc", USERPROFILE: "C:\\Users\\a", APPDATA: "C:\\Users\\a\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" },
    reg: async (args) => {
      calls.push(args);
      return args[1] === "HKCU\\Environment" ? USER_OUT : MACHINE_OUT;
    },
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ["query", "HKCU\\Environment", "/v", "Path"]);
  assert.deepEqual(got.split(";"), [
    "C:\\Windows\\System32",
    "C:\\proc",
    "C:\\Users\\a\\bin",
    "C:\\Tools\\",
    "C:\\Users\\a\\AppData\\Roaming\\npm",
    "C:\\Users\\a\\AppData\\Local\\Programs",
    "C:\\Users\\a\\.local\\bin",
  ]);
});

test("Windows: a failing reg query adds nothing", async () => {
  const got = await buildToolPath({ platform: "win32", home: "C:\\h", env: { PATH: "C:\\x" }, reg: async () => "" });
  assert.equal(got, "C:\\x;C:\\h\\.local\\bin");
});

test("POSIX: no registry, adds the usual locations", async () => {
  const got = await buildToolPath({ platform: "linux", home: "/home/a", env: { PATH: "/usr/bin:/usr/local/bin" }, reg: async () => assert.fail("no reg") });
  assert.equal(got, "/usr/bin:/usr/local/bin:/home/a/.npm-global/bin:/home/a/.local/bin:/opt/homebrew/bin");
});
