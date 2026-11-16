// File helpers for the library and installs: bounded tree reads that never follow symlinks, atomic writes (temp then
// rename), and root containment checks for every path built from an asset's file keys.
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AssetFiles } from "@odin/shared/api";
import { MAX_ASSET_FILE_BYTES, MAX_ASSET_FILES, pathError } from "./parse.ts";

const tmpSuffix = () => randomBytes(6).toString("hex");

/** Entries Odin never treats as asset content: dotfiles (editor/VCS files and our own temp files). */
export const isHidden = (name: string) => name.startsWith(".");

export interface Tree {
  files: AssetFiles;
  error: string | null;
}

/** Reads every regular file under `dir` (relative keys with `/`), skipping dotfiles and symlinks, within the limits. */
export function readTree(dir: string): Tree {
  const files: AssetFiles = {};
  const errors: string[] = [];
  let count = 0;
  const walk = (abs: string, rel: string) => {
    let names: string[];
    try {
      names = readdirSync(abs).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (isHidden(name)) continue;
      const path = join(abs, name);
      const key = rel ? `${rel}/${name}` : name;
      const st = lstatSync(path, { throwIfNoEntry: false });
      if (!st || st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        walk(path, key);
        continue;
      }
      if (!st.isFile()) continue;
      if (++count > MAX_ASSET_FILES) {
        if (count === MAX_ASSET_FILES + 1) errors.push(`more than ${MAX_ASSET_FILES} files; the rest were skipped`);
        continue;
      }
      if (st.size > MAX_ASSET_FILE_BYTES) {
        errors.push(`${key} is larger than 1 MB and was skipped`);
        continue;
      }
      if (pathError(key)) continue;
      files[key] = readFileSync(path, "utf8");
    }
  };
  walk(dir, "");
  return { files, error: errors.length ? errors.join("; ") : null };
}

/** A regular file's text (no symlinks), or null when absent. Too-large files are an error. */
export function readRegularFile(path: string, limit = MAX_ASSET_FILE_BYTES): string | null {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st || !st.isFile()) return null;
  if (st.size > limit) throw new Error(`${path} is larger than ${Math.round(limit / 1024)} KB`);
  return readFileSync(path, "utf8");
}

export function isDirectory(path: string): boolean {
  const st = lstatSync(path, { throwIfNoEntry: false });
  return !!st && st.isDirectory();
}

/**
 * Resolves `rel` under `root` and checks it stays there: lexically (no `..`, not absolute) and on disk (the nearest
 * existing ancestor's real path is inside the root's real path, so a symlinked directory can't lead out).
 */
export function resolveInside(root: string, rel: string): string {
  if (isAbsolute(rel)) throw new Error(`path escapes its root: ${rel}`);
  const abs = resolve(root, rel);
  const lexical = relative(resolve(root), abs);
  if (lexical === ".." || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) throw new Error(`path escapes its root: ${rel}`);
  const realRoot = existsSync(root) ? realpathSync(root) : resolve(root);
  let probe = abs;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  // The target itself is never written through (writes rename over it, reads skip symlinks): check its parent.
  const real = probe === abs ? join(realpathSync(dirname(abs)), pathBase(abs)) : realpathSync(probe);
  const rr = relative(realRoot, real);
  if (rr === ".." || rr.startsWith(`..${sep}`) || isAbsolute(rr)) throw new Error(`path escapes its root: ${rel}`);
  return abs;
}

/** Writes via a temp file in the same directory, then renames over the target. */
export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${pathBase(path)}.tmp-${tmpSuffix()}`);
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Replaces a directory with exactly `files`: written into a temp directory beside it, then swapped in by rename. */
export function replaceDirAtomic(dir: string, files: AssetFiles): void {
  const parent = dirname(dir);
  mkdirSync(parent, { recursive: true });
  const suffix = tmpSuffix();
  const tmp = join(parent, `.${pathBase(dir)}.tmp-${suffix}`);
  const old = join(parent, `.${pathBase(dir)}.old-${suffix}`);
  try {
    for (const [rel, content] of Object.entries(files)) {
      const bad = pathError(rel);
      if (bad) throw new Error(bad);
      const target = join(tmp, ...rel.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    mkdirSync(tmp, { recursive: true });
    const st = lstatSync(dir, { throwIfNoEntry: false });
    if (st) renameSync(dir, old);
    try {
      renameSync(tmp, dir);
    } catch (err) {
      if (st) renameSync(old, dir);
      throw err;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(old, { recursive: true, force: true });
  }
}

/** Removes a file or directory (a symlink itself, never its target). */
export function removePath(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function pathBase(path: string): string {
  return path.slice(dirname(path).length + 1) || "x";
}
