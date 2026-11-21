import { execFile } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import { promisify } from "node:util";
import type { KernelLocation, NotebookEnvironment, NotebookKernelCandidate, NotebookKernelHint } from "@odin/shared/notebooks";
import { parseFrontmatter } from "../frontmatter.ts";

export interface EnvironmentCommand { command: string; args: string[] }
export type { NotebookEnvironment } from "@odin/shared/notebooks";
export function notebookChildEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env))
    if (/^(ODIN_|GITHUB_TOKEN$|GH_TOKEN$|JUPYTER_TOKEN$|JUPYTER_TOKEN_FILE$)/i.test(key)) delete env[key];
  return env;
}

export interface NotebookProjectEnvironment { path: string; names: string[] }

const reservedNotebookEnv = /^(?:ODIN_|GH_TOKEN$|GITHUB_TOKEN$|JUPYTER_|IPYTHON|PYTHON|CONDA_|VIRTUAL_ENV|PATH$|PATHEXT$|SYSTEMROOT$|COMSPEC$|HOME$|USERPROFILE$|LD_|DYLD_|NODE_)/i;

/** The project can name keys from its .env. Core never reads their values. */
export function notebookProjectEnvironment(root: string): NotebookProjectEnvironment | undefined {
  const manifest = join(root, "PROJECT.md");
  let parsed: ReturnType<typeof parseFrontmatter>;
  try {
    const stat = lstatSync(manifest);
    if (!stat.isFile() || stat.size > 64 * 1024) return;
    parsed = parseFrontmatter(readFileSync(manifest, "utf8"), "PROJECT.md");
  } catch { return; }
  const names = parsed.data?.notebookEnv;
  if (parsed.errors.length || !Array.isArray(names)) return;
  const allowed = [...new Set(names.filter((name): name is string => typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(name) && !reservedNotebookEnv.test(name)))].slice(0, 64);
  if (allowed.length) return { path: join(root, ".env"), names: allowed };
}

/** A small dotenv subset. Read only a bounded regular file. Existing process values take precedence. */
export function notebookEnvironmentBootstrap(environment: NotebookProjectEnvironment | undefined, nativePath: (path: string) => string): string {
  if (!environment) return "";
  return `
def _odin_project_environment():
 import os, re, stat
 path = ${JSON.stringify(nativePath(environment.path))}
 try:
  entry = os.lstat(path)
  if not stat.S_ISREG(entry.st_mode):
   return
  flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0)
  with os.fdopen(os.open(path, flags), 'rb') as stream:
   if not os.path.samestat(entry, os.fstat(stream.fileno())):
    return
   raw = stream.read(65537)
  if len(raw) > 65536:
   return
  lines = raw.decode('utf-8-sig').splitlines()
 except (OSError, UnicodeError):
  return
 values = {}
 allowed = ${JSON.stringify(environment.names)}
 for line in lines:
  match = re.fullmatch(r'\\s*(?:export\\s+)?([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(.*)', line)
  if not match or match[1] not in allowed:
   continue
  value = match[2].strip()
  if value.startswith(('"', "'")):
   quoted = re.fullmatch(r'''(["'])(.*?)\\1\\s*(?:#.*)?''', value)
   if not quoted:
    continue
   value = quoted[2]
  else:
   value = value.split('#', 1)[0].rstrip()
  if '\\x00' not in value:
   values[match[1]] = value
 for key, value in values.items():
  os.environ.setdefault(key, value)
_odin_project_environment()
del _odin_project_environment
`;
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
    const failure = error as NodeJS.ErrnoException & { killed?: boolean };
    const reason = failure.killed ? "timed out" : failure.code === "ENOENT" ? "was not found" : "failed";
    throw new Error(`Notebook environment command ${reason}`);
  }
}
export const runEnvironmentCommand: RunEnvironmentCommand = (spec, cwd) => executeEnvironmentCommand(spec, cwd, 15 * 60_000);
export const runDetectionCommand: RunEnvironmentCommand = (spec, cwd) => executeEnvironmentCommand(spec, cwd, 5_000);
export interface DetectEnvironmentOptions {
  home: string; cwd: string; location?: KernelLocation; platform?: NodeJS.Platform;
  projectRoot?: string;
  exists?: (path: string) => boolean; run?: RunEnvironmentCommand;
  readText?: (path: string) => string;
  env?: NodeJS.ProcessEnv;
  hint?: NotebookKernelHint;
  interpreter?: string;
  discover?: boolean;
  probe?: boolean;
}

