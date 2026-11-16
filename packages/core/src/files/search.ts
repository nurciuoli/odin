// `@` file-reference search: an index of a folder's paths (git when possible, else a bounded walk) and a fuzzy
// ranking. docs/contracts.md (file references). No watchers: the index is cached briefly per folder.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { gitBinary } from "../tools/resolve.ts";
import type { FileMatch, FileSearchResult } from "@odin/shared/api";

export const MAX_INDEXED = 20_000;
export const MAX_MATCHES = 50;
const CACHE_MS = 10_000;

interface Index {
  files: string[];
  dirs: string[];
  truncated: boolean;
  at: number;
}

function gitFiles(root: string): string[] | null {
  try {
    const out = execFileSync(gitBinary(), ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return out.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

function walkFiles(root: string, limit: number): string[] {
  const out: string[] = [];
  const queue = [""];
  while (queue.length && out.length <= limit) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules" || e.isSymbolicLink()) continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) queue.push(rel);
      else if (e.isFile()) out.push(rel);
      if (out.length > limit) break;
    }
  }
  return out;
}

export function buildIndex(root: string): Omit<Index, "at"> {
  let files = gitFiles(root) ?? walkFiles(root, MAX_INDEXED);
  const truncated = files.length > MAX_INDEXED;
  if (truncated) files = files.slice(0, MAX_INDEXED);
  files = files.map((f) => f.replaceAll("\\", "/"));
  const dirs = new Set<string>();
  for (const f of files) {
    let i = f.lastIndexOf("/");
    while (i > 0) {
      const d = f.slice(0, i);
      if (dirs.has(d)) break;
      dirs.add(d);
      i = d.lastIndexOf("/");
    }
  }
  return { files, dirs: [...dirs].sort(), truncated };
}

/**
 * Fuzzy score of `path` for a lower-cased `query`, or null when the query isn't a subsequence. Higher is better:
 * contiguous runs, matches at word boundaries and in the basename count most; long paths count against.
 */
export function fuzzyScore(path: string, query: string): number | null {
  if (!query) return 0;
  const lower = path.toLowerCase();
  const base = lower.lastIndexOf("/") + 1;
  const name = lower.slice(base);
  let score = 0;
  if (name === query) score += 100;
  else if (name.startsWith(query)) score += 60;
  else if (name.includes(query)) score += 40;
  else if (lower.includes(query)) score += 20;
  let qi = 0;
  let prev = -2;
  for (let i = 0; i < lower.length && qi < query.length; i++) {
    if (lower[i] !== query[qi]) continue;
    let s = 1;
    if (i === prev + 1) s += 3;
    const before = i === 0 ? "/" : lower[i - 1]!;
    if (before === "/" || before === "-" || before === "_" || before === "." || before === " ") s += 2;
    else if (path[i] !== lower[i] && path[i - 1] === lower[i - 1]) s += 2; // camelCase hump
    if (i >= base) s += 1;
    score += s;
    prev = i;
    qi++;
  }
  if (qi < query.length) return null;
  return score - path.length * 0.05;
}

export function rank(index: Omit<Index, "at">, query: string): FileMatch[] {
  const q = query.trim().replaceAll("\\", "/").toLowerCase();
  if (!q) {
    const top = new Map<string, FileMatch>();
    for (const d of index.dirs) if (!d.includes("/")) top.set(d, { path: d, kind: "directory" });
    for (const f of index.files) if (!f.includes("/")) top.set(f, { path: f, kind: "file" });
    return [...top.values()]
      .sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.path.localeCompare(b.path))
      .slice(0, MAX_MATCHES);
  }
  const scored: { m: FileMatch; s: number }[] = [];
  for (const [list, kind] of [[index.files, "file"], [index.dirs, "directory"]] as const) {
    for (const path of list) {
      const s = fuzzyScore(path, q);
      if (s !== null) scored.push({ m: { path, kind }, s });
    }
  }
  scored.sort((a, b) => b.s - a.s || a.m.path.length - b.m.path.length || a.m.path.localeCompare(b.m.path));
  return scored.slice(0, MAX_MATCHES).map((x) => x.m);
}

/** A per-folder cached search (`now` is injectable for tests). */
export function createFileSearch(now: () => number = Date.now) {
  const cache = new Map<string, Index>();
  return (root: string, query: unknown): FileSearchResult => {
    const q = typeof query === "string" ? query.slice(0, 200) : "";
    let index = cache.get(root);
    if (!index || now() - index.at > CACHE_MS) {
      index = { ...buildIndex(root), at: now() };
      cache.set(root, index);
      if (cache.size > 32) cache.delete(cache.keys().next().value!);
    }
    return { query: q, matches: rank(index, q), truncated: index.truncated };
  };
}
