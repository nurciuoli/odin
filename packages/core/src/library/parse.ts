// Library assets: per-kind parsing of an asset's files into name, description and meta, never throwing. Problems are
// reported in `error`. docs/contracts.md#library.
import type { AssetFiles, AssetKind, McpServerSpec, PermissionMode, SettingsProfileSpec, TemplateSpec } from "@odin/shared/api";
import { ASSET_ID_PATTERN, LIBRARY_LAYOUT, LIBRARY_AGENT_PREFIX, badSecretRef, promptVariables } from "@odin/shared/library";
import { parseAgentFile } from "../agents/parse.ts";
import { type FrontmatterValue, parseFrontmatter } from "../frontmatter.ts";

export const MAX_ASSET_FILES = 64;
export const MAX_ASSET_FILE_BYTES = 1024 * 1024;

export interface ParsedAsset {
  name: string;
  description: string;
  meta: Record<string, unknown>;
  error: string | null;
}

const PERMISSION_MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk", "auto"];

/** The one file key of a single-file asset (`<id><ext>`), or the entry file of a folder asset (`SKILL.md`). */
export function entryFile(kind: AssetKind, id: string): string {
  const layout = LIBRARY_LAYOUT[kind];
  return layout.shape === "file" ? `${id}${layout.entry}` : layout.entry;
}

/**
 * A safe asset-relative path: forward slashes, no empty / `.` / `..` segments, not absolute, no backslashes, NUL or
 * control characters. Returns an error message or null.
 */
export function pathError(path: string): string | null {
  if (typeof path !== "string" || path === "") return "empty file path";
  if (path.length > 512) return `file path too long: ${path.slice(0, 40)}…`;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return `absolute file path not allowed: ${path}`;
  if (/[\\\u0000-\u001f]/.test(path)) return `invalid characters in file path: ${JSON.stringify(path)}`;
  for (const seg of path.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return `invalid file path: ${path}`;
  }
  return null;
}

