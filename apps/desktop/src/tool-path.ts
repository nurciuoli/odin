// The PATH core runs with (docs/desktop.md#finding-the-tools). A GUI-launched app does not get the
// shell's PATH, so add the registry PATH (Windows) and the usual install locations. Pure apart from injected deps.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

/** Runs `reg` with argv; resolves stdout ("" on failure). */
export type RegQuery = (args: string[]) => Promise<string>;

export interface ToolPathDeps {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  home?: string;
  reg?: RegQuery;
}

const USER_KEY = "HKCU\\Environment";
const MACHINE_KEY = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";

export const defaultReg: RegQuery = (args) =>
  new Promise((resolve) => {
    execFile("reg", args, { windowsHide: true, timeout: 5000 }, (err, stdout) => resolve(err ? "" : String(stdout)));
  });

/** The Path value from `reg query <key> /v Path` output, or "". */
export function parseRegPath(stdout: string): string {
  const m = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(stdout);
  return m ? m[1]!.trim() : "";
}

/** Expand %VAR% from env (case-insensitive names, as Windows does); unknown names are left as is. */
export function expandWindowsVars(value: string, env: Record<string, string | undefined>): string {
  const lower = new Map(Object.entries(env).map(([k, v]) => [k.toLowerCase(), v]));
  return value.replace(/%([^%]+)%/g, (whole, name: string) => lower.get(name.toLowerCase()) ?? whole);
}

/** Join entries in order, dropping empties and duplicates (case-insensitive and slash-trimmed on Windows). */
export function dedupePath(entries: string[], platform: NodeJS.Platform): string {
  const win = platform === "win32";
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of entries) {
    const e = raw.trim();
    if (!e) continue;
    const key = win ? e.replace(/[\\/]+$/, "").toLowerCase() : e.replace(/\/+$/, "") || "/";
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out.join(win ? ";" : ":");
}

/** process PATH, then (Windows) user and machine PATH from the registry, then the usual install locations. */
export async function buildToolPath(deps: ToolPathDeps = {}): Promise<string> {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const win = platform === "win32";
  const sep = win ? ";" : ":";
  const pathOf = (e: Record<string, string | undefined>) => (win ? (Object.entries(e).find(([k]) => k.toLowerCase() === "path")?.[1] ?? "") : (e.PATH ?? ""));
  const entries = pathOf(env).split(sep);

  if (win) {
    const reg = deps.reg ?? defaultReg;
    const [user, machine] = await Promise.all([USER_KEY, MACHINE_KEY].map((key) => reg(["query", key, "/v", "Path"])));
    for (const out of [user!, machine!]) entries.push(...expandWindowsVars(parseRegPath(out), env).split(";"));
    if (env.APPDATA) entries.push(win32.join(env.APPDATA, "npm"));
    if (env.LOCALAPPDATA) entries.push(win32.join(env.LOCALAPPDATA, "Programs"));
    entries.push(win32.join(home, ".local", "bin"));
  } else {
    entries.push(posix.join(home, ".npm-global", "bin"), posix.join(home, ".local", "bin"), "/usr/local/bin", "/opt/homebrew/bin");
  }
  return dedupePath(entries, platform);
}