function namedCondaCommand(options: DetectEnvironmentOptions): string {
  if (options.location?.kind === "wsl" || (options.platform ?? process.platform) !== "win32") return "conda";
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const candidates = [env.CONDA_EXE];
  for (const entry of (env.Path ?? env.PATH ?? "").split(";").filter(Boolean)) {
    const directory = entry.replace(/^"|"$/g, "");
    candidates.push(win32.join(directory, "conda.exe"));
    if (/[/\\]Library[/\\]bin[/\\]?$/i.test(directory)) candidates.push(win32.join(directory, "..", "..", "Scripts", "conda.exe"));
    if (win32.basename(directory).toLowerCase() === "condabin") candidates.push(win32.join(directory, "..", "Scripts", "conda.exe"));
  }
  if (env.USERPROFILE) for (const name of ["anaconda3", "miniconda3", "miniforge3"]) {
    candidates.push(win32.join(env.USERPROFILE, name, "Scripts", "conda.exe"));
  }
  return candidates.find(value => value && win32.isAbsolute(value) && /\.exe$/i.test(value) && exists(value)) ?? "conda.exe";
}

const genericKernelName = /^(?:python(?:[\s._-]*\d+(?:\.\d+)*)?|ipykernel)$/i;
function hintNames(hint?: DetectEnvironmentOptions["hint"]): string[] {
  return [hint?.name, hint?.displayName].flatMap(name => typeof name === "string" && name.trim() && !genericKernelName.test(name.trim()) ? [name.trim().toLowerCase()] : []);
}

export function notebookKernelHint(metadata: Record<string, unknown>): NotebookKernelHint | undefined {
  const spec = metadata.kernelspec as { name?: unknown; display_name?: unknown } | undefined;
  const label = (value: unknown) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120) : undefined;
  const name = label(spec?.name);
  const displayName = label(spec?.display_name);
  return name || displayName ? { name, displayName } : undefined;
}

type InstalledCandidate = NotebookKernelCandidate & { id?: string };
async function installedCandidates(options: DetectEnvironmentOptions, location: KernelLocation): Promise<InstalledCandidate[]> {
  const run = options.run ?? runDetectionCommand;
  const nativeWindows = location.kind === "native" && (options.platform ?? process.platform) === "win32";
  const paths = nativeWindows ? win32 : posix;
  const execute = async (command: string, args: string[]) => {
    try { return JSON.parse(await run(notebookCommand(location, command, args))); }
    catch { return null; }
  };
  const findKernelspecs = async () => {
    const installed = await execute(nativeWindows ? "jupyter.exe" : "jupyter", ["kernelspec", "list", "--json"]);
    if (installed) return installed;
    const host = managedNotebookPython(options.home, location, options.platform);
    if (location.kind === "native" && !(options.exists ?? existsSync)(host)) return null;
    const script = "import json; from jupyter_client.kernelspec import KernelSpecManager; print(json.dumps({'kernelspecs': KernelSpecManager().get_all_specs()}))";
    return await execute(host, ["-IB", "-c", script]);
  };
  const [jupyter, conda] = await Promise.all([
    findKernelspecs(),
    execute(namedCondaCommand({ ...options, location }), ["env", "list", "--json"]),
  ]);
  const candidates: InstalledCandidate[] = [];
  for (const [id, value] of Object.entries(jupyter?.kernelspecs ?? {}).slice(0, 100)) {
    const spec = (value as { spec?: { argv?: string[]; language?: string; display_name?: string; env?: Record<string, string> } } | null)?.spec;
    const argv = spec?.argv;
    // Odin reconstructs the launcher with the notebook cwd. Only advertise the Python launchers it can reproduce.
    if (spec?.language !== "python" || (spec.env && Object.keys(spec.env).length) || !Array.isArray(argv) || typeof argv[0] !== "string" || !paths.isAbsolute(argv[0]) ||
      !(argv.length === 5 || (argv.length === 6 && argv[1] === "-Xfrozen_modules=off")) ||
      !/^python(?:[0-9.]+)?(?:\.exe)?$/i.test(paths.basename(argv[0])) || argv[argv.length - 4] !== "-m" ||
      !["ipykernel", "ipykernel_launcher"].includes(argv[argv.length - 3]!) || argv.at(-2) !== "-f" || argv.at(-1) !== "{connection_file}") continue;
    const name = typeof spec.display_name === "string" ? spec.display_name.slice(0, 100).trim() || id : id;
    candidates.push({ kind: "kernelspec", name, interpreter: argv[0], location, id });
  }
  for (const prefix of (Array.isArray(conda?.envs) ? conda.envs.slice(0, 100) : [])) {
    if (typeof prefix !== "string" || !paths.isAbsolute(prefix)) continue;
    const interpreter = paths.join(prefix, nativeWindows ? "python.exe" : "bin/python");
    if (location.kind === "native" && !(options.exists ?? existsSync)(interpreter)) continue;
    candidates.push({ kind: "conda", name: paths.basename(prefix), interpreter, location });
  }
  return candidates;
}