/** Shape checks for a set of files: layout per kind, path safety, count and size limits. Returns an error or null. */
export function filesError(kind: AssetKind, id: string, files: unknown): string | null {
  if (!files || typeof files !== "object" || Array.isArray(files)) return "files must be an object of path → text";
  const entries = Object.entries(files as Record<string, unknown>);
  if (!entries.length) return "an asset needs at least one file";
  if (entries.length > MAX_ASSET_FILES) return `too many files (${entries.length}; at most ${MAX_ASSET_FILES})`;
  for (const [path, content] of entries) {
    const bad = pathError(path);
    if (bad) return bad;
    if (typeof content !== "string") return `${path}: content must be text`;
    if (Buffer.byteLength(content, "utf8") > MAX_ASSET_FILE_BYTES) return `${path} is larger than 1 MB`;
  }
  const entry = entryFile(kind, id);
  if (kind === "instruction" && entries.length !== 1) return "instructions contain only AGENTS.md";
  if (LIBRARY_LAYOUT[kind].shape === "file") {
    if (entries.length !== 1 || entries[0]![0] !== entry) return `a ${kind} is one file named ${entry}`;
  } else if (!Object.hasOwn(files, entry)) return `a ${kind} needs ${entry}`;
  return null;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

function fmString(data: Record<string, FrontmatterValue>, key: string, errors: string[]): string | undefined {
  const v = data[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    errors.push(`${key} must be a single value`);
    return undefined;
  }
  return v.trim() || undefined;
}

/** A markdown asset whose frontmatter is optional (commands, prompts). */
function parseLooseMarkdown(id: string, content: string, file: string, requireFrontmatter: boolean) {
  const hasFm = /^﻿?---\s*(\r?\n|$)/.test(content);
  const fm = parseFrontmatter(content, file);
  const errors = hasFm || requireFrontmatter ? [...fm.errors] : [];
  const data = fm.data ?? {};
  const name = oneLine(fmString(data, "name", errors) ?? id);
  const description = oneLine(fmString(data, "description", errors) ?? "");
  return { fm, data, errors, name, description, body: hasFm ? fm.body : content.replace(/^﻿/, "") };
}

/** Parses an asset's files per kind. Assumes `files` passed filesError; reports anything else in `error`. */
export function parseAsset(kind: AssetKind, id: string, files: AssetFiles): ParsedAsset {
  const entry = entryFile(kind, id);
  const content = files[entry];
  if (content === undefined) return { name: id, description: "", meta: {}, error: `missing ${entry}` };
  switch (kind) {
    case "instruction":
      return { name: id === "global" ? "Global AGENTS.md" : id, description: id === "global" ? "Default instructions for every Odin session" : "Reusable project instructions", meta: {}, error: !content.trim() ? "AGENTS.md must not be empty" : /<!--\s*odin:/.test(content) ? "Odin instruction markers are reserved for installation" : null };
    case "agent": {
      const a = parseAgentFile(id, content, entry);
      return { name: a.name, description: a.description, meta: { model: a.model, tools: a.tools }, error: a.error };
    }
    case "skill": {
      const p = parseLooseMarkdown(id, content, entry, true);
      if (p.fm.data && !p.description) p.errors.push("SKILL.md needs a description");
      return { name: p.name, description: p.description, meta: {}, error: join(p.errors) };
    }
    case "command": {
      const p = parseLooseMarkdown(id, content, entry, false);
      const hint = fmString(p.data, "argument-hint", p.errors) ?? null;
      const model = fmString(p.data, "model", p.errors) ?? null;
      return { name: p.name, description: p.description, meta: { argumentHint: hint, model }, error: join(p.errors) };
    }
    case "prompt": {
      const p = parseLooseMarkdown(id, content, entry, false);
      return { name: p.name, description: p.description, meta: { variables: promptVariables(p.body) }, error: join(p.errors) };
    }
    case "template":
    case "mcp":
    case "settings":
      return parseJsonAsset(kind, id, content);
  }
}

/** The prompt body of a prompt asset: frontmatter stripped (when present). */
export function promptBody(content: string): string {
  const hasFm = /^﻿?---\s*(\r?\n|$)/.test(content);
  return hasFm ? parseFrontmatter(content).body : content.replace(/^﻿/, "");
}

function join(errors: string[]): string | null {
  return errors.length ? errors.join("; ") : null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const isStringMap = (v: unknown): v is Record<string, string> => isObj(v) && Object.values(v).every((x) => typeof x === "string");

function parseJsonAsset(kind: "template" | "mcp" | "settings", id: string, content: string): ParsedAsset {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    return { name: id, description: "", meta: {}, error: `${id}.json is not valid JSON: ${(err as Error).message}` };
  }
  if (!isObj(raw)) return { name: id, description: "", meta: {}, error: `${id}.json must hold a JSON object` };
  const errors: string[] = [];
  const name = typeof raw.name === "string" && raw.name.trim() ? oneLine(raw.name) : id;
  if (raw.name !== undefined && typeof raw.name !== "string") errors.push("name must be a string");
  const description = typeof raw.description === "string" ? oneLine(raw.description) : "";
  if (raw.description !== undefined && typeof raw.description !== "string") errors.push("description must be a string");
  const { name: _n, description: _d, ...spec } = raw;
  const meta =
    kind === "template" ? validateTemplate(spec, errors) :
    kind === "mcp" ? validateMcp(spec, errors) :
    validateSettings(spec, errors);
  return { name, description, meta: (meta ?? {}) as Obj, error: join(errors) };
}

function unknownKeys(spec: Obj, allowed: string[], errors: string[], where = ""): void {
  for (const key of Object.keys(spec)) if (!allowed.includes(key)) errors.push(`unknown field ${where}${key}`);
}

export function validateTemplate(spec: Obj, errors: string[]): TemplateSpec {
  unknownKeys(spec, ["harness", "harnessOverrides", "prompt", "promptId", "model", "permissionMode", "agent", "worktree", "mcp", "tags"], errors);
  const out: TemplateSpec = { prompt: "", promptId: null, model: null, permissionMode: null, agent: null, worktree: false, mcp: [], tags: [] };
  if (spec.harness !== undefined) {
    if (typeof spec.harness === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(spec.harness)) out.harness = spec.harness;
    else errors.push("harness must be a runtime id");
  }
  if (spec.harnessOverrides !== undefined) {
    if (!isObj(spec.harnessOverrides)) errors.push("harnessOverrides must be a map");
    else {
      out.harnessOverrides = Object.create(null);
      for (const [family, value] of Object.entries(spec.harnessOverrides)) {
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(family) || !isObj(value)) { errors.push("invalid harness override"); continue; }
        unknownKeys(value, ["model", "permissionMode", "agent"], errors, `${family}.`);
        const override: NonNullable<TemplateSpec["harnessOverrides"]>[string] = {};
        for (const key of ["model", "agent"] as const) if (value[key] !== undefined) {
          if (typeof value[key] !== "string" || !value[key].trim()) errors.push(`${family}.${key} must be a non-empty string`);
          else override[key] = value[key].trim();
        }
        if (value.permissionMode !== undefined) {
          if (!PERMISSION_MODES.includes(value.permissionMode as PermissionMode)) errors.push(`${family}.permissionMode is invalid`);
          else override.permissionMode = value.permissionMode as PermissionMode;
        }
        out.harnessOverrides![family] = override;
      }
    }
  }
  if (spec.prompt !== undefined && spec.prompt !== null) {
    if (typeof spec.prompt === "string") out.prompt = spec.prompt;
    else errors.push("prompt must be a string");
  }
  if (spec.promptId !== undefined && spec.promptId !== null) {
    if (typeof spec.promptId === "string" && ASSET_ID_PATTERN.test(spec.promptId)) out.promptId = spec.promptId;
    else errors.push("promptId must be a library prompt id");
  }
  if (spec.model !== undefined && spec.model !== null) {
    if (typeof spec.model === "string" && spec.model.trim()) out.model = spec.model.trim();
    else errors.push("model must be a non-empty string");
  }
  if (spec.permissionMode !== undefined && spec.permissionMode !== null) {
    if (PERMISSION_MODES.includes(spec.permissionMode as PermissionMode)) out.permissionMode = spec.permissionMode as PermissionMode;
    else errors.push(`permissionMode must be one of ${PERMISSION_MODES.join(", ")}`);
  }
  if (spec.agent !== undefined && spec.agent !== null) {
    const a = spec.agent;
    const bare = typeof a === "string" && a.startsWith(LIBRARY_AGENT_PREFIX) ? a.slice(LIBRARY_AGENT_PREFIX.length) : a;
    if (typeof a === "string" && typeof bare === "string" && ASSET_ID_PATTERN.test(bare)) out.agent = a;
    else errors.push("agent must be a project agent id or library:<id>");
  }
  if (spec.worktree !== undefined && spec.worktree !== null) {
    if (typeof spec.worktree === "boolean") out.worktree = spec.worktree;
    else errors.push("worktree must be true or false");
  }
  if (spec.mcp !== undefined && spec.mcp !== null) {
    if (isStringArray(spec.mcp) && spec.mcp.every((m) => ASSET_ID_PATTERN.test(m))) out.mcp = [...new Set(spec.mcp)];
    else errors.push("mcp must be a list of library MCP ids");
  }
  if (spec.tags !== undefined && spec.tags !== null) {
    if (isStringArray(spec.tags)) out.tags = [...new Set(spec.tags.map((t) => t.trim()).filter(Boolean))];
    else errors.push("tags must be a list of strings");
  }
  return out;
}

