// Global library context plus the files a project already has. Sessions take both: a project file wins on the
// same kind and id, and a project can turn a global item off. Writes stay inside the project directory.
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  AGENT_CONTEXT_KINDS,
  type AgentContextFiles,
  type AgentContextItem,
  type AgentContextKind,
  type AssetFiles,
  type ProjectAgentContext,
  type SetAgentContextEnabledRequest,
  type SettingsProfileSpec,
} from "@odin/shared/api";
import { ASSET_ID_PATTERN } from "@odin/shared/library";
import { parseAgentFile } from "../agents/parse.ts";
import { parseFrontmatter } from "../frontmatter.ts";
import { filesHash } from "../hash.ts";
import type { AgentSpec, McpServerStart } from "../harness/types.ts";
import { HttpError } from "../http/util.ts";
import { readTree, replaceDirAtomic, resolveInside, writeFileAtomic } from "../library/files.ts";
import { setInstruction } from "../library/instructions.ts";
import { formatJson, parseJsonObject, removeMcpEntry, setMcpEntry } from "../library/merge.ts";
import { MAX_ASSET_FILE_BYTES, MAX_ASSET_FILES, parseAsset, pathError, pluginOwnFiles } from "../library/parse.ts";
import type { Deps, Services } from "../services.ts";

const SKILL_ROOTS = [".claude/skills", ".codex/skills", ".agents/skills", ".opencode/skills", ".grok/skills"];
const AGENT_ROOTS = [".claude/agents", ".codex/agents", ".opencode/agents", ".grok/agents"];
const MCP_FILES = [".mcp.json", ".grok/mcp.json", ".opencode/mcp.json"];
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface ResolvedAgentContext {
  libraryInstructions: string;
  /** Root AGENTS.md. Codex reads it itself; other harnesses receive the text. */
  projectAgentsMd: string | null;
  skillNote: string | null;
  agents: Record<string, AgentSpec>;
  mcpServers: Record<string, McpServerStart>;
  skills: { name: string; description: string; path: string; files?: AssetFiles }[];
  settings: SettingsProfileSpec[];
  claudePluginPath: string | null;
}

interface Piece {
  kind: AgentContextKind;
  id: string;
  name: string;
  description: string;
  error: string | null;
  files: AssetFiles;
  meta: Record<string, unknown>;
  libraryEnabled: boolean;
}

interface Found {
  kind: AgentContextKind;
  id: string;
  name: string;
  description: string;
  path: string;
  root: string;
  error: string | null;
  files: AssetFiles;
  entry: string;
}

const emptyDisabled = (): Record<AgentContextKind, string[]> => ({
  instruction: [], skill: [], agent: [], mcp: [], settings: [],
});

function posix(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

function family(harness: string): string {
  return harness === "codex-wsl" ? "codex" : harness;
}

function preferredSkill(harness: string): string {
  const f = family(harness);
  if (f === "codex") return ".codex/skills";
  if (f === "opencode") return ".opencode/skills";
  if (f === "grok") return ".grok/skills";
  return ".claude/skills";
}

function preferredAgent(harness: string): string {
  const f = family(harness);
  if (f === "codex") return ".codex/agents";
  if (f === "opencode") return ".opencode/agents";
  if (f === "grok") return ".grok/agents";
  return ".claude/agents";
}

function preferredMcp(harness: string): string {
  const f = family(harness);
  if (f === "grok") return ".grok/mcp.json";
  if (f === "opencode") return ".opencode/mcp.json";
  return ".mcp.json";
}

function orderRoots(roots: string[], preferred: string): string[] {
  return [preferred, ...roots.filter((root) => root !== preferred)];
}

function readCapped(abs: string): { text: string } | { error: string } | null {
  try {
    const st = lstatSync(abs);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    if (st.size > MAX_ASSET_FILE_BYTES) return { error: "the file is too large" };
    return { text: readFileSync(abs, "utf8") };
  } catch {
    return null;
  }
}

function skillMeta(id: string, files: AssetFiles): { name: string; description: string; error: string | null } {
  const parsed = parseAsset("skill", id, files);
  return { name: parsed.name, description: parsed.description, error: parsed.error };
}

function mcpStartFrom(raw: unknown): { start: McpServerStart } | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "MCP server must be a JSON object" };
  const spec = raw as Record<string, unknown>;
  const type = typeof spec.type === "string" ? spec.type : typeof spec.command === "string" ? "stdio" : typeof spec.url === "string" ? "http" : "";
  const strings = (v: unknown) => (Array.isArray(v) && v.every((x) => typeof x === "string") ? v as string[] : undefined);
  const record = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) && Object.values(v as Record<string, unknown>).every((x) => typeof x === "string")
    ? v as Record<string, string> : undefined);
  if (type === "stdio" && typeof spec.command === "string") {
    const start: McpServerStart = { type: "stdio", command: spec.command };
    const args = strings(spec.args);
    const env = record(spec.env);
    if (args) start.args = args;
    if (env) start.env = env;
    return { start };
  }
  if ((type === "http" || type === "sse") && typeof spec.url === "string") {
    const start: McpServerStart = { type, url: spec.url };
    const headers = record(spec.headers);
    if (headers) start.headers = headers;
    return { start };
  }
  return { error: "MCP server needs a command or a url" };
}

