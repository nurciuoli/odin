// How to open a checked path in a target (docs/desktop.md#open-in-editor--terminal--files). Pure planning: returns argv lists, never a
// shell string. main.ts runs them with spawn (or shell.openPath for files).
import { statSync } from "node:fs";
import { dirname, extname, join, posix, win32 } from "node:path";

export type OpenTarget = "editor" | "terminal" | "files";

export interface Command {
  cmd: string;
  args: string[];
  cwd?: string;
  /** Pass args to the process as written (windowsVerbatimArguments); only for the cmd.exe shim case. */
  verbatim?: boolean;
}

export type OpenPlan =
  | { kind: "files"; path: string }
  /** Try each command in turn until one spawns. */
  | { kind: "spawn"; attempts: Command[] };

export const DEFAULT_EDITOR = "code";

/** `\\wsl$\Ubuntu\home\me\x` or `\\wsl.localhost\Ubuntu\home\me\x` → distro and Linux path. */
export function wslPath(p: string): { distro: string; linuxPath: string } | null {
  const m = /^[\\/]{2}(?:wsl\$|wsl\.localhost)[\\/]([^\\/]+)(.*)$/i.exec(p);
  if (!m) return null;
  const rest = m[2]!.replace(/\\/g, "/");
  return { distro: m[1]!, linuxPath: rest ? posix.normalize(rest) : "/" };
}

/** Split an editor command like `code -n` or `"C:\Program Files\Editor\ed.exe" --wait` into argv. No expansion. */
export function splitCommand(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  for (const ch of command.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

/** Characters cmd.exe would interpret when a .cmd/.bat shim runs; such paths are refused for those shims. */
const CMD_META = /["&|<>^%!\r\n]/;

export interface PlanDeps {
  platform: NodeJS.Platform;
  /** Resolve a bare command on PATH (with PATHEXT on Windows); null when not found. */
  which(cmd: string): string | null;
  /** Is the path a directory? */
  isDirectory(p: string): boolean;
}

export function planOpen(path: string, target: OpenTarget, editorCommand: string | null | undefined, deps: PlanDeps): OpenPlan {
  const dir = deps.isDirectory(path) ? path : (deps.platform === "win32" ? win32.dirname : dirname)(path);
  if (target === "files") return { kind: "files", path };

  if (target === "terminal") {
    const wsl = deps.platform === "win32" ? wslPath(dir) : null;
    if (wsl) {
      const inWsl = ["wsl.exe", "-d", wsl.distro, "--cd", wsl.linuxPath];
      return {
        kind: "spawn",
        attempts: [
          { cmd: "wt.exe", args: ["-d", ".", ...inWsl] },
          { cmd: inWsl[0]!, args: inWsl.slice(1) },
        ],
      };
    }
    if (deps.platform === "win32") {
      return {
        kind: "spawn",
        attempts: [
          { cmd: "wt.exe", args: ["-d", dir] },
          { cmd: "powershell.exe", args: ["-NoExit"], cwd: dir },
        ],
      };
    }
    if (deps.platform === "darwin") return { kind: "spawn", attempts: [{ cmd: "open", args: ["-a", "Terminal", dir] }] };
    return { kind: "spawn", attempts: [{ cmd: "x-terminal-emulator", args: [], cwd: dir }] };
  }

  const argv = splitCommand(editorCommand?.trim() || DEFAULT_EDITOR);
  if (!argv.length) throw new Error("no editor command configured");
  const [bin, ...rest] = argv as [string, ...string[]];
  const resolved = deps.which(bin) ?? bin;
  const ext = extname(resolved).toLowerCase();
  if (deps.platform === "win32" && (ext === ".cmd" || ext === ".bat")) {
    // Node will not spawn a .cmd shim without a shell; run it through cmd.exe with argv, refusing any argument cmd
    // would interpret.
    const all = [resolved, ...rest, path];
    if (all.some((a) => CMD_META.test(a))) throw new Error("path or editor command has characters cmd.exe would interpret");
    const comspec = join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
    // cmd /s /c "<line>": the outer quotes are stripped and the rest runs as one line, each argument quoted.
    const line = `"${all.map((a) => `"${a}"`).join(" ")}"`;
    return { kind: "spawn", attempts: [{ cmd: comspec, args: ["/d", "/s", "/c", line], cwd: dir, verbatim: true }] };
  }
  return { kind: "spawn", attempts: [{ cmd: resolved, args: [...rest, path], cwd: dir }] };
}

/** Find a bare command on PATH (PATHEXT on Windows). Paths with a directory part are returned as given. */
export function which(
  cmd: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = isFile,
): string | null {
  if (/[\\/]/.test(cmd)) return exists(cmd) ? cmd : null;
  const win = platform === "win32";
  const dirs = (env.PATH ?? env.Path ?? "").split(win ? ";" : ":").filter(Boolean);
  const exts = win && !extname(cmd) ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const d of dirs)
    for (const e of exts) {
      const p = join(d, cmd + e.toLowerCase());
      if (exists(p)) return p;
    }
  return null;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