export function validateMcp(spec: Obj, errors: string[]): McpServerSpec | null {
  const out = validateMcpShape(spec, errors);
  if (out) {
    const strings = [
      ...(out.type === "stdio" ? [...(out.args ?? []), ...Object.values(out.env ?? {})] : [out.url, ...Object.values(out.headers ?? {})]),
    ];
    const bad = strings.map(badSecretRef).find((b) => b !== null);
    if (bad !== undefined) errors.push(`bad secret reference ${JSON.stringify(bad.slice(0, 40))}: use \${secret:NAME} with letters, digits, _ and -`);
  }
  return out;
}

function validateMcpShape(spec: Obj, errors: string[]): McpServerSpec | null {
  const type = spec.type ?? (spec.command !== undefined ? "stdio" : undefined);
  if (type === "stdio") {
    unknownKeys(spec, ["type", "command", "args", "env"], errors);
    if (typeof spec.command !== "string" || !spec.command.trim()) {
      errors.push("a stdio server needs a command");
      return null;
    }
    const out: McpServerSpec = { type: "stdio", command: spec.command };
    if (spec.args !== undefined) {
      if (isStringArray(spec.args)) out.args = spec.args;
      else errors.push("args must be a list of strings");
    }
    if (spec.env !== undefined) {
      if (isStringMap(spec.env)) out.env = spec.env;
      else errors.push("env must map names to strings");
    }
    return out;
  }
  if (type === "http" || type === "sse") {
    unknownKeys(spec, ["type", "url", "headers"], errors);
    if (typeof spec.url !== "string" || !/^https?:\/\//.test(spec.url)) {
      errors.push(`a ${type} server needs an http(s) url`);
      return null;
    }
    const out: McpServerSpec = { type, url: spec.url };
    if (spec.headers !== undefined) {
      if (isStringMap(spec.headers)) out.headers = spec.headers;
      else errors.push("headers must map names to strings");
    }
    return out;
  }
  errors.push(type === undefined ? "an MCP server needs a type (stdio, http or sse) or a command" : `unknown MCP server type ${JSON.stringify(type)}`);
  return null;
}

