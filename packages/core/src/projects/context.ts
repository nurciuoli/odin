// Where a project's title, description, commands, status excerpts and planning links come from.
// Reads files. Never writes them. Package names are not titles.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type {
  PlanningDocument,
  ProjectCommands,
  ProjectContext,
  ProjectExcerpt,
  ProjectOrigin,
  ProjectSettings,
  ProjectSourceSelection,
} from "@odin/shared/api";
import { emptyProjectContext } from "@odin/shared/api";
import { parseFrontmatter } from "../frontmatter.ts";

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const OVERVIEW_CANDIDATES = ["README.md", "README.markdown"];
const STATUS_CANDIDATE = "docs/STATUS.md";
const PLANNING_CANDIDATE = "docs/plans";
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage"]);
const MAX_READ = 256 * 1024;
const MAX_PLANNING = 200;
const MAX_DEPTH = 6;
const EXCERPT_CHARS = 600;

export interface ManifestFields {
  title?: string;
  description?: string;
  repo?: string;
  defaultBranch?: string;
  commands?: ProjectCommands;
  detectedRepo?: string;
  detectedDefaultBranch?: string;
}

export interface SettingOverrides {
  title?: string;
  description?: string;
  repo?: string | null;
  defaultBranch?: string;
  commands?: ProjectCommands;
  githubEnabled?: boolean;
  defaultWorktree?: boolean;
}

interface Field<T> {
  value: T;
  origin: ProjectOrigin;
}

export interface ProjectRead {
  settings: ProjectSettings;
  context: ProjectContext;
  /** Raw markdown of the first status document, or null. */
  status: string | null;
  /** Changes when a source file's size or mtime changes, so refresh can notice a status edit. */
  stamp: string;
}

