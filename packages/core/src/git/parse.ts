// Parsers for git's machine-readable output. Pure functions, tested in parse.test.ts.
import { createHash } from "node:crypto";
import type { GitBlame, GitBranch, GitChange, GitCommit, GitDiffLine, GitFileDiff, GitFileState, GitHunk, GitStash } from "@odin/shared/git";
import { AUTO_STASH_PREFIX, SESSION_TRAILER, TURNS_TRAILER } from "@odin/shared/git";

// ── status (porcelain v2, -z) ────────────────────────────────────────────────

export interface ParsedStatus {
  headSha: string | null;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  upstreamGone: boolean;
  staged: GitChange[];
  unstaged: GitChange[];
  conflicted: string[];
}

const LETTER: Record<string, GitFileState> = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", T: "typechange" };

export function parseStatusV2(out: string): ParsedStatus {
  const s: ParsedStatus = { headSha: null, branch: null, upstream: null, ahead: 0, behind: 0, upstreamGone: false, staged: [], unstaged: [], conflicted: [] };
  let sawAb = false;
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]!;
    if (!e) continue;
    if (e.startsWith("# ")) {
      const [, key, ...rest] = e.split(" ");
      const val = rest.join(" ");
      if (key === "branch.oid") s.headSha = val === "(initial)" ? null : val;
      else if (key === "branch.head") s.branch = val === "(detached)" ? null : val;
      else if (key === "branch.upstream") s.upstream = val;
      else if (key === "branch.ab") {
        sawAb = true;
        const m = /\+(\d+) -(\d+)/.exec(val);
        if (m) { s.ahead = Number(m[1]); s.behind = Number(m[2]); }
      }
      continue;
    }
    const kind = e[0];
    if (kind === "?") {
      s.unstaged.push({ path: e.slice(2), oldPath: null, state: "untracked", additions: null, deletions: null });
      continue;
    }
    if (kind === "1" || kind === "2") {
      const fields = e.split(" ");
      const xy = fields[1]!;
      const pathStart = kind === "1" ? 8 : 9;
      const path = fields.slice(pathStart).join(" ");
      const oldPath = kind === "2" ? (parts[++i] ?? null) : null;
      const x = xy[0]!, y = xy[1]!;
      if (x !== ".") s.staged.push({ path, oldPath: LETTER[x] === "renamed" || LETTER[x] === "copied" ? oldPath : null, state: LETTER[x] ?? "modified", additions: null, deletions: null });
      if (y !== ".") s.unstaged.push({ path, oldPath: null, state: LETTER[y] ?? "modified", additions: null, deletions: null });
      continue;
    }
    if (kind === "u") {
      const path = e.split(" ").slice(10).join(" ");
      s.conflicted.push(path);
      s.unstaged.push({ path, oldPath: null, state: "conflicted", additions: null, deletions: null });
    }
  }
  s.upstreamGone = s.upstream !== null && !sawAb;
  return s;
}

/** `git diff --numstat -z`: path → [additions, deletions] (null for binary). */
export function parseNumstatZ(out: string): Map<string, [number | null, number | null]> {
  const map = new Map<string, [number | null, number | null]>();
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]!;
    if (!e) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(e);
    if (!m) continue;
    let path = m[3]!;
    if (path === "") { i++; path = parts[++i] ?? ""; } // rename: "\0old\0new"
    map.set(path, [m[1] === "-" ? null : Number(m[1]), m[2] === "-" ? null : Number(m[2])]);
  }
  return map;
}

// ── diffs ────────────────────────────────────────────────────────────────────

export interface RawHunk extends GitHunk {
  /** Indexes of lines followed by "\ No newline at end of file". */
  noEol: Set<number>;
}
export interface RawFileDiff extends Omit<GitFileDiff, "hunks" | "staged"> {
  hunks: RawHunk[];
  added: boolean;
  deleted: boolean;
}

const MAX_DIFF_LINES = 6000;

export function hunkId(oldStart: number, newStart: number, lines: GitDiffLine[]): string {
  const h = createHash("sha1");
  for (const l of lines) h.update(`${l.kind[0]}${l.text}\n`);
  return `${oldStart},${newStart}:${h.digest("hex").slice(0, 10)}`;
}