async function detectProjectEnvironment(options: DetectEnvironmentOptions): Promise<NotebookEnvironment> {
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
      const interpreter = await run(notebookCommand(location, namedCondaCommand(options), ["run", ...selector, "python", "-c", "import sys;print(sys.executable)"]));
      if (interpreter) return { kind: "conda", interpreter, managedHostPython: host, needsSetup: !hostReady, location };
    } catch { /* Missing conda environments are never implicitly created. */ }
  }
  return { kind: exists(join(cwd, "uv.lock")) ? "uv" : "missing", interpreter: null, managedHostPython: host, needsSetup: true, location };
}

type NotebookEnvironmentHealth = Required<Pick<NotebookEnvironment, "hostStatus" | "kernelStatus">>;
export async function probeNotebookEnvironment(options: DetectEnvironmentOptions): Promise<NotebookEnvironmentHealth> {
  const location = options.location ?? { kind: "native" };
  const run = options.run ?? runDetectionCommand;
  const host = managedNotebookPython(options.home, location, options.platform);
  const exists = options.exists ?? existsSync;
  async function probe(python: string | undefined, module: string): Promise<"ready" | "missing" | "broken" | "missing-module"> {
    if (!python) return "missing";
    // Older notebook records can store a PATH command such as "python".
    const isPath = /[/\\]/.test(python);
    if (isPath && location.kind === "native" && !exists(python)) return "missing";
    if (isPath && location.kind === "wsl") {
      try {
        const found = await run(notebookCommand(location, "python3", ["-I", "-c", "import os,sys; print(os.path.isfile(sys.argv[1]))", python]));
        if (found === "False") return "missing";
      } catch { /* Try the selected interpreter even when python3 is unavailable. */ }
    }
    const script = `import sys\nif sys.path and sys.path[0] == '':\n sys.path.pop(0)\nimport importlib, importlib.util\nname = '${module}'\nif importlib.util.find_spec(name) is None:\n print('missing-module')\nelse:\n importlib.import_module(name)\n print('ready')`;
    try {
      const output = await run(notebookCommand(location, python, ["-EB", "-c", script]));
      const result = output.trim().split(/\r?\n/).at(-1);
      return result === "ready" || result === "missing-module" ? result : "broken";
    } catch { return "broken"; }
  }
  const [hostProbe, kernelProbe] = await Promise.all([probe(host, "jupyter_server.serverapp"), probe(options.interpreter, "ipykernel")]);
  return {
    hostStatus: hostProbe === "missing-module" ? "broken" : hostProbe,
    kernelStatus: kernelProbe === "missing-module" ? "missing-ipykernel" : kernelProbe,
  };
}

