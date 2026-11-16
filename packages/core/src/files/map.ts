// The project file map behind the Files tab: every file with its size, line count and working-tree diff against HEAD.
// docs/contracts.md (project file map). Read-only git, argv only; cached briefly per folder.
import { execFileSync } from "node:child_process";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { ProjectFileMap, ProjectMapFile } from "@odin/shared/api";
import { gitBinary } from "../tools/resolve.ts";
import { buildIndex, MAX_INDEXED } from "./search.ts";

const CACHE_MS = 10_000;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync(gitBinary(), ["-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 8000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
  } catch {
    return null;
  }
}

/** Size, and the line count when the file is small UTF-8-ish text; null lines for binary or large files. */
function statFile(root: string, path: string): { size: number; lines: number | null } | null {
  let fd: number;
  try { fd = openSync(join(root, path), "r"); } catch { return null; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_TEXT_BYTES) return { size: stat.size, lines: null };
    const buffer = Buffer.alloc(stat.size);
    let length = 0;
    while (length < buffer.length) {
      const n = readSync(fd, buffer, length, buffer.length - length, null);
      if (!n) break;
      length += n;
    }
    if (buffer.subarray(0, length).includes(0)) return { size: stat.size, lines: null };
    let lines = 0;
    for (let i = 0; i < length; i++) if (buffer[i] === 10) lines++;
    if (length > 0 && buffer[length - 1] !== 10) lines++;
    return { size: stat.size, lines };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** `path -> [added, removed]` from `git diff --numstat -z`; binary files (`-`) are skipped. */
export function parseNumstat(out: string): Map<string, [number, number]> {
  const map = new Map<string, [number, number]>();
  for (const record of out.split("\0")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(record);
    if (!m || m[1] === "-" || m[2] === "-") continue;
    map.set(m[3]!.replaceAll("\\", "/"), [Number(m[1]), Number(m[2])]);
  }
  return map;
}

export function buildMap(root: string): ProjectFileMap {
  const { files: paths, truncated } = buildIndex(root);
  const numstat = git(root, ["diff", "--numstat", "--no-renames", "-z", "HEAD"]);
  const diff = numstat === null ? new Map<string, [number, number]>() : parseNumstat(numstat);
  const untracked = new Set(
    (git(root, ["ls-files", "-z", "--others", "--exclude-standard"]) ?? "").split("\0").filter(Boolean).map(p => p.replaceAll("\\", "/")),
  );
  const hasHead = numstat !== null;
  const files: ProjectMapFile[] = [];
  for (const path of paths) {
    const info = statFile(root, path);
    if (!info) continue; // deleted in the working tree, or not a regular file
    const file: ProjectMapFile = { path, size: info.size };
    if (info.lines !== null) file.lines = info.lines;
    const counts = diff.get(path) ?? (hasHead && untracked.has(path) && info.lines ? ([info.lines, 0] as [number, number]) : null);
    if (counts && (counts[0] || counts[1])) {
      file.added = counts[0];
      file.removed = counts[1];
    }
    files.push(file);
  }
  return { files, truncated: truncated || paths.length >= MAX_INDEXED };
}

/** A per-folder cached map (`now` is injectable for tests). */
export function createFileMap(now: () => number = Date.now) {
  const cache = new Map<string, { at: number; map: ProjectFileMap }>();
  return (root: string): ProjectFileMap => {
    const hit = cache.get(root);
    if (hit && now() - hit.at <= CACHE_MS) return hit.map;
    const map = buildMap(root);
    cache.set(root, { at: now(), map });
    if (cache.size > 32) cache.delete(cache.keys().next().value!);
    return map;
  };
}