const stripPrefix = (p: string) => (p === "/dev/null" ? p : p.replace(/^[ab]\//, ""));

/** Parses unified diff output for one or more files. */
export function parseDiff(out: string): RawFileDiff[] {
  const files: RawFileDiff[] = [];
  let file: RawFileDiff | null = null;
  let hunk: RawHunk | null = null;
  let oldLine = 0, newLine = 0, total = 0;
  const finishHunk = () => {
    if (file && hunk) {
      hunk.id = hunkId(hunk.oldStart, hunk.newStart, hunk.lines);
      file.hunks.push(hunk);
    }
    hunk = null;
  };
  for (const line of out.split("\n")) {
    if (line.startsWith("diff --git ")) {
      finishHunk();
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      file = { path: m?.[2] ?? "", oldPath: null, binary: false, truncated: false, hunks: [], added: false, deleted: false };
      files.push(file);
      continue;
    }
    if (!file) continue;
    if (!hunk) {
      if (line.startsWith("--- ")) { const p = stripPrefix(line.slice(4)); if (p === "/dev/null") file.added = true; else if (p !== file.path) file.oldPath = p; continue; }
      if (line.startsWith("+++ ")) { const p = stripPrefix(line.slice(4)); if (p === "/dev/null") file.deleted = true; else file.path = p; continue; }
      if (line.startsWith("rename from ")) { file.oldPath = line.slice(12); continue; }
      if (line.startsWith("new file mode")) { file.added = true; continue; }
      if (line.startsWith("deleted file mode")) { file.deleted = true; continue; }
      if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) { file.binary = true; continue; }
    }
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line);
    if (h) {
      finishHunk();
      oldLine = Number(h[1]);
      newLine = Number(h[3]);
      hunk = { id: "", header: line, oldStart: oldLine, oldLines: h[2] === undefined ? 1 : Number(h[2]), newStart: newLine, newLines: h[4] === undefined ? 1 : Number(h[4]), section: h[5] ?? "", lines: [], noEol: new Set() };
      continue;
    }
    if (!hunk) continue;
    const cur: RawHunk = hunk;
    if (total >= MAX_DIFF_LINES) { file.truncated = true; continue; }
    const c = line[0];
    if (c === "+") { cur.lines.push({ kind: "add", text: line.slice(1), oldLine: null, newLine: newLine++ }); total++; }
    else if (c === "-") { cur.lines.push({ kind: "del", text: line.slice(1), oldLine: oldLine++, newLine: null }); total++; }
    else if (c === " ") { cur.lines.push({ kind: "context", text: line.slice(1), oldLine: oldLine++, newLine: newLine++ }); total++; }
    else if (c === "\\") cur.noEol.add(cur.lines.length - 1);
  }
  finishHunk();
  return files;
}

/** A diff of a new file from its content: one hunk of added lines. */
export function addedFileDiff(path: string, content: string): RawFileDiff {
  const noEol = new Set<number>();
  const text = content.endsWith("\n") ? content.slice(0, -1) : content;
  const rows = content.length === 0 ? [] : text.split("\n");
  if (rows.length && !content.endsWith("\n")) noEol.add(rows.length - 1);
  const lines: GitDiffLine[] = rows.slice(0, MAX_DIFF_LINES).map((t, i) => ({ kind: "add", text: t, oldLine: null, newLine: i + 1 }));
  const hunks: RawHunk[] = lines.length
    ? [{ id: hunkId(0, 1, lines), header: `@@ -0,0 +1,${lines.length} @@`, oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, section: "", lines, noEol }]
    : [];
  return { path, oldPath: null, binary: false, truncated: rows.length > MAX_DIFF_LINES, hunks, added: true, deleted: false };
}

/**
 * A patch holding one hunk, or only the chosen lines of it. `reverse` builds it for `git apply --reverse` (unstage,
 * discard): unchosen additions stay as context and unchosen deletions drop out. Forward (stage) is the mirror image.
 */
export function hunkPatch(file: { path: string; oldPath: string | null }, hunk: RawHunk, chosen: Set<number> | null, reverse: boolean): string {
  const out: string[] = [];
  let oldCount = 0, newCount = 0;
  hunk.lines.forEach((l, i) => {
    const pick = chosen === null || chosen.has(i);
    let mark: string | null;
    if (l.kind === "context") mark = " ";
    else if (pick) mark = l.kind === "add" ? "+" : "-";
    else if (l.kind === "add") mark = reverse ? " " : null;
    else mark = reverse ? null : " ";
    if (mark === null) return;
    if (mark !== "+") oldCount++;
    if (mark !== "-") newCount++;
    out.push(mark + l.text);
    if (hunk.noEol.has(i)) out.push("\\ No newline at end of file");
  });
  const a = file.oldPath ?? file.path;
  return [`diff --git a/${a} b/${file.path}`, `--- a/${a}`, `+++ b/${file.path}`, `@@ -${hunk.oldStart},${oldCount} +${hunk.oldStart},${newCount} @@`, ...out, ""].join("\n");
}

export function publicDiff(d: RawFileDiff, staged: boolean): GitFileDiff {
  return { path: d.path, oldPath: d.oldPath, staged, binary: d.binary, truncated: d.truncated, hunks: d.hunks.map(({ noEol: _n, ...h }) => h) };
}

// ── log ──────────────────────────────────────────────────────────────────────

/** `--format` for parseLog. Records start with \x1e, fields split by \x1f, the body ends with \x1d (numstat follows). */
export const LOG_FORMAT = "%x1e%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%P%x1f%s%x1f%B%x1d";

