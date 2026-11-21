import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectNotebookEnvironment, listNotebookLocations, managedNotebookPython, notebookChildEnv, notebookCommand, notebookEnvironmentBootstrap, notebookKernelHint, notebookProjectEnvironment, notebookWslPath, parseWslDistros, probeNotebookEnvironment, provisionNotebookEnvironment } from "./environment.ts";

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
    if (spec.args.includes("--version")) return "Python 3.11.9";
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

test("notebook display metadata selects an installed Conda environment ahead of the Windows project venv", async () => {
  const conda = "C:\\Users\\Nick\\anaconda3\\Scripts\\conda.exe";
  const quant = "C:\\Users\\Nick\\anaconda3\\envs\\quant";
  const projectPython = "C:\\repo\\.venv\\Scripts\\python.exe";
  const registeredPython = "C:\\envs\\analysis\\python.exe";
  const options = {
    home: "C:\\odin", cwd: "C:\\repo\\research", projectRoot: "C:\\repo", platform: "win32" as const,
    env: { PATH: "C:\\Users\\Nick\\anaconda3\\Library\\bin" },
    exists: (path: string) => [conda, `${quant}\\python.exe`, projectPython].includes(path),
    run: async (spec: { command: string }) => {
      if (spec.command === conda) return JSON.stringify({ envs: [quant] });
      assert.equal(spec.command, "jupyter.exe");
      return JSON.stringify({ kernelspecs: {
        analysis: { spec: { argv: [registeredPython, "-Xfrozen_modules=off", "-m", "ipykernel_launcher", "-f", "{connection_file}"], language: "python", display_name: "Analysis" } },
        custom: { spec: { argv: [registeredPython, "script.py", "{connection_file}"], language: "python", display_name: "Custom" } },
      } });
    },
  };
  const hint = notebookKernelHint({ kernelspec: { name: "python3", display_name: "quant" } });
  const matched = await detectNotebookEnvironment({ ...options, hint });
  assert.equal(matched.interpreter, `${quant}\\python.exe`);
  assert.equal(matched.kind, "conda");
  assert.equal(matched.needsSetup, true);
  assert.equal(matched.cwd, options.cwd);
  assert.deepEqual(matched.candidates?.map(candidate => candidate.name), ["quant", "Project .venv", "Analysis"]);
  const generic = await detectNotebookEnvironment({ ...options, hint: { name: "python3" } });
  assert.equal(generic.interpreter, projectPython);
});

test("environment probe separates a broken managed host from a missing interpreter package", async () => {
  const options = {
    home: "/odin", cwd: "/repo", platform: "linux" as const, interpreter: "/repo/.venv/bin/python",
    exists: (_path: string) => true,
    run: async (spec: { command: string; args: string[] }) => {
      assert.deepEqual(spec.args.slice(0, 2), ["-EB", "-c"]);
      if (spec.command.startsWith("/odin/")) throw new Error("host stderr is never returned");
      assert.match(spec.args[2]!, /ipykernel/);
      return "missing-module";
    },
  };
  assert.deepEqual(await probeNotebookEnvironment(options), { hostStatus: "broken", kernelStatus: "missing-ipykernel" });
  assert.deepEqual(await probeNotebookEnvironment({ ...options, exists: () => false }), { hostStatus: "missing", kernelStatus: "missing" });
  assert.deepEqual(await probeNotebookEnvironment({
    ...options, interpreter: "python3", exists: () => false,
    run: async spec => { assert.equal(spec.command, "python3"); return "ready"; },
  }), { hostStatus: "missing", kernelStatus: "ready" });
});

test("repairing a broken Windows host can use Conda Python without reinstalling the ready kernel", async () => {
  const conda = "C:\\Users\\Nick\\anaconda3\\Scripts\\conda.exe";
  const basePython = "C:\\Users\\Nick\\anaconda3\\python.exe";
  const kernelPython = "C:\\Users\\Nick\\anaconda3\\envs\\quant\\python.exe";
  const hostPython = "C:\\odin\\jupyter\\native\\Scripts\\python.exe";
  const installed: string[][] = [];
  let hostRepaired = false;
  const environment = await provisionNotebookEnvironment({
    home: "C:\\odin", cwd: "C:\\repo", platform: "win32", interpreter: kernelPython,
    probe: true, env: { CONDA_EXE: conda }, exists: path => [conda, basePython, kernelPython, hostPython].includes(path),
    run: async spec => {
      if (spec.command === "uv" || spec.command === "py") throw new Error("missing");
      if (spec.command === basePython && spec.args[0] === "--version") return "Python 3.11.7";
      if (spec.command === kernelPython) return "ready";
      if (spec.command === hostPython && spec.args[0] === "-EB") return hostRepaired ? "ready" : "missing-module";
      if (spec.command === hostPython && spec.args.includes("pip")) hostRepaired = true;
      if (spec.args.includes("venv") || spec.args.includes("pip")) installed.push([spec.command, ...spec.args]);
      return "";
    },
  });
  assert.equal(environment.needsSetup, false);
  assert.equal(environment.hostStatus, "ready");
  assert.deepEqual(installed[0], [basePython, "-m", "venv", "C:\\odin\\jupyter\\native"]);
  assert.equal(installed.some(args => args.includes("ipykernel")), false);
});

test("detect lists alternate WSL locations without starting any distro", async () => {
  const locations = await listNotebookLocations({ platform: "win32", run: async spec => {
    assert.deepEqual(spec, { command: "wsl.exe", args: ["--list", "--quiet"] });
    return "Ubuntu\r\nUbuntu\r\ndocker-desktop\r\nDebian\r\n";
  } });
  assert.deepEqual(locations, [{ kind: "native" }, { kind: "wsl", distro: "Ubuntu" }, { kind: "wsl", distro: "Debian" }]);
});

test("project dotenv launch includes only opted-in names and excludes process control keys", () => {
  const root = mkdtempSync(join(tmpdir(), "odin-notebook-env-"));
  try {
    writeFileSync(join(root, ".env"), "FRED_API_KEY=example-secret\nOTHER_KEY=example-other");
    assert.equal(notebookProjectEnvironment(root), undefined);
    writeFileSync(join(root, "PROJECT.md"), "---\nnotebookEnv: [FRED_API_KEY, FRED_API_KEY, PATH, PYTHONPATH, github_token, ODIN_HOME, invalid-key]\n---\n");
    const environment = notebookProjectEnvironment(root);
    assert.deepEqual(environment, { path: join(root, ".env"), names: ["FRED_API_KEY"] });
    const bootstrap = notebookEnvironmentBootstrap(environment, () => "/project/.env");
    assert.match(bootstrap, /\/project\/\.env/);
    assert.match(bootstrap, /FRED_API_KEY/);
    assert.doesNotMatch(bootstrap, /example-secret|example-other|OTHER_KEY/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
