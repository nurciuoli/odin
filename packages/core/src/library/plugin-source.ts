// Reading a plugin to import: a folder on this machine, or a git address cloned into a temp folder under <home>.
// Everything read is untrusted data: no symlinks, no `..`, bounded size, text only. docs/contracts.md#plugins.
import { execFile } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AssetFiles } from "@odin/shared/api";
import { HttpError } from "../http/util.ts";
import { MAX_ASSET_FILE_BYTES, pathError } from "./parse.ts";

const run = promisify(execFile);

export const MAX_SOURCE_FILES = 500;
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;

/** Every regular text file under `dir` (relative keys with `/`), dotfiles included except `.git`. */
export function readSourceTree(dir: string): { files: AssetFiles; warnings: string[] } {
  const files: AssetFiles = {};
  const warnings: string[] = [];
  let count = 0;
  let bytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const walk = (abs: string, rel: string) => {
    for (const name of readdirSync(abs).sort()) {
      if (name === ".git") continue;
      const path = join(abs, name);
      const key = rel ? `${rel}/${name}` : name;
      const st = lstatSync(path, { throwIfNoEntry: false });
      if (!st || st.isSymbolicLink()) {
        if (st) warnings.push(`${key} is a symbolic link and was ignored`);
        continue;
      }
      if (st.isDirectory()) {
        walk(path, key);
        continue;
      }
      if (!st.isFile()) continue;
      if (++count > MAX_SOURCE_FILES) {
        if (count === MAX_SOURCE_FILES + 1) throw new HttpError(400, `more than ${MAX_SOURCE_FILES} files: that is not a plugin`);
        continue;
      }
      if (st.size > MAX_ASSET_FILE_BYTES) {
        warnings.push(`${key} is larger than 1 MB and was ignored`);
        continue;
      }
      bytes += st.size;
      if (bytes > MAX_SOURCE_BYTES) throw new HttpError(400, "the plugin is larger than 16 MB");
      if (pathError(key)) {
        warnings.push(`${key} has an unusable path and was ignored`);
        continue;
      }
      try {
        files[key] = decoder.decode(readFileSync(path));
      } catch {
        warnings.push(`${key} is not text and was ignored`);
      }
    }
  };
  walk(dir, "");
  return { files, warnings };
}

/** An https, ssh or `git@` address and a ref that cannot be read as an option. */
export function gitSourceError(url: string, rev?: string): string | null {
  if (!/^(https:\/\/|ssh:\/\/|git@)[^\s\u0000-\u001f]+$/.test(url) || url.startsWith("-")) return "git url must be an https, ssh or git@ address";
  if (rev !== undefined && (!/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,127}$/.test(rev) || rev.includes(".."))) return "rev must be a branch, tag or commit name";
  return null;
}

export type GitFetcher = (url: string, rev: string | undefined, dest: string) => Promise<void>;

/** Clones into `dest` with git run by argv (never a shell), no prompts, no hooks, no submodules. */
export const gitFetch: GitFetcher = async (url, rev, dest) => {
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" };
  const opts = { env, timeout: 60_000, maxBuffer: 1024 * 1024 };
  const git = (...args: string[]) => run("git", ["-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=never", ...args], opts);
  try {
    await git("init", "--quiet", dest);
    await git("-C", dest, "fetch", "--quiet", "--depth", "1", "--no-recurse-submodules", "--", url, rev ?? "HEAD");
    await git("-C", dest, "checkout", "--quiet", "--detach", "FETCH_HEAD");
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new HttpError(502, `git could not fetch ${url}: ${(e.stderr || e.message).trim().split("\n").pop()}`);
  }
};

/** Runs `use` on a fresh temp folder under `<home>/tmp` and removes it after. */
export async function withTempDir<T>(home: string, use: (dir: string) => Promise<T>): Promise<T> {
  const base = join(home, "tmp");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "import-"));
  try {
    return await use(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