export function trailers(body: string): { sessionId: string | null; turns: string | null } {
  let sessionId: string | null = null, turns: string | null = null;
  for (const line of body.split("\n")) {
    const m = /^([A-Za-z-]+):\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    if (m[1] === SESSION_TRAILER) sessionId = m[2]!;
    else if (m[1] === TURNS_TRAILER) turns = m[2]!;
  }
  return { sessionId, turns };
}

export function parseLog(out: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const rec of out.split("\x1e")) {
    if (!rec.trim()) continue;
    const end = rec.indexOf("\x1d");
    const head = end < 0 ? rec : rec.slice(0, end);
    const stat = end < 0 ? "" : rec.slice(end + 1);
    const [sha = "", shortSha = "", author = "", authorEmail = "", at = "", parents = "", subject = "", full = ""] = head.split("\x1f");
    const bodyLines = full.split("\n");
    const body = bodyLines.slice(1).join("\n").trim();
    let additions: number | null = null, deletions: number | null = null;
    for (const line of stat.split("\n")) {
      const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
      if (!m) continue;
      additions = (additions ?? 0) + (m[1] === "-" ? 0 : Number(m[1]));
      deletions = (deletions ?? 0) + (m[2] === "-" ? 0 : Number(m[2]));
    }
    commits.push({ sha, shortSha, subject, body, author, authorEmail, at, parents: parents.split(" ").filter(Boolean), ...trailers(full), additions, deletions });
  }
  return commits;
}

// ── blame ────────────────────────────────────────────────────────────────────

export const ZERO_SHA = "0000000000000000000000000000000000000000";

export function parseBlamePorcelain(out: string, path: string): GitBlame {
  const ranges: GitBlame["ranges"] = [];
  const commits: GitBlame["commits"] = {};
  const info = new Map<string, { author: string; mail: string; time: number; summary: string }>();
  let current: string | null = null;
  for (const line of out.split("\n")) {
    const h = /^([0-9a-f]{40}) \d+ (\d+)(?: (\d+))?$/.exec(line);
    if (h) {
      current = h[1]!;
      const start = Number(h[2]);
      const last = ranges[ranges.length - 1];
      if (last && last.sha === current && last.start + last.lines === start) last.lines++;
      else ranges.push({ sha: current, start, lines: 1 });
      if (!info.has(current)) info.set(current, { author: "", mail: "", time: 0, summary: "" });
      continue;
    }
    if (!current || line.startsWith("\t")) continue;
    const i = info.get(current)!;
    if (line.startsWith("author ")) i.author = line.slice(7);
    else if (line.startsWith("author-mail ")) i.mail = line.slice(12).replace(/^<|>$/g, "");
    else if (line.startsWith("author-time ")) i.time = Number(line.slice(12));
    else if (line.startsWith("summary ")) i.summary = line.slice(8);
  }
  for (const [sha, i] of info) {
    commits[sha] = { sha, shortSha: sha.slice(0, 7), subject: sha === ZERO_SHA ? "Not committed yet" : i.summary, body: "", author: sha === ZERO_SHA ? "You" : i.author, authorEmail: i.mail, at: new Date(i.time * 1000).toISOString(), parents: [], sessionId: null, turns: null, additions: null, deletions: null };
  }
  return { path, ranges, commits };
}

// ── branches and stashes ─────────────────────────────────────────────────────

export const BRANCH_FORMAT = "%(refname)%00%(objectname)%00%(upstream:short)%00%(upstream:track)%00%(committerdate:iso-strict)%00%(subject)%00%(HEAD)";

export function parseBranches(out: string): Omit<GitBranch, "worktree" | "worktreeSession">[] {
  const rows: Omit<GitBranch, "worktree" | "worktreeSession">[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [ref = "", headSha = "", upstream = "", track = "", date = "", subject = "", head = ""] = line.split("\0");
    const remote = ref.startsWith("refs/remotes/");
    if (remote && ref.endsWith("/HEAD")) continue;
    const name = ref.replace(/^refs\/(heads|remotes)\//, "");
    const ahead = Number(/ahead (\d+)/.exec(track)?.[1] ?? 0);
    const behind = Number(/behind (\d+)/.exec(track)?.[1] ?? 0);
    const t = Date.parse(date);
    rows.push({ name, remote, current: head === "*", upstream: upstream || null, ahead, behind, upstreamGone: track.includes("gone"), headSha, subject, lastCommitAt: Number.isFinite(t) ? new Date(t).toISOString() : date });
  }
  return rows;
}

export const STASH_FORMAT = "%gd%x1f%gs%x1f%cI";

export function parseStashes(out: string): GitStash[] {
  return out.split("\n").filter(Boolean).map((line) => {
    const [ref = "", subject = "", at = ""] = line.split("\x1f");
    const m = /^(?:WIP on|On) ([^:]+): (.*)$/.exec(subject);
    const message = m ? m[2]! : subject;
    return { ref, message, branch: m ? m[1]! : null, at, auto: message.startsWith(AUTO_STASH_PREFIX) };
  });
}