/** owner/name from a git remote URL. Local paths and other shapes return null. */
export function repoFromRemote(url: string): string | null {
  const trimmed = url.trim().replace(/\.git$/i, "");
  const ssh = trimmed.match(/^git@[^:]+:([^/\s]+)\/([^/\s]+)$/);
  if (ssh) {
    const repo = `${ssh[1]}/${ssh[2]}`;
    return REPO_PATTERN.test(repo) ? repo : null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const repo = `${parts[0]}/${parts[1]!.replace(/\.git$/i, "")}`;
    return REPO_PATTERN.test(repo) ? repo : null;
  } catch {
    return null;
  }
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`) && !rel.startsWith("/") && !/^[A-Za-z]:/.test(rel));
}

function readFile(root: string, rel: string): string | null {
  const full = resolve(root, rel);
  if (!inside(root, full)) return null;
  try {
    const st = lstatSync(full);
    if (!st.isFile() || st.size > MAX_READ) return null;
    return readFileSync(full, "utf8").replace(/^\uFEFF/, "");
  } catch {
    return null;
  }
}

function existsFile(root: string, rel: string): boolean {
  try {
    const st = lstatSync(resolve(root, rel));
    return st.isFile();
  } catch {
    return false;
  }
}

function existsDir(root: string, rel: string): boolean {
  try {
    const st = lstatSync(resolve(root, rel));
    return st.isDirectory();
  } catch {
    return false;
  }
}

/** Heading becomes the title. The first paragraph becomes the description. A file with no heading has no title. */
export function documentIntro(text: string): { title?: string; description?: string; heading: string | null } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let index = 0;
  while (index < lines.length && !lines[index]!.trim()) index += 1;
  let heading: string | null = null;
  const atx = (lines[index] ?? "").match(/^#{1,6}\s+(.+?)\s*#*$/);
  if (atx) {
    heading = atx[1]!.trim().replace(/\s+/g, " ").slice(0, 200);
    index += 1;
  }
  while (index < lines.length && !lines[index]!.trim()) index += 1;
  const paragraph: string[] = [];
  while (index < lines.length && lines[index]!.trim()) {
    paragraph.push(lines[index]!.trim());
    index += 1;
  }
  const description = paragraph.join(" ").replace(/\s+/g, " ").slice(0, 400);
  return { title: heading || undefined, description: description || undefined, heading };
}

function excerptOf(path: string, text: string): ProjectExcerpt {
  const intro = documentIntro(text);
  const textBody = (intro.description ?? text.replace(/\s+/g, " ").trim()).slice(0, EXCERPT_CHARS);
  return { path, heading: intro.heading, text: textBody };
}

function packageCommands(root: string): Partial<Record<keyof ProjectCommands, string>> {
  const raw = readFile(root, "package.json");
  if (raw === null) return {};
  let parsed: { scripts?: unknown; packageManager?: unknown };
  try {
    parsed = JSON.parse(raw) as { scripts?: unknown; packageManager?: unknown };
  } catch {
    return {};
  }
  const scripts = parsed.scripts && typeof parsed.scripts === "object" ? parsed.scripts as Record<string, unknown> : {};
  const manager = typeof parsed.packageManager === "string" && parsed.packageManager.startsWith("pnpm")
    ? "pnpm"
    : typeof parsed.packageManager === "string" && parsed.packageManager.startsWith("yarn")
      ? "yarn"
      : "npm";
  const run = (script: string) => script === "test" && manager === "npm" ? "npm test" : script === "install" && manager === "npm" ? "npm install" : `${manager} run ${script}`;
  const commands: Partial<Record<keyof ProjectCommands, string>> = {};
  if (typeof scripts.install === "string") commands.install = run("install");
  else commands.install = `${manager} install`;
  if (typeof scripts.check === "string") commands.check = run("check");
  else if (typeof scripts.test === "string") commands.check = run("test");
  else if (typeof scripts.typecheck === "string") commands.check = run("typecheck");
  if (typeof scripts.build === "string") commands.build = run("build");
  return commands;
}

function discover(root: string): ProjectSourceSelection {
  const overview = OVERVIEW_CANDIDATES.find((rel) => existsFile(root, rel)) ?? null;
  return {
    overview,
    status: existsFile(root, STATUS_CANDIDATE) ? [STATUS_CANDIDATE] : [],
    planning: existsDir(root, PLANNING_CANDIDATE) ? [PLANNING_CANDIDATE] : [],
  };
}

function planningDocs(root: string, dirs: string[]): { documents: PlanningDocument[]; truncated: boolean } {
  const documents: PlanningDocument[] = [];
  let truncated = false;
  const walk = (rel: string, depth: number) => {
    if (truncated || depth > MAX_DEPTH) return;
    const full = resolve(root, rel);
    if (!inside(root, full)) return;
    let names: string[];
    try {
      if (!lstatSync(full).isDirectory()) return;
      names = readdirSync(full);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (documents.length >= MAX_PLANNING) {
        truncated = true;
        return;
      }
      if (SKIP_DIRS.has(name)) continue;
      const child = `${rel}/${name}`.replace(/^\//, "");
      const childFull = resolve(root, child);
      if (!inside(root, childFull)) continue;
      let st;
      try {
        st = lstatSync(childFull);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(child, depth + 1);
      else if (st.isFile() && name.endsWith(".md") && st.size <= MAX_READ) {
        const text = readFile(root, child);
        if (text === null) continue;
        const fm = parseFrontmatter(text, child);
        const titled = fm.data?.title;
        const status = fm.data?.status;
        const intro = documentIntro(fm.body || text);
        documents.push({
          path: child,
          title: typeof titled === "string" && titled.trim() ? titled.trim().slice(0, 200) : intro.heading ?? name.replace(/\.md$/, ""),
          status: typeof status === "string" && status.trim() ? status.trim().slice(0, 80) : null,
          root: rel,
        });
      }
    }
  };
  for (const dir of dirs) walk(dir, 1);
  return { documents, truncated };
}

function stampOf(root: string, sources: ProjectSourceSelection): string {
  const files = [sources.overview, "package.json", ...sources.status].filter((rel): rel is string => !!rel);
  const parts: string[] = [];
  for (const rel of files) {
    try {
      const st = statSync(resolve(root, rel));
      parts.push(`${rel}:${st.size}:${st.mtimeMs}`);
    } catch {
      parts.push(`${rel}:missing`);
    }
  }
  for (const rel of sources.planning) {
    try {
      const st = statSync(resolve(root, rel));
      parts.push(`${rel}:${st.isDirectory() ? "dir" : "file"}:${st.mtimeMs}`);
    } catch {
      parts.push(`${rel}:missing`);
    }
  }
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
}

function pick<T>(override: T | undefined, manifest: T | undefined, disk: Field<T> | null, fallback: T, fallbackOrigin: ProjectOrigin): Field<T> {
  if (override !== undefined) return { value: override, origin: { kind: "override" } };
  if (manifest !== undefined) return { value: manifest, origin: { kind: "manifest", path: "PROJECT.md" } };
  if (disk) return disk;
  return { value: fallback, origin: fallbackOrigin };
}

/** Effective settings plus the context the overview and settings screens show. `saved` null means discovery. */
export function readProject(root: string | null, name: string, overrides: SettingOverrides, manifest: ManifestFields, saved: ProjectSourceSelection | null): ProjectRead {
  const discovered = root ? discover(root) : { overview: null, status: [], planning: [] };
  const sources = saved ?? discovered;
  const missing = root ? [...(sources.overview ? [sources.overview] : []), ...sources.status, ...sources.planning].filter((rel) => !existsFile(root, rel) && !existsDir(root, rel)) : [...(sources.overview ? [sources.overview] : []), ...sources.status, ...sources.planning];
  const overviewText = root && sources.overview && !missing.includes(sources.overview) ? readFile(root, sources.overview) : null;
  const intro = overviewText ? documentIntro(overviewText) : { heading: null };
  const commandsDisk = root ? packageCommands(root) : {};
  const packageOrigin: ProjectOrigin = { kind: "package", path: "package.json" };
  const documentOrigin: ProjectOrigin = { kind: "document", path: sources.overview ?? "README.md" };
  const title = pick(overrides.title, manifest.title, intro.title ? { value: intro.title, origin: documentOrigin } : null, name, { kind: "default" });
  const description = pick(overrides.description, manifest.description, intro.description ? { value: intro.description, origin: documentOrigin } : null, "", { kind: "default" });
  const repoDisk = manifest.detectedRepo ? { value: manifest.detectedRepo, origin: { kind: "git" } as ProjectOrigin } : null;
  const repo = pick(overrides.repo === null ? undefined : overrides.repo, manifest.repo, repoDisk, null, { kind: "default" });
  const commandSource = overrides.commands ?? manifest.commands;
  const commandOrigin: ProjectOrigin = overrides.commands ? { kind: "override" } : { kind: "manifest", path: "PROJECT.md" };
  const commands: ProjectCommands = {};
  const commandProvenance: ProjectContext["provenance"]["commands"] = {};
  const keys = ["install", "check", "build"] as const;
  for (const key of keys) {
    if (commandSource?.[key]) {
      commands[key] = commandSource[key];
      commandProvenance[key] = commandOrigin;
    } else if (!overrides.commands && !manifest.commands && commandsDisk[key]) {
      commands[key] = commandsDisk[key];
      commandProvenance[key] = packageOrigin;
    }
  }
  const statusTexts = root ? sources.status.filter((rel) => !missing.includes(rel)).map((rel) => ({ rel, text: readFile(root, rel) })).filter((item): item is { rel: string; text: string } => item.text !== null) : [];
  const planning = root ? planningDocs(root, sources.planning.filter((rel) => !missing.includes(rel))) : { documents: [], truncated: false };
  const context: ProjectContext = {
    ...emptyProjectContext(),
    customized: saved !== null,
    sources: { overview: sources.overview, status: [...sources.status], planning: [...sources.planning] },
    discovered,
    provenance: { title: title.origin, description: description.origin, repo: repo.origin, commands: commandProvenance },
    excerpts: statusTexts.map((item) => excerptOf(item.rel, item.text)),
    planning: planning.documents,
    planningTruncated: planning.truncated,
    missing,
  };
  return {
    settings: {
      title: title.value,
      description: description.value,
      repo: repo.value,
      defaultBranch: overrides.defaultBranch ?? manifest.defaultBranch ?? manifest.detectedDefaultBranch ?? "main",
      commands,
      ...(overrides.githubEnabled === undefined ? {} : { githubEnabled: overrides.githubEnabled }),
      ...(overrides.defaultWorktree === undefined ? {} : { defaultWorktree: overrides.defaultWorktree }),
    },
    context,
    status: statusTexts[0]?.text ?? null,
    stamp: root ? stampOf(root, { overview: discovered.overview, status: discovered.status, planning: discovered.planning }) : "",
  };
}