/** Every project file that can be agent context. `root` is the directory or file the item was found in. */
export function scanProject(cwd: string): Found[] {
  const found: Found[] = [];
  if (!cwd) return found;
  try {
    if (!lstatSync(cwd).isDirectory()) return found;
  } catch {
    return found;
  }

  for (const root of SKILL_ROOTS) {
    let names: string[] = [];
    try {
      names = readdirSync(join(cwd, root));
    } catch {
      continue;
    }
    for (const id of names.sort()) {
      if (!PROJECT_ID.test(id)) continue;
      const dir = join(cwd, root, id);
      try {
        if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) continue;
      } catch {
        continue;
      }
      const tree = readTree(dir);
      const meta = skillMeta(id, tree.files);
      found.push({
        kind: "skill", id, name: meta.name, description: meta.description, path: `${root}/${id}`, root,
        error: tree.error ?? meta.error, files: tree.files, entry: "SKILL.md",
      });
    }
  }

  for (const root of AGENT_ROOTS) {
    let names: string[] = [];
    try {
      names = readdirSync(join(cwd, root));
    } catch {
      continue;
    }
    for (const file of names.sort()) {
      if (!file.endsWith(".md")) continue;
      const id = file.slice(0, -3);
      if (!PROJECT_ID.test(id)) continue;
      const abs = join(cwd, root, file);
      const read = readCapped(abs);
      if (!read) continue;
      if ("error" in read) {
        found.push({ kind: "agent", id, name: id, description: "", path: `${root}/${file}`, root, error: read.error, files: {}, entry: file });
        continue;
      }
      const parsed = parseAgentFile(id, read.text, file);
      found.push({
        kind: "agent", id, name: parsed.name, description: parsed.description, path: `${root}/${file}`, root,
        error: parsed.error, files: { [file]: read.text }, entry: file,
      });
    }
  }

  for (const file of MCP_FILES) {
    const abs = join(cwd, file);
    const read = readCapped(abs);
    if (!read) continue;
    if ("error" in read) {
      found.push({ kind: "mcp", id: file, name: file, description: "", path: file, root: file, error: read.error, files: {}, entry: file });
      continue;
    }
    let doc: Record<string, unknown> | null;
    try {
      doc = parseJsonObject(read.text, file);
    } catch (err) {
      found.push({ kind: "mcp", id: file, name: file, description: "", path: file, root: file, error: (err as Error).message, files: {}, entry: file });
      continue;
    }
    const servers = doc?.mcpServers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) continue;
    for (const [id, spec] of Object.entries(servers)) {
      if (!PROJECT_ID.test(id)) continue;
      const parsed = mcpStartFrom(spec);
      const name = spec && typeof spec === "object" && !Array.isArray(spec) && typeof (spec as { name?: unknown }).name === "string"
        ? (spec as { name: string }).name : id;
      found.push({
        kind: "mcp", id, name, description: "", path: file, root: file,
        error: "error" in parsed ? parsed.error : null,
        files: { [`${id}.json`]: formatJson(spec) }, entry: `${id}.json`,
      });
    }
  }

  const agentsMd = readCapped(join(cwd, "AGENTS.md"));
  if (agentsMd && "text" in agentsMd) {
    const text = agentsMd.text;
    found.push({
      kind: "instruction", id: "agents-md", name: "AGENTS.md", description: "Instructions in the project root",
      path: "AGENTS.md", root: "AGENTS.md", error: null, files: { "AGENTS.md": text }, entry: "AGENTS.md",
    });
    const re = /<!-- odin:([a-z0-9][a-z0-9-]{0,63}):start -->\n([\s\S]*?)\n<!-- odin:\1:end -->/g;
    for (const match of text.matchAll(re)) {
      const id = match[1]!;
      const body = `${match[2] ?? ""}\n`;
      found.push({
        kind: "instruction", id, name: id, description: "Instruction fragment in AGENTS.md",
        path: "AGENTS.md", root: `fragment:${id}`, error: null, files: { "AGENTS.md": body }, entry: "AGENTS.md",
      });
    }
  } else if (agentsMd && "error" in agentsMd) {
    found.push({
      kind: "instruction", id: "agents-md", name: "AGENTS.md", description: "", path: "AGENTS.md", root: "AGENTS.md",
      error: agentsMd.error, files: {}, entry: "AGENTS.md",
    });
  }

  const claudeMd = readCapped(join(cwd, "CLAUDE.md"));
  if (claudeMd && "text" in claudeMd) {
    found.push({
      kind: "instruction", id: "claude-md", name: "CLAUDE.md", description: "Claude Code project instructions",
      path: "CLAUDE.md", root: "CLAUDE.md", error: null, files: { "CLAUDE.md": claudeMd.text }, entry: "CLAUDE.md",
    });
  }

  for (const [id, file] of [["claude-settings", ".claude/settings.json"], ["claude-settings-local", ".claude/settings.local.json"]] as const) {
    const read = readCapped(join(cwd, file));
    if (!read) continue;
    if ("error" in read) {
      found.push({ kind: "settings", id, name: file, description: "", path: file, root: file, error: read.error, files: {}, entry: "settings.json" });
      continue;
    }
    found.push({
      kind: "settings", id, name: file, description: "Settings Claude Code reads from this project",
      path: file, root: file, error: null, files: { "settings.json": read.text }, entry: "settings.json",
    });
  }

  const settingsDir = join(cwd, ".odin", "settings");
  let settingsNames: string[] = [];
  try {
    settingsNames = readdirSync(settingsDir);
  } catch {
    settingsNames = [];
  }
  for (const file of settingsNames.sort()) {
    if (!file.endsWith(".json")) continue;
    const id = file.slice(0, -5);
    if (!ASSET_ID_PATTERN.test(id)) continue;
    const read = readCapped(join(settingsDir, file));
    if (!read || "error" in read) {
      found.push({
        kind: "settings", id, name: id, description: "", path: `.odin/settings/${file}`, root: ".odin/settings",
        error: read && "error" in read ? read.error : "unreadable", files: {}, entry: file,
      });
      continue;
    }
    const parsed = parseAsset("settings", id, { [`${id}.json`]: read.text });
    found.push({
      kind: "settings", id, name: parsed.name || id, description: parsed.description, path: `.odin/settings/${file}`,
      root: ".odin/settings", error: parsed.error, files: { [`${id}.json`]: read.text }, entry: file,
    });
  }
  return found;
}