export async function detectNotebookEnvironment(options: DetectEnvironmentOptions): Promise<NotebookEnvironment> {
  const hint = hintNames(options.hint);
  const list = !!options.discover || hint.length > 0 || !!options.interpreter;
  const location = options.location ?? { kind: "native" };
  const detectProject = async () => {
    const local = await detectProjectEnvironment(options);
    if (local.interpreter || !options.projectRoot || options.projectRoot === options.cwd) return local;
    const project = await detectProjectEnvironment({ ...options, cwd: options.projectRoot });
    return project.kind === "missing" ? local : project;
  };
  const [project, initiallyInstalled] = await Promise.all([
    detectProject(),
    list ? installedCandidates(options, location) : undefined,
  ]);
  const installed = initiallyInstalled ?? (!project.interpreter && options.discover !== false ? await installedCandidates(options, location) : undefined);
  if (!installed && !options.probe) return project;
  const projectCandidate = project.interpreter && (project.kind === "venv" || project.kind === "poetry" || project.kind === "conda")
    ? { kind: project.kind, name: project.kind === "venv" ? "Project .venv" : project.kind === "poetry" ? "Project Poetry" : "Project Conda", interpreter: project.interpreter, location } satisfies NotebookKernelCandidate
    : undefined;
  const nativeWindows = location.kind === "native" && (options.platform ?? process.platform) === "win32";
  const key = (path: string) => nativeWindows ? win32.normalize(path).toLowerCase() : posix.normalize(path);
  const preferred = hint.map(name => installed?.find(candidate => candidate.name.toLowerCase() === name || candidate.id?.toLowerCase() === name)).find(Boolean);
  const candidates = new Map<string, NotebookKernelCandidate>();
  for (const candidate of [preferred, projectCandidate, ...(installed ?? [])]) {
    if (candidate && !candidates.has(key(candidate.interpreter))) {
      const { kind, name, interpreter } = candidate;
      candidates.set(key(interpreter), { kind, name, interpreter, location });
    }
  }
  const chosen = options.interpreter
    ? candidates.get(key(options.interpreter)) ?? { kind: "python" as const, name: "Selected Python", interpreter: options.interpreter, location }
    : preferred ?? projectCandidate;
  if (chosen && !candidates.has(key(chosen.interpreter))) candidates.set(key(chosen.interpreter), chosen);
  const interpreter = chosen?.interpreter ?? null;
  const health = options.probe ? await probeNotebookEnvironment({ ...options, interpreter: interpreter ?? undefined }) : undefined;
  return {
    ...project, ...health, interpreter, kind: chosen?.kind ?? project.kind, candidates: [...candidates.values()], cwd: options.cwd,
    needsSetup: health ? health.hostStatus !== "ready" || health.kernelStatus !== "ready" : project.needsSetup,
  };
}

