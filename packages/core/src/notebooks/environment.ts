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
  } catch { throw new Error("Notebook environment command failed; check that Python and uv are installed"); }
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
    return { kind: "venv", interpreter: projectPython, managedHostPython: host, needsSetup: !hostReady };
  if (location.kind === "wsl") {
    try {
      const found = await run(notebookCommand(location, "python3", ["-c", "import os,sys; p=sys.argv[1]; print(p if os.path.isfile(p) else '')", projectPython]));
      if (found) return { kind: "venv", interpreter: found, managedHostPython: host, needsSetup: !hostReady };
    } catch { /* Detection can still report missing environment. */ }
  }
  if (exists(join(cwd, "poetry.lock"))) {
    try {
      const interpreter = await run(notebookCommand(location, "poetry", ["-C", root, "env", "info", "--executable"]));
      if (interpreter) return { kind: "poetry", interpreter, managedHostPython: host, needsSetup: !hostReady };
    } catch { /* Offer explicit setup rather than creating anything. */ }
  }
  if (exists(join(cwd, "environment.yml")) || exists(join(cwd, "environment.yaml"))) {
    try {
      const readText = options.readText ?? (path => readFileSync(path, "utf8"));
      const manifest = exists(join(cwd, "environment.yml")) ? join(cwd, "environment.yml") : join(cwd, "environment.yaml");
      const name = /^name:\s*["']?([a-zA-Z0-9_.-]+)["']?\s*(?:#.*)?$/m.exec(readText(manifest))?.[1];
      const selector = name ? ["--name", name] : ["--prefix", location.kind === "wsl" ? posix.join(root, ".conda") : paths.join(root, ".conda")];
      const interpreter = await run(notebookCommand(location, "conda", ["run", ...selector, "python", "-c", "import sys;print(sys.executable)"]));
      if (interpreter) return { kind: "conda", interpreter, managedHostPython: host, needsSetup: !hostReady };
    } catch { /* Missing conda environments are never implicitly created. */ }
  }
  return { kind: exists(join(cwd, "uv.lock")) ? "uv" : "missing", interpreter: null, managedHostPython: host, needsSetup: true };
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
  await run(notebookCommand(location, "uv", ["venv", "--allow-existing", hostRoot]));
  await run(notebookCommand(location, "uv", ["pip", "install", "--python", hostPython, "jupyter-server>=2,<3", "jupyterlab>=4,<5"]));
  let detected = await detectNotebookEnvironment(options);
  if (!detected.interpreter) {
    const venv = location.kind === "wsl" ? posix.join(root, ".venv") : paths.join(root, ".venv");
    await run(notebookCommand(location, "uv", ["venv", venv]));
    const interpreter = location.kind === "wsl" ? posix.join(venv, "bin/python")
      : platform === "win32" ? paths.join(venv, "Scripts", "python.exe") : paths.join(venv, "bin", "python");
    await run(notebookCommand(location, "uv", ["pip", "install", "--python", interpreter, "ipykernel", ...(options.baseline === false ? [] : ["numpy", "pandas", "matplotlib", "seaborn", "scipy"])]));
    detected = { kind: "venv", interpreter, managedHostPython: hostPython, needsSetup: false };
  } else {
    await run(notebookCommand(location, "uv", ["pip", "install", "--python", detected.interpreter, "ipykernel"]));
  }
  return { ...detected, needsSetup: false };
}
