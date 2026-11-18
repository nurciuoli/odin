import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import { promisify } from "node:util";
import type { KernelLocation } from "@odin/shared/notebooks";

export interface EnvironmentCommand { command: string; args: string[] }
export interface NotebookEnvironment {
  kind: "venv" | "uv" | "poetry" | "conda" | "missing";
  interpreter: string | null;
  managedHostPython: string;
  needsSetup: boolean;
  /** Where this environment runs: the caller's choice, or what auto-detection settled on. */
  location: KernelLocation;
}
export function notebookChildEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env))
    if (/^(ODIN_|GITHUB_TOKEN$|GH_TOKEN$|JUPYTER_TOKEN$|JUPYTER_TOKEN_FILE$)/i.test(key)) delete env[key];
  return env;
}
export function notebookWslPath(path: string): string {
  if (path.startsWith("/")) return path;
  const drive = /^([a-z]):[\\/](.*)$/i.exec(path);
  if (drive) return `/mnt/${drive[1]!.toLowerCase()}/${drive[2]!.replace(/\\/g, "/")}`;
  const unc = /^\\\\(?:wsl\$|wsl\.localhost)\\[^\\]+(\\.*)$/i.exec(path);
  if (unc) return unc[1]!.replace(/\\/g, "/");
  throw new Error("Notebook WSL paths must be absolute");
}
export function notebookCommand(location: KernelLocation, command: string, args: string[]): EnvironmentCommand {
  if (!command || command.includes("\0") || args.some(arg => arg.includes("\0"))) throw new Error("Invalid notebook command");
  if (location.kind === "native") return { command, args };
  if (!location.distro || /[\0\r\n]/.test(location.distro)) throw new Error("A WSL distribution is required");
  return { command: "wsl.exe", args: ["--distribution", location.distro, "--exec", command, ...args] };
}
export function managedNotebookPython(home: string, location: KernelLocation, platform = process.platform): string {
  const segment = location.kind === "native" ? "native" : `wsl-${Buffer.from(location.distro).toString("hex")}`;
  const paths = platform === "win32" ? win32 : posix;
  const base = paths.join(home, "jupyter", segment);
  return location.kind === "wsl" ? posix.join(notebookWslPath(base), "bin", "python")
    : platform === "win32" ? win32.join(base, "Scripts", "python.exe") : posix.join(base, "bin", "python");
}
export type RunEnvironmentCommand = (spec: EnvironmentCommand, cwd?: string) => Promise<string>;
async function executeEnvironmentCommand(spec: EnvironmentCommand, cwd: string | undefined, timeout: number): Promise<string> {
  try {
    const result = await promisify(execFile)(spec.command, spec.args, {
      cwd, env: notebookChildEnv(), windowsHide: true, timeout, maxBuffer: 1024 * 1024,
    });
    return result.stdout.trim();
  } catch (error) {
    const detail = String((error as { stderr?: unknown }).stderr ?? "").trim().split(/\r?\n/).filter(Boolean).slice(-2).join(" ").slice(0, 300);
    throw new Error(detail ? `Notebook environment command failed: ${detail}` : "Notebook environment command failed; check that Python is installed");
  }
}
export const runEnvironmentCommand: RunEnvironmentCommand = (spec, cwd) => executeEnvironmentCommand(spec, cwd, 15 * 60_000);
export const runDetectionCommand: RunEnvironmentCommand = (spec, cwd) => executeEnvironmentCommand(spec, cwd, 5_000);
export interface DetectEnvironmentOptions {
  home: string; cwd: string; location?: KernelLocation; platform?: NodeJS.Platform;
  exists?: (path: string) => boolean; run?: RunEnvironmentCommand;
  readText?: (path: string) => string;
}
export async function detectNotebookEnvironment(options: DetectEnvironmentOptions): Promise<NotebookEnvironment> {
  const { home, cwd } = options;
  const location = options.location ?? { kind: "native" };
  const exists = options.exists ?? existsSync;
  const run = options.run ?? runDetectionCommand;
  const platform = options.platform ?? process.platform;
  const paths = platform === "win32" ? win32 : posix;
  const root = location.kind === "wsl" ? notebookWslPath(cwd) : cwd;
  const host = managedNotebookPython(home, location, platform);
  let hostReady = location.kind === "native" && exists(host);
  if (location.kind === "wsl") {
    try { hostReady = await run(notebookCommand(location, "python3", ["-c", "import os,sys; print('1' if os.path.isfile(sys.argv[1]) else '0')", host])) === "1"; }
    catch { hostReady = false; }
  }
  const projectPython = location.kind === "wsl" ? posix.join(root, ".venv/bin/python")
    : platform === "win32" ? paths.join(root, ".venv", "Scripts", "python.exe") : paths.join(root, ".venv", "bin", "python");
  if (location.kind === "native" && exists(projectPython))
    return { kind: "venv", interpreter: projectPython, managedHostPython: host, needsSetup: !hostReady, location };
  if (location.kind === "wsl") {
    try {
      const found = await run(notebookCommand(location, "python3", ["-c", "import os,sys; p=sys.argv[1]; print(p if os.path.isfile(p) else '')", projectPython]));
      if (found) return { kind: "venv", interpreter: found, managedHostPython: host, needsSetup: !hostReady, location };
    } catch { /* Detection can still report missing environment. */ }
  }
  if (exists(join(cwd, "poetry.lock"))) {
    try {
      const interpreter = await run(notebookCommand(location, "poetry", ["-C", root, "env", "info", "--executable"]));
      if (interpreter) return { kind: "poetry", interpreter, managedHostPython: host, needsSetup: !hostReady, location };
    } catch { /* Offer explicit setup rather than creating anything. */ }
  }
  if (exists(join(cwd, "environment.yml")) || exists(join(cwd, "environment.yaml"))) {
    try {
      const readText = options.readText ?? (path => readFileSync(path, "utf8"));
      const manifest = exists(join(cwd, "environment.yml")) ? join(cwd, "environment.yml") : join(cwd, "environment.yaml");
      const name = /^name:\s*["']?([a-zA-Z0-9_.-]+)["']?\s*(?:#.*)?$/m.exec(readText(manifest))?.[1];
      const selector = name ? ["--name", name] : ["--prefix", location.kind === "wsl" ? posix.join(root, ".conda") : paths.join(root, ".conda")];
      const interpreter = await run(notebookCommand(location, "conda", ["run", ...selector, "python", "-c", "import sys;print(sys.executable)"]));
      if (interpreter) return { kind: "conda", interpreter, managedHostPython: host, needsSetup: !hostReady, location };
    } catch { /* Missing conda environments are never implicitly created. */ }
  }
  return { kind: exists(join(cwd, "uv.lock")) ? "uv" : "missing", interpreter: null, managedHostPython: host, needsSetup: true, location };
}

/** The first of these that answers `--version` is the Python that builds new environments. */
function basePythons(location: KernelLocation, platform: NodeJS.Platform): EnvironmentCommand[] {
  if (location.kind === "wsl") return [{ command: "python3", args: [] }];
  return platform === "win32"
    ? [{ command: "py", args: ["-3"] }, { command: "python", args: [] }, { command: "python3", args: [] }]
    : [{ command: "python3", args: [] }, { command: "python", args: [] }];
}
async function succeeds(run: RunEnvironmentCommand, spec: EnvironmentCommand): Promise<boolean> {
  try { await run(spec); return true; } catch { return false; }
}
async function findBasePython(location: KernelLocation, platform: NodeJS.Platform, run: RunEnvironmentCommand): Promise<EnvironmentCommand | null> {
  for (const candidate of basePythons(location, platform)) {
    const probe = notebookCommand(location, candidate.command, [...candidate.args, "--version"]);
    if (await succeeds(run, probe)) return candidate;
  }
  return null;
}
/** `uv` when it is installed, else the Python that is: setup needs only Python, not a toolchain the person must add. */
async function environmentTools(location: KernelLocation, platform: NodeJS.Platform, run: RunEnvironmentCommand) {
  const uv = await succeeds(run, notebookCommand(location, "uv", ["--version"]));
  const base = uv ? null : await findBasePython(location, platform, run);
  if (!uv && !base) throw new Error(location.kind === "wsl"
    ? `Python 3 was not found in WSL (${location.distro}). Install it there with: sudo apt install python3 python3-venv`
    : "Python 3 was not found. Install it from python.org (or install uv), then try again.");
  return {
    venv: (dir: string) => uv ? notebookCommand(location, "uv", ["venv", "--allow-existing", dir])
      : notebookCommand(location, base!.command, [...base!.args, "-m", "venv", dir]),
    install: (python: string, packages: string[]) => uv ? notebookCommand(location, "uv", ["pip", "install", "--python", python, ...packages])
      : notebookCommand(location, python, ["-m", "pip", "install", "--disable-pip-version-check", ...packages]),
  };
}

/** Only call after an explicit setup action. Existing project dependencies are never upgraded. */
export async function provisionNotebookEnvironment(options: DetectEnvironmentOptions & { baseline?: boolean }): Promise<NotebookEnvironment> {
  const location = options.location ?? { kind: "native" };
  const run = options.run ?? runEnvironmentCommand;
  const platform = options.platform ?? process.platform;
  const paths = platform === "win32" ? win32 : posix;
  const hostPython = managedNotebookPython(options.home, location, platform);
  const root = location.kind === "wsl" ? notebookWslPath(options.cwd) : options.cwd;
  const hostRoot = location.kind === "wsl" ? posix.dirname(posix.dirname(hostPython)) : paths.dirname(paths.dirname(hostPython));
  const tools = await environmentTools(location, platform, run);
  await run(tools.venv(hostRoot));
  await run(tools.install(hostPython, ["jupyter-server>=2,<3", "jupyterlab>=4,<5"]));
  let detected = await detectNotebookEnvironment(options);
  if (!detected.interpreter) {
    const venv = location.kind === "wsl" ? posix.join(root, ".venv") : paths.join(root, ".venv");
    await run(tools.venv(venv));
    const interpreter = location.kind === "wsl" ? posix.join(venv, "bin/python")
      : platform === "win32" ? paths.join(venv, "Scripts", "python.exe") : paths.join(venv, "bin", "python");
    await run(tools.install(interpreter, ["ipykernel", ...(options.baseline === false ? [] : ["numpy", "pandas", "matplotlib", "seaborn", "scipy"])]));
    detected = { kind: "venv", interpreter, managedHostPython: hostPython, needsSetup: false, location };
  } else {
    await run(tools.install(detected.interpreter, ["ipykernel"]));
  }
  return { ...detected, needsSetup: false, location };
}

/** Distros `wsl.exe` knows, default first. Its list output is UTF-16, and docker's internal distros are not for Python. */
export function parseWslDistros(output: string): string[] {
  return output.replace(/\0/g, "").split(/\r?\n/).map(line => line.replace(/\(Default\)/i, "").trim())
    .filter(name => /^[A-Za-z0-9_.-]{1,100}$/.test(name) && !/^docker-desktop/i.test(name));
}
async function wslDistros(run: RunEnvironmentCommand): Promise<string[]> {
  try { return parseWslDistros(await run({ command: "wsl.exe", args: ["--list", "--quiet"] })); } catch { return []; }
}
/**
 * Where Python should run when the person did not say. Everywhere but Windows that is the machine itself. On Windows
 * it is the machine too, unless it has no usable Python and a WSL distro does.
 */
export async function chooseNotebookLocation(options: DetectEnvironmentOptions & { forSetup?: boolean }): Promise<KernelLocation> {
  if (options.location) return options.location;
  const platform = options.platform ?? process.platform;
  const native: KernelLocation = { kind: "native" };
  if (platform !== "win32") return native;
  const run = options.run ?? runDetectionCommand;
  const found = await detectNotebookEnvironment({ ...options, location: native, run });
  if (found.interpreter || await findBasePython(native, platform, run) || await succeeds(run, { command: "uv", args: ["--version"] })) return native;
  for (const distro of await wslDistros(run)) {
    const wsl: KernelLocation = { kind: "wsl", distro };
    if (await succeeds(run, notebookCommand(wsl, "python3", ["--version"]))) return wsl;
  }
  return native;
}