/** The first of these that answers `--version` is the Python that builds new environments. */
function basePythons(location: KernelLocation, options: DetectEnvironmentOptions): EnvironmentCommand[] {
  if (location.kind === "wsl") return [{ command: "python3", args: [] }];
  if ((options.platform ?? process.platform) !== "win32") return [{ command: "python3", args: [] }, { command: "python", args: [] }];
  const conda = namedCondaCommand({ ...options, location });
  const condaPython = win32.isAbsolute(conda) ? win32.join(win32.dirname(conda), "..", "python.exe") : null;
  return [
    { command: "py", args: ["-3"] },
    ...(condaPython && (options.exists ?? existsSync)(condaPython) ? [{ command: condaPython, args: [] }] : []),
    { command: "python", args: [] },
    { command: "python3", args: [] },
  ];
}
async function succeeds(run: RunEnvironmentCommand, spec: EnvironmentCommand): Promise<boolean> {
  try { await run(spec); return true; } catch { return false; }
}
async function findBasePython(location: KernelLocation, options: DetectEnvironmentOptions, run: RunEnvironmentCommand): Promise<EnvironmentCommand | null> {
  for (const candidate of basePythons(location, options)) {
    const probe = notebookCommand(location, candidate.command, [...candidate.args, "--version"]);
    try {
      if (/^Python 3\.\d+\.\d+\b/.test(await run(probe))) return candidate;
    } catch { /* Try the next executable. */ }
  }
  return null;
}
/** `uv` when it is installed, else the Python that is: setup needs only Python, not a toolchain the person must add. */
async function environmentTools(location: KernelLocation, options: DetectEnvironmentOptions, run: RunEnvironmentCommand) {
  const uv = await succeeds(run, notebookCommand(location, "uv", ["--version"]));
  const base = uv ? null : await findBasePython(location, options, run);
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
  const cwd = options.projectRoot ?? options.cwd;
  const root = location.kind === "wsl" ? notebookWslPath(cwd) : cwd;
  const hostRoot = location.kind === "wsl" ? posix.dirname(posix.dirname(hostPython)) : paths.dirname(paths.dirname(hostPython));
  let detected = await detectNotebookEnvironment(options);
  if (!detected.needsSetup) return detected;
  if (detected.interpreter && (detected.kernelStatus === "broken" || detected.kernelStatus === "missing")) {
    throw new Error("The selected Python interpreter could not start. Choose a different kernel or repair that Python environment.");
  }
  const tools = await environmentTools(location, options, run);
  if (detected.hostStatus !== "ready") {
    try {
      await run(tools.venv(hostRoot));
      await run(tools.install(hostPython, ["jupyter-server>=2,<3", "jupyterlab>=4,<5"]));
    } catch {
      throw new Error("Installing the managed Jupyter host failed. Check that Python and the package index are reachable.");
    }
  }
  if (!detected.interpreter) {
    const venv = location.kind === "wsl" ? posix.join(root, ".venv") : paths.join(root, ".venv");
    const interpreter = location.kind === "wsl" ? posix.join(venv, "bin/python")
      : platform === "win32" ? paths.join(venv, "Scripts", "python.exe") : paths.join(venv, "bin", "python");
    try {
      await run(tools.venv(venv));
      await run(tools.install(interpreter, ["ipykernel", ...(options.baseline === false ? [] : ["numpy", "pandas", "matplotlib", "seaborn", "scipy"])]));
    } catch {
      throw new Error("Creating the project Python environment failed. Check that the project is writable and the package index is reachable.");
    }
    detected = { ...detected, kind: "venv", interpreter };
  } else if (detected.kernelStatus !== "ready") {
    try { await run(tools.install(detected.interpreter, ["ipykernel"])); }
    catch { throw new Error("Installing ipykernel in the selected Python environment failed"); }
  }
  if (options.probe && detected.interpreter) {
    const verified = await detectNotebookEnvironment({ ...options, interpreter: detected.interpreter });
    if (verified.hostStatus !== "ready") throw new Error("The managed Jupyter host is still unavailable after setup");
    if (verified.kernelStatus !== "ready") throw new Error("The selected interpreter could not load ipykernel after setup");
    return verified;
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
export async function listNotebookLocations(options: Pick<DetectEnvironmentOptions, "platform" | "run"> = {}): Promise<KernelLocation[]> {
  const locations: KernelLocation[] = [{ kind: "native" }];
  if ((options.platform ?? process.platform) === "win32") {
    for (const distro of new Set(await wslDistros(options.run ?? runDetectionCommand))) locations.push({ kind: "wsl", distro });
  }
  return locations;
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
  const found = await detectNotebookEnvironment({ ...options, interpreter: undefined, discover: false, probe: false, location: native, run });
  if (found.interpreter || await findBasePython(native, options, run) || await succeeds(run, { command: "uv", args: ["--version"] })) return native;
  for (const distro of await wslDistros(run)) {
    const wsl: KernelLocation = { kind: "wsl", distro };
    if (await succeeds(run, notebookCommand(wsl, "python3", ["--version"]))) return wsl;
  }
  return native;
}
