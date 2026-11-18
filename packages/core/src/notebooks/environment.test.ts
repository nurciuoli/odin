import test from "node:test";
import assert from "node:assert/strict";
import { detectNotebookEnvironment, managedNotebookPython, notebookChildEnv, notebookCommand, notebookWslPath, parseWslDistros, provisionNotebookEnvironment } from "./environment.ts";

test("kernel subprocess environments retain model credentials but remove Odin's tokens", () => {
  assert.deepEqual(notebookChildEnv({ PATH: "bin", ODIN_INGEST_TOKEN: "secret", ODIN_HOME: "home", GITHUB_TOKEN: "gh", GH_TOKEN: "gh", JUPYTER_TOKEN: "jupyter", ANTHROPIC_API_KEY: "model" }), { PATH: "bin", ANTHROPIC_API_KEY: "model" });
});
test("WSL commands use argv and preserve literal hostile-looking arguments", () => {
  assert.equal(notebookWslPath("C:\\Users\\alex\\a b"), "/mnt/c/Users/alex/a b");
  assert.equal(notebookWslPath("\\\\wsl.localhost\\Ubuntu\\home\\alex"), "/home/alex");
  assert.deepEqual(notebookCommand({ kind: "wsl", distro: "Ubuntu" }, "python", ["a; touch x"]), { command: "wsl.exe", args: ["--distribution", "Ubuntu", "--exec", "python", "a; touch x"] });
  assert.throws(() => notebookWslPath("relative"));
});
test("detection prefers the existing project venv and never runs installation", async () => {
  const env = await detectNotebookEnvironment({ home: "/odin", cwd: "/repo", platform: "linux", exists: path => path.endsWith(".venv/bin/python"), run: async () => { throw new Error("must not run"); } });
  assert.equal(env.kind, "venv"); assert.equal(env.interpreter, "/repo/.venv/bin/python");
  assert.equal(env.needsSetup, true, "the managed Jupyter host still needs explicit setup");
});
test("Poetry detection queries its interpreter without modifying the environment", async () => {
  const calls: unknown[] = [];
  const env = await detectNotebookEnvironment({ home: "/odin", cwd: "/repo", platform: "linux", exists: path => path.endsWith("poetry.lock"), run: async spec => { calls.push(spec); return "/env/bin/python"; } });
  assert.equal(env.kind, "poetry"); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { command: "poetry", args: ["-C", "/repo", "env", "info", "--executable"] });
});
test("explicit provisioning leaves an existing environment's dependencies alone except ipykernel", async () => {
  const calls: string[][] = [];
  const env = await provisionNotebookEnvironment({ home: "/odin", cwd: "/repo", platform: "linux", exists: path => path.endsWith(".venv/bin/python"), run: async spec => { calls.push(spec.args); return ""; } });
  assert.equal(env.interpreter, "/repo/.venv/bin/python");
  assert.deepEqual(calls.at(-1), ["pip", "install", "--python", "/repo/.venv/bin/python", "ipykernel"]);
  assert.equal(calls.some(args => args.includes("pandas")), false);
});
test("conda detection uses the manifest's named environment without creating it", async () => {
  const calls: string[][] = [];
  const env = await detectNotebookEnvironment({ home: "/odin", cwd: "/repo", platform: "linux", exists: path => path.endsWith("environment.yml"), readText: () => "name: analysis\ndependencies:\n  - python\n", run: async spec => { calls.push(spec.args); return "/conda/analysis/bin/python"; } });
  assert.equal(env.kind, "conda"); assert.deepEqual(calls[0]!.slice(0, 3), ["run", "--name", "analysis"]);
});
test("explicit new environment provisioning includes the data science baseline", async () => {
  const calls: string[][] = [];
  const env = await provisionNotebookEnvironment({ home: "/odin", cwd: "/repo", platform: "linux", exists: () => false, run: async spec => { calls.push(spec.args); return ""; } });
  assert.equal(env.needsSetup, false);
  assert.ok(calls.some(args => args.includes("pandas") && args.includes("ipykernel")));
  assert.equal(managedNotebookPython("C:\\odin", { kind: "wsl", distro: "Ubuntu" }, "win32").startsWith("/mnt/c/odin/"), true);
});
test("setup works without uv, using python -m venv and pip", async () => {
  const calls: string[][] = [];
  const env = await provisionNotebookEnvironment({ home: "/odin", cwd: "/repo", platform: "linux", exists: () => false, run: async spec => {
    calls.push([spec.command, ...spec.args]);
    if (spec.command === "uv") throw new Error("uv missing");
    return "";
  } });
  assert.equal(env.needsSetup, false);
  assert.ok(calls.some(c => c[0] === "python3" && c.includes("venv")));
  assert.ok(calls.some(c => c.includes("pip") && c.includes("ipykernel") && !c.includes("uv")));
});
test("a missing Python is explained, not hidden behind a generic failure", async () => {
  await assert.rejects(provisionNotebookEnvironment({ home: "/odin", cwd: "/repo", platform: "linux", exists: () => false, run: async () => { throw new Error("nope"); } }), /Python 3 was not found/);
});
test("WSL distro lists parse UTF-16 output and skip docker's", () => {
  const raw = "U\0b\0u\0n\0t\0u\0 \0(\0D\0e\0f\0a\0u\0l\0t\0)\0\r\0\n\0d\0o\0c\0k\0e\0r\0-\0d\0e\0s\0k\0t\0o\0p\0\n\0D\0e\0b\0i\0a\0n\0";
  assert.deepEqual(parseWslDistros(raw), ["Ubuntu", "Debian"]);
});