export const PERMISSION_LISTS = ["allow", "deny", "ask"] as const;

export function validateSettings(spec: Obj, errors: string[]): SettingsProfileSpec {
  const out: SettingsProfileSpec = {};
  unknownKeys(spec, ["permissions", "hooks", "codex", "opencode"], errors);
  if (spec.opencode !== undefined) {
    if (!isObj(spec.opencode)) errors.push("opencode must be a native policy object");
    else {
      unknownKeys(spec.opencode, ["permissionRules", "instructions"], errors, "opencode.");
      out.opencode = {};
      if (spec.opencode.instructions !== undefined) {
        if (typeof spec.opencode.instructions !== "string") errors.push("opencode.instructions must be text");
        else out.opencode.instructions = spec.opencode.instructions;
      }
      if (spec.opencode.permissionRules !== undefined) {
        const rules = spec.opencode.permissionRules;
        if (!Array.isArray(rules) || rules.length > 1000) errors.push("opencode.permissionRules must be a list of at most 1000 rules");
        else {
          out.opencode.permissionRules = [];
          for (const rule of rules) {
            if (!isObj(rule) || typeof rule.action !== "string" || !rule.action.trim() || typeof rule.resource !== "string" || !rule.resource.trim() || !["allow", "deny", "ask"].includes(rule.effect as string)) { errors.push("invalid OpenCode permission rule"); continue; }
            unknownKeys(rule, ["action", "resource", "effect"], errors, "opencode.permissionRules.");
            out.opencode.permissionRules.push({ action: rule.action, resource: rule.resource, effect: rule.effect as "allow" | "deny" | "ask" });
          }
        }
      }
    }
  }
  if (spec.codex !== undefined) {
    if (!isObj(spec.codex)) errors.push("codex must be a native policy object");
    else {
      unknownKeys(spec.codex, ["permissionMode", "instructions"], errors, "codex.");
      if (!PERMISSION_MODES.includes(spec.codex.permissionMode as PermissionMode) || spec.codex.permissionMode === "auto") errors.push("codex.permissionMode is not supported");
      else out.codex = { permissionMode: spec.codex.permissionMode as PermissionMode };
      if (spec.codex.instructions !== undefined) {
        if (typeof spec.codex.instructions !== "string") errors.push("codex.instructions must be text");
        else if (out.codex) out.codex.instructions = spec.codex.instructions;
      }
    }
  }
  if (spec.permissions !== undefined) {
    if (!isObj(spec.permissions)) errors.push("permissions must be an object");
    else {
      unknownKeys(spec.permissions, [...PERMISSION_LISTS], errors, "permissions.");
      const perms: NonNullable<SettingsProfileSpec["permissions"]> = {};
      for (const list of PERMISSION_LISTS) {
        const v = spec.permissions[list];
        if (v === undefined) continue;
        if (isStringArray(v) && v.every((r) => r.trim())) perms[list] = [...new Set(v)];
        else errors.push(`permissions.${list} must be a list of rules`);
      }
      out.permissions = perms;
    }
  }
  if (spec.hooks !== undefined) {
    if (!isObj(spec.hooks)) errors.push("hooks must be an object of event → hook entries");
    else {
      const hooks: Record<string, unknown> = {};
      for (const [event, entries] of Object.entries(spec.hooks)) {
        if (!Array.isArray(entries) || !entries.every((e) => isObj(e) && Array.isArray(e.hooks))) {
          errors.push(`hooks.${event} must be a list of { matcher?, hooks: [...] } entries`);
          continue;
        }
        hooks[event] = entries;
      }
      out.hooks = hooks;
    }
  }
  return out;
}