function prefer(items: Found[], roots: string[]): Found[] {
  const rank = new Map(roots.map((root, i) => [root, i]));
  const best = new Map<string, Found>();
  for (const item of items) {
    const prev = best.get(item.id);
    const itemRank = rank.get(item.root) ?? 99;
    const prevRank = prev ? (rank.get(prev.root) ?? 99) : 100;
    if (!prev || itemRank < prevRank) best.set(item.id, item);
  }
  return [...best.values()];
}

function materialize(home: string, key: string, files: AssetFiles): string {
  const dir = resolveInside(home, `native-library/agent-context/${key}`);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileAtomic(resolveInside(dir, name), content);
  return dir;
}

export function createAgentContextService(deps: Deps, services: Services) {
  const { db, bus } = deps;

  function requireProject(name: string): string {
    const ref = services.projects.get(name);
    if (!ref) throw new HttpError(404, `unknown project "${name}"`);
    if (ref.missing) throw new HttpError(409, `project ${name} is missing on disk`);
    return ref.path;
  }

  function loadDisabled(name: string): Record<AgentContextKind, string[]> {
    const row = db.prepare("SELECT context_disabled FROM projects WHERE name = ?").get(name) as { context_disabled: string } | undefined;
    if (!row) throw new HttpError(404, `unknown project "${name}"`);
    const out = emptyDisabled();
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.context_disabled || "{}");
    } catch {
      return out;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
    for (const kind of AGENT_CONTEXT_KINDS) {
      const list = (parsed as Record<string, unknown>)[kind];
      if (Array.isArray(list)) out[kind] = [...new Set(list.filter((id): id is string => typeof id === "string"))];
    }
    return out;
  }

  function saveDisabled(name: string, disabled: Record<AgentContextKind, string[]>): void {
    db.prepare("UPDATE projects SET context_disabled = ?, updated_at = ? WHERE name = ?").run(
      JSON.stringify(disabled), deps.now().toISOString(), name,
    );
    bus.emit({ type: "project.updated", project: name });
  }

  function libraryPieces(): Piece[] {
    const pieces: Piece[] = [];
    for (const kind of AGENT_CONTEXT_KINDS) {
      for (const asset of services.library.list(kind)) {
        const files = services.library.files(kind, asset.id) ?? {};
        pieces.push({
          kind, id: asset.id, name: asset.name, description: asset.description, error: asset.error,
          files, meta: asset.meta, libraryEnabled: asset.enabled,
        });
      }
    }
    for (const plugin of services.library.list("plugin")) {
      if (!plugin.enabled || plugin.error) continue;
      const files = services.library.files("plugin", plugin.id);
      if (!files) continue;
      for (const member of pluginOwnFiles(files).members) {
        if (pieces.some((piece) => piece.kind === member.kind && piece.id === member.id)) continue;
        const parsed = parseAsset(member.kind, member.id, member.files);
        pieces.push({
          kind: member.kind, id: member.id, name: parsed.name, description: parsed.description, error: parsed.error,
          files: member.files, meta: parsed.meta, libraryEnabled: true,
        });
      }
    }
    return pieces;
  }

  function view(name: string, cwd: string): ProjectAgentContext {
    const disabled = loadDisabled(name);
    const project = scanProject(cwd);
    const overridden = new Set(project.map((item) => `${item.kind}/${item.id}`));
    const global = libraryPieces().map((piece): AgentContextItem => ({
      kind: piece.kind,
      id: piece.id,
      name: piece.name,
      description: piece.description,
      origin: "library",
      path: null,
      overridden: overridden.has(`${piece.kind}/${piece.id}`),
      libraryEnabled: piece.libraryEnabled,
      enabled: piece.libraryEnabled && !disabled[piece.kind].includes(piece.id),
      error: piece.error,
    })).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    return {
      global,
      project: project.map((item): AgentContextItem => ({
        kind: item.kind, id: item.id, name: item.name, description: item.description, origin: "project",
        path: item.path, overridden: false, libraryEnabled: true, enabled: true, error: item.error,
      })).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || (a.path ?? "").localeCompare(b.path ?? "")),
    };
  }

  function knownGlobal(name: string, kind: AgentContextKind, id: string): void {
    if (!view(name, requireProject(name)).global.some((item) => item.kind === kind && item.id === id)) {
      throw new HttpError(404, `unknown library ${kind} ${id}`);
    }
  }

  function checkFiles(files: AssetFiles): void {
    const keys = Object.keys(files);
    if (!keys.length || keys.length > MAX_ASSET_FILES) throw new HttpError(400, "files must hold 1 to 64 files");
    for (const [key, content] of Object.entries(files)) {
      const problem = pathError(key);
      if (problem) throw new HttpError(400, problem);
      if (typeof content !== "string") throw new HttpError(400, `${key} must be text`);
      if (Buffer.byteLength(content) > MAX_ASSET_FILE_BYTES) throw new HttpError(400, `${key} is too large`);
    }
  }

  function note(name: string, paths: string[]): void {
    services.projects.noteWritten(name, paths);
    bus.emit({ type: "project.updated", project: name });
  }

  function kindOf(kind: string): AgentContextKind {
    if (!(AGENT_CONTEXT_KINDS as readonly string[]).includes(kind)) throw new HttpError(400, `unknown context kind ${kind}`);
    return kind as AgentContextKind;
  }

  async function fillServer(id: string, start: McpServerStart, oauth: boolean): Promise<McpServerStart> {
    const fill = (text: string) => (text.includes("${secret:") ? services.secrets.fill(text, `MCP server ${id}`) : text);
    const map = (record: Record<string, string> | undefined) => (record ? Object.fromEntries(Object.entries(record).map(([key, value]) => [key, fill(value)])) : undefined);
    if (start.type === "stdio") {
      const env = map(start.env);
      return { ...start, ...(start.args ? { args: start.args.map(fill) } : {}), ...(env ? { env } : {}) };
    }
    const headers = map(start.headers);
    const next: McpServerStart = { ...start, url: fill(start.url), ...(headers ? { headers } : {}) };
    if (!oauth) return next;
    return { ...next, headers: { ...next.headers, Authorization: `Bearer ${await services.mcpOAuth.accessToken(id)}` } };
  }

  return {
    get(name: string): ProjectAgentContext {
      return view(name, requireProject(name));
    },

    files(name: string, kindRaw: string, id: string): AgentContextFiles {
      const kind = kindOf(kindRaw);
      const cwd = requireProject(name);
      const matches = scanProject(cwd).filter((item) => item.kind === kind && item.id === id);
      const item = matches.find((row) => row.root === ".claude/skills" || row.root === ".claude/agents" || row.root === ".mcp.json" || row.root === ".odin/settings") ?? matches[0];
      if (!item) throw new HttpError(404, `no ${kind} ${id} in this project`);
      return { path: item.path, entry: item.entry, files: item.files };
    },

    setEnabled(name: string, req: SetAgentContextEnabledRequest): ProjectAgentContext {
      if (!req || typeof req !== "object") throw new HttpError(400, "invalid request");
      const kind = kindOf(req.kind);
      if (typeof req.id !== "string" || !req.id) throw new HttpError(400, "id is required");
      if (typeof req.enabled !== "boolean") throw new HttpError(400, "enabled must be a boolean");
      const cwd = requireProject(name);
      knownGlobal(name, kind, req.id);
      const piece = libraryPieces().find((item) => item.kind === kind && item.id === req.id);
      if (req.enabled && piece && !piece.libraryEnabled) throw new HttpError(409, `${kind} ${req.id} is off in the library`);
      const disabled = loadDisabled(name);
      const list = new Set(disabled[kind]);
      if (req.enabled) list.delete(req.id);
      else list.add(req.id);
      disabled[kind] = [...list].sort();
      saveDisabled(name, disabled);
      return view(name, cwd);
    },

    write(name: string, kindRaw: string, id: string, files: AssetFiles): ProjectAgentContext {
      const kind = kindOf(kindRaw);
      const cwd = requireProject(name);
      if (!files || typeof files !== "object" || Array.isArray(files)) throw new HttpError(400, "files are required");
      checkFiles(files);
      const changed: string[] = [];
      if (kind === "skill") {
        if (!ASSET_ID_PATTERN.test(id)) throw new HttpError(400, "invalid id");
        if (typeof files["SKILL.md"] !== "string") throw new HttpError(400, "a skill needs SKILL.md");
        const parsed = parseAsset("skill", id, files);
        if (parsed.error) throw new HttpError(400, parsed.error);
        replaceDirAtomic(resolveInside(cwd, `.claude/skills/${id}`), files);
        changed.push(...Object.keys(files).map((file) => `.claude/skills/${id}/${file}`));
      } else if (kind === "agent") {
        if (!ASSET_ID_PATTERN.test(id)) throw new HttpError(400, "invalid id");
        const content = files[`${id}.md`];
        if (typeof content !== "string") throw new HttpError(400, `an agent needs ${id}.md`);
        const parsed = parseAgentFile(id, content);
        if (parsed.error) throw new HttpError(400, parsed.error);
        writeFileAtomic(resolveInside(cwd, `.claude/agents/${id}.md`), content);
        changed.push(`.claude/agents/${id}.md`);
      } else if (kind === "mcp") {
        if (!ASSET_ID_PATTERN.test(id)) throw new HttpError(400, "invalid id");
        const content = files[`${id}.json`];
        if (typeof content !== "string") throw new HttpError(400, `an MCP server needs ${id}.json`);
        let spec: unknown;
        try {
          spec = JSON.parse(content);
        } catch {
          throw new HttpError(400, `${id}.json is not valid JSON`);
        }
        const parsed = mcpStartFrom(spec);
        if ("error" in parsed) throw new HttpError(400, parsed.error);
        const abs = resolveInside(cwd, ".mcp.json");
        const current = readCapped(abs);
        const doc = parseJsonObject(current && "text" in current ? current.text : null, ".mcp.json");
        writeFileAtomic(abs, formatJson(setMcpEntry(doc, id, spec)));
        changed.push(".mcp.json");
      } else if (kind === "instruction") {
        if (id === "agents-md" || id === "claude-md") {
          const key = id === "agents-md" ? "AGENTS.md" : "CLAUDE.md";
          if (typeof files[key] !== "string") throw new HttpError(400, `${key} is required`);
          writeFileAtomic(resolveInside(cwd, key), files[key]);
          changed.push(key);
        } else {
          if (!ASSET_ID_PATTERN.test(id)) throw new HttpError(400, "invalid id");
          if (typeof files["AGENTS.md"] !== "string") throw new HttpError(400, "AGENTS.md is required");
          if (/<!--\s*odin:/.test(files["AGENTS.md"])) throw new HttpError(400, "Odin instruction markers are reserved");
          const abs = resolveInside(cwd, "AGENTS.md");
          const current = readCapped(abs);
          const text = current && "text" in current ? current.text : "";
          writeFileAtomic(abs, setInstruction(text, id, files["AGENTS.md"]));
          changed.push("AGENTS.md");
        }
      } else if (kind === "settings") {
        if (id === "claude-settings" || id === "claude-settings-local") {
          if (typeof files["settings.json"] !== "string") throw new HttpError(400, "settings.json is required");
          parseJsonObject(files["settings.json"], "settings.json");
          const rel = id === "claude-settings" ? ".claude/settings.json" : ".claude/settings.local.json";
          writeFileAtomic(resolveInside(cwd, rel), files["settings.json"]);
          changed.push(rel);
        } else {
          if (!ASSET_ID_PATTERN.test(id)) throw new HttpError(400, "invalid id");
          const content = files[`${id}.json`];
          if (typeof content !== "string") throw new HttpError(400, `${id}.json is required`);
          const parsed = parseAsset("settings", id, { [`${id}.json`]: content });
          if (parsed.error) throw new HttpError(400, parsed.error);
          writeFileAtomic(resolveInside(cwd, `.odin/settings/${id}.json`), content);
          changed.push(`.odin/settings/${id}.json`);
        }
      }
      note(name, changed);
      return view(name, cwd);
    },

    remove(name: string, kindRaw: string, id: string): ProjectAgentContext {
      const kind = kindOf(kindRaw);
      const cwd = requireProject(name);
      const matches = scanProject(cwd).filter((item) => item.kind === kind && item.id === id);
      if (!matches.length) throw new HttpError(404, `no ${kind} ${id} in this project`);
      const changed: string[] = [];
      if (kind === "skill") {
        for (const item of matches) {
          rmSync(resolveInside(cwd, item.path), { recursive: true, force: true });
          changed.push(item.path);
        }
      } else if (kind === "agent") {
        for (const item of matches) {
          rmSync(resolveInside(cwd, item.path), { force: true });
          changed.push(item.path);
        }
      } else if (kind === "mcp") {
        const files = [...new Set(matches.map((item) => item.path))];
        for (const file of files) {
          const abs = resolveInside(cwd, file);
          const current = readCapped(abs);
          if (!current || !("text" in current)) continue;
          const doc = parseJsonObject(current.text, file);
          if (!doc) continue;
          writeFileAtomic(abs, formatJson(removeMcpEntry(doc, id)));
          changed.push(file);
        }
      } else if (kind === "instruction") {
        if (id === "agents-md" || id === "claude-md") {
          const file = id === "agents-md" ? "AGENTS.md" : "CLAUDE.md";
          rmSync(resolveInside(cwd, file), { force: true });
          changed.push(file);
        } else {
          const abs = resolveInside(cwd, "AGENTS.md");
          const current = readCapped(abs);
          if (current && "text" in current) {
            writeFileAtomic(abs, setInstruction(current.text, id, null));
            changed.push("AGENTS.md");
          }
        }
      } else if (kind === "settings") {
        for (const item of matches) {
          rmSync(resolveInside(cwd, item.path), { force: true });
          changed.push(item.path);
        }
      }
      note(name, changed);
      return view(name, cwd);
    },

    async resolve(name: string, cwd: string, harness: string): Promise<ResolvedAgentContext> {
      const disabled = loadDisabled(name);
      const pieces = libraryPieces();
      const globalInstruction = pieces.find((piece) => piece.kind === "instruction" && piece.id === "global");
      if (globalInstruction?.error && globalInstruction.libraryEnabled && !disabled.instruction.includes("global")) {
        throw new HttpError(400, `Global AGENTS.md has errors: ${globalInstruction.error}`);
      }
      const scanned = scanProject(cwd);
      const off = (kind: AgentContextKind, id: string) => disabled[kind].includes(id);
      const projectIds = (kind: AgentContextKind) => new Set(scanned.filter((item) => item.kind === kind).map((item) => item.id));

      const agentsMd = scanned.find((item) => item.kind === "instruction" && item.id === "agents-md" && !item.error);
      const fragmentIds = new Set(scanned.filter((item) => item.kind === "instruction" && item.root.startsWith("fragment:")).map((item) => item.id));
      const instructionParts: string[] = [];
      const globalText = globalInstruction && globalInstruction.libraryEnabled && !globalInstruction.error && !off("instruction", "global") && !fragmentIds.has("global")
        ? globalInstruction.files["AGENTS.md"]?.trim() : "";
      if (globalText) instructionParts.push(globalText);
      for (const piece of pieces.filter((item) => item.kind === "instruction" && item.id !== "global" && item.libraryEnabled && !item.error && !off("instruction", item.id))) {
        if (fragmentIds.has(piece.id)) continue;
        const text = piece.files["AGENTS.md"]?.trim();
        if (text) instructionParts.push(text);
      }

      const skillRoots = orderRoots(SKILL_ROOTS, preferredSkill(harness));
      const projectSkills = prefer(scanned.filter((item) => item.kind === "skill"), skillRoots);
      const skills: ResolvedAgentContext["skills"] = [];
      for (const item of projectSkills) {
        if (item.error || !item.files["SKILL.md"]) continue;
        const dir = join(cwd, item.path);
        skills.push({ name: item.id, description: item.description, path: join(dir, "SKILL.md"), files: item.files });
      }
      const skillIds = new Set(skills.map((skill) => skill.name));
      for (const piece of pieces.filter((item) => item.kind === "skill" && item.libraryEnabled && !item.error && !off("skill", item.id))) {
        if (skillIds.has(piece.id) || projectIds("skill").has(piece.id)) continue;
        if (!piece.files["SKILL.md"]) continue;
        const dir = materialize(deps.config.home, `${piece.id}-${filesHash(piece.files)}`, piece.files);
        skills.push({ name: piece.id, description: piece.description, path: join(dir, "SKILL.md"), files: piece.files });
      }

      const agentRoots = orderRoots(AGENT_ROOTS, preferredAgent(harness));
      const projectAgents = prefer(scanned.filter((item) => item.kind === "agent"), agentRoots);
      const agents: Record<string, AgentSpec> = {};
      for (const item of projectAgents) {
        if (item.error) continue;
        const parsed = parseAgentFile(item.id, item.files[item.entry] ?? "");
        if (parsed.error) continue;
        agents[item.id] = {
          description: parsed.description, prompt: parsed.prompt,
          ...(parsed.tools ? { tools: parsed.tools } : {}), ...(parsed.model ? { model: parsed.model } : {}),
        };
      }
      for (const piece of pieces.filter((item) => item.kind === "agent" && item.libraryEnabled && !item.error && !off("agent", item.id))) {
        if (piece.id in agents || projectIds("agent").has(piece.id)) continue;
        const content = piece.files[`${piece.id}.md`];
        if (!content) continue;
        const parsed = parseAgentFile(piece.id, content);
        if (parsed.error) continue;
        agents[piece.id] = {
          description: parsed.description, prompt: parsed.prompt,
          ...(parsed.tools ? { tools: parsed.tools } : {}), ...(parsed.model ? { model: parsed.model } : {}),
        };
      }

      const mcpRoots = [...MCP_FILES.filter((file) => file !== preferredMcp(harness)), preferredMcp(harness)];
      const mcpServers: Record<string, McpServerStart> = {};
      const mcpErrors = new Set<string>();
      // A library server with OAuth always comes from the library (with its token): a project file entry of the same id
      // carries no token, so it is ignored. docs/contracts.md#library (install).
      const libraryMcp = pieces.filter((item) => item.kind === "mcp" && item.libraryEnabled && !item.error && !off("mcp", item.id));
      const oauthIds = new Set(libraryMcp.filter((item) => !!item.meta.oauth).map((item) => item.id));
      for (const file of mcpRoots) {
        for (const item of scanned.filter((row) => row.kind === "mcp" && row.root === file)) {
          if (oauthIds.has(item.id)) continue;
          if (item.error) {
            mcpErrors.add(item.id);
            continue;
          }
          const spec = mcpStartFrom(JSON.parse(item.files[item.entry] ?? "null"));
          if ("error" in spec) continue;
          try {
            const library = pieces.find((piece) => piece.kind === "mcp" && piece.id === item.id);
            mcpServers[item.id] = await fillServer(item.id, spec.start, !!library?.meta.oauth);
          } catch (err) {
            delete mcpServers[item.id];
            console.warn(`MCP server ${item.id} left out of the session: ${err instanceof Error ? err.message : "unknown error"}`);
          }
        }
      }
      for (const piece of libraryMcp) {
        if (!oauthIds.has(piece.id) && (piece.id in mcpServers || projectIds("mcp").has(piece.id) || mcpErrors.has(piece.id))) continue;
        try {
          const resolved = await services.launch.resolveMcpServers([piece.id], { skipDisabled: true });
          const server = resolved[piece.id];
          if (server) mcpServers[piece.id] = server;
        } catch (err) {
          // A global server that is missing a secret (or a sign-in) stays out of this session.
          console.warn(`MCP server ${piece.id} left out of the session: ${err instanceof Error ? err.message : "unknown error"}`);
        }
      }
      if (family(harness) === "claude") {
        // Claude reads .mcp.json itself; OAuth library servers stay injected (the file entry has no token).
        for (const item of scanned.filter((row) => row.kind === "mcp" && row.root === ".mcp.json")) if (!oauthIds.has(item.id)) delete mcpServers[item.id];
      }

      const settings: SettingsProfileSpec[] = [];
      const usedSettings = new Set<string>();
      for (const item of scanned.filter((row) => row.kind === "settings" && row.root === ".odin/settings" && !row.error)) {
        const parsed = parseAsset("settings", item.id, item.files);
        if (parsed.error) continue;
        settings.push(parsed.meta as unknown as SettingsProfileSpec);
        usedSettings.add(item.id);
      }
      let installed: { kind: string; id: string }[] = [];
      try {
        installed = services.library.installations(name).map((row) => ({ kind: row.kind, id: row.id }));
      } catch {
        installed = [];
      }
      for (const row of installed) {
        if (row.kind !== "settings" || usedSettings.has(row.id) || off("settings", row.id)) continue;
        try {
          const files = services.library.projectFiles(name, "settings", row.id);
          if (!files) continue;
          const parsed = parseAsset("settings", row.id, files);
          if (parsed.error) continue;
          settings.push(parsed.meta as unknown as SettingsProfileSpec);
          usedSettings.add(row.id);
        } catch {
          // A broken settings file does not block the session.
        }
      }
      for (const piece of pieces.filter((item) => item.kind === "settings" && item.libraryEnabled && !item.error && !off("settings", item.id))) {
        if (usedSettings.has(piece.id) || projectIds("settings").has(piece.id)) continue;
        settings.push(piece.meta as unknown as SettingsProfileSpec);
      }

      let claudePluginPath: string | null = null;
      const sessionAgents = { ...agents };
      if (family(harness) === "claude") {
        for (const item of scanned.filter((row) => row.kind === "agent" && row.root === ".claude/agents")) delete sessionAgents[item.id];
        const pluginFiles: AssetFiles = {};
        for (const skill of skills) {
          if (skill.path.includes(`${sep}.claude${sep}skills${sep}`) || skill.path.includes("/.claude/skills/")) continue;
          for (const [file, content] of Object.entries(skill.files ?? {})) pluginFiles[`skills/${skill.name}/${file}`] = content;
        }
        for (const [id, spec] of Object.entries(sessionAgents)) {
          const tools = spec.tools?.length ? `\ntools: ${spec.tools.join(", ")}` : "";
          const model = spec.model ? `\nmodel: ${spec.model}` : "";
          pluginFiles[`agents/${id}.md`] = `---\nname: ${id}\ndescription: ${JSON.stringify(spec.description)}${tools}${model}\n---\n\n${spec.prompt}`;
        }
        const hooks: Record<string, unknown[]> = {};
        for (const spec of settings) {
          for (const [event, entries] of Object.entries(spec.hooks ?? {})) {
            if (Array.isArray(entries)) hooks[event] = [...(hooks[event] ?? []), ...entries];
          }
        }
        if (Object.keys(hooks).length) pluginFiles["hooks/hooks.json"] = formatJson({ hooks });
        if (Object.keys(pluginFiles).length) {
          pluginFiles[".claude-plugin/plugin.json"] = formatJson({ name: "odin-context", description: "Global and project context from Odin", version: "1" });
          claudePluginPath = materialize(deps.config.home, `plugin-${filesHash(pluginFiles)}`, pluginFiles);
        }
        for (const id of Object.keys(sessionAgents)) delete sessionAgents[id];
      }

      const skillNote = family(harness) === "grok" || family(harness) === "antigravity"
        ? (skills.length
          ? `Skills available in this session (read the SKILL.md before using one):\n${skills.map((skill) => `- ${skill.name}: ${skill.path}${skill.description ? ` — ${skill.description}` : ""}`).join("\n")}`
          : null)
        : null;

      let permissionNote: string | null = null;
      if (family(harness) === "claude") {
        const lines = settings.flatMap((spec) => {
          const allow = spec.permissions?.allow ?? [];
          const deny = spec.permissions?.deny ?? [];
          const ask = spec.permissions?.ask ?? [];
          if (!allow.length && !deny.length && !ask.length) return [];
          return [`Allow: ${allow.join(", ") || "none"}. Deny: ${deny.join(", ") || "none"}. Ask: ${ask.join(", ") || "none"}.`];
        });
        if (lines.length) permissionNote = `Permission defaults from settings profiles:\n${lines.join("\n")}`;
      }

      return {
        libraryInstructions: [...instructionParts, permissionNote].filter(Boolean).join("\n\n"),
        projectAgentsMd: agentsMd?.files["AGENTS.md"] ?? null,
        skillNote,
        agents: sessionAgents,
        mcpServers,
        skills,
        settings,
        claudePluginPath,
      };
    },
  };
}

export type AgentContextService = ReturnType<typeof createAgentContextService>;
