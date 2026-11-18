// Claude Code plugin <-> Odin plugin conversion. Pure: files in, files out. Reading and writing folders, fetching git and
// the library itself are the service's job. docs/contracts.md#plugins.
import type { AssetFiles, PluginMemberKind, PluginRun } from "@odin/shared/api";
import { ASSET_ID_PATTERN, secretRefs } from "@odin/shared/library";
import { parseFrontmatter } from "../frontmatter.ts";
import { HttpError } from "../http/util.ts";
import { parseAsset } from "./parse.ts";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/, "");

export interface Converted {
  id: string;
  name: string;
  description: string;
  version: string | null;
  /** The Odin plugin folder: plugin.json plus own members. */
  files: AssetFiles;
  members: { kind: PluginMemberKind; id: string }[];
  runs: PluginRun[];
  warnings: string[];
  secrets: string[];
}

function json(raw: string | undefined, where: string, warnings: string[]): Obj | null {
  if (raw === undefined) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (isObj(v)) return v;
  } catch {
    // reported below
  }
  warnings.push(`${where} is not a JSON object and was skipped`);
  return null;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Turns a Claude Code plugin folder (every file, dotfiles included) into an Odin plugin. */
export function convertClaudePlugin(src: AssetFiles, opts: { fallbackName: string; id?: string; git?: { url: string; rev?: string } }): Converted {
  const warnings: string[] = [];
  const manifest = json(src[".claude-plugin/plugin.json"], ".claude-plugin/plugin.json", warnings) ?? {};
  const name = str(manifest.name) || opts.fallbackName;
  const id = opts.id ?? slug(name);
  if (!ASSET_ID_PATTERN.test(id)) throw new HttpError(400, `"${id}" is not a usable plugin id: use lowercase letters, digits and hyphens (pass id)`);
  const description = str(manifest.description) || `Imported from ${name}`;
  const version = str(manifest.version).slice(0, 64) || null;

  const out: AssetFiles = {};
  const used = new Set<string>();
  const handled = new Set<string>([".claude-plugin/plugin.json"]);
  const members: { kind: PluginMemberKind; id: string }[] = [];

  const accept = (kind: PluginMemberKind, mid: string, files: AssetFiles, paths: string[], layout: (rel: string) => string): void => {
    const parsed = parseAsset(kind, mid, files);
    if (parsed.error) {
      warnings.push(`${kind} "${mid}" was skipped: ${parsed.error}`);
      return;
    }
    used.add(`${kind}/${mid}`);
    members.push({ kind, id: mid });
    for (const [rel, content] of Object.entries(files)) out[layout(rel)] = content;
    for (const p of paths) handled.add(p);
  };

  // skills/<id>/…
  const skillIds = new Set(Object.keys(src).filter((p) => p.startsWith("skills/") && p.split("/").length > 2).map((p) => p.split("/")[1]!));
  for (const sid of [...skillIds].sort()) {
    const paths = Object.keys(src).filter((p) => p.startsWith(`skills/${sid}/`));
    if (!ASSET_ID_PATTERN.test(sid)) {
      warnings.push(`skill "${sid}" was skipped: not a valid id`);
      continue;
    }
    const files: AssetFiles = {};
    for (const p of paths) files[p.slice(`skills/${sid}/`.length)] = src[p]!;
    accept("skill", sid, files, paths, (rel) => `skills/${sid}/${rel}`);
  }

  // agents/<id>.md
  for (const p of Object.keys(src).filter((k) => /^agents\/[^/]+\.md$/.test(k)).sort()) {
    const mid = p.slice("agents/".length, -3);
    if (!ASSET_ID_PATTERN.test(mid)) {
      warnings.push(`agent "${mid}" was skipped: not a valid id`);
      continue;
    }
    accept("agent", mid, { [`${mid}.md`]: src[p]! }, [p], (rel) => `agents/${rel}`);
  }

  // commands/<id>.md become skills, as the legacy-command migration does.
  for (const p of Object.keys(src).filter((k) => /^commands\/[^/]+\.md$/.test(k)).sort()) {
    const base = p.slice("commands/".length, -3);
    let mid = base;
    if (!ASSET_ID_PATTERN.test(mid)) {
      warnings.push(`command "${base}" was skipped: not a valid id`);
      continue;
    }
    if (used.has(`skill/${mid}`)) {
      mid = `command-${mid}`.slice(0, 64);
      warnings.push(`command "${base}" became skill "${mid}" because a skill named "${base}" exists`);
    } else warnings.push(`command "${base}" became skill "${mid}" (Odin has no separate slash commands)`);
    const fm = /^---\r?\n/.test(src[p]!) ? parseFrontmatter(src[p]!, p) : null;
    const desc = fm?.data && typeof fm.data.description === "string" && fm.data.description.trim() ? fm.data.description.trim() : `Command ${base}`;
    const body = (fm?.data ? fm.body : src[p]!).replace(/^\s+/, "");
    const content = `---\nname: ${mid}\ndescription: ${JSON.stringify(desc)}\n---\n\n${body}${body.endsWith("\n") ? "" : "\n"}`;
    accept("skill", mid, { "SKILL.md": content }, [p], (rel) => `skills/${mid}/${rel}`);
  }

  // hooks/hooks.json
  if (src["hooks/hooks.json"] !== undefined) {
    const doc = json(src["hooks/hooks.json"], "hooks/hooks.json", warnings);
    const hooks = doc ? (isObj(doc.hooks) ? doc.hooks : doc) : null;
    if (hooks && Object.keys(hooks).length) {
      accept("settings", "hooks", { "hooks.json": JSON.stringify({ hooks }, null, 2) + "\n" }, ["hooks/hooks.json"], (rel) => `settings/${rel}`);
      if (JSON.stringify(hooks).includes("${CLAUDE_PLUGIN_ROOT}"))
        warnings.push("hooks refer to ${CLAUDE_PLUGIN_ROOT}, the plugin's own folder, which Odin does not have: edit those commands before installing");
    } else handled.add("hooks/hooks.json");
  }

  // .mcp.json
  if (src[".mcp.json"] !== undefined) {
    const doc = json(src[".mcp.json"], ".mcp.json", warnings);
    const servers = doc ? (isObj(doc.mcpServers) ? doc.mcpServers : doc) : {};
    for (const [sname, spec] of Object.entries(servers)) {
      const mid = ASSET_ID_PATTERN.test(sname) ? sname : slug(sname);
      if (!isObj(spec) || !ASSET_ID_PATTERN.test(mid)) {
        warnings.push(`MCP server "${sname}" was skipped: not a usable name or spec`);
        continue;
      }
      if (mid !== sname) warnings.push(`MCP server "${sname}" is named "${mid}" in Odin`);
      if (used.has(`mcp/${mid}`)) {
        warnings.push(`MCP server "${sname}" was skipped: another one is already named "${mid}"`);
        continue;
      }
      const raw = JSON.stringify(spec);
      if (raw.includes("${CLAUDE_PLUGIN_ROOT}")) warnings.push(`MCP server "${mid}" refers to \${CLAUDE_PLUGIN_ROOT}, which Odin does not have: edit it before installing`);
      if (/\$\{(?!secret:)[A-Za-z_]/.test(raw)) warnings.push(`MCP server "${mid}" uses \${NAME} environment references; Odin fills only \${secret:NAME}, so change them to secrets`);
      accept("mcp", mid, { [`${mid}.json`]: JSON.stringify(spec, null, 2) + "\n" }, [], (rel) => `mcp/${rel}`);
    }
    handled.add(".mcp.json");
  }

  if (src["README.md"] !== undefined) {
    out["README.md"] = src["README.md"];
    handled.add("README.md");
  }

  const rest = Object.keys(src).filter((p) => !handled.has(p));
  if (rest.length) warnings.push(`not imported (Odin has no place for them): ${rest.slice(0, 8).join(", ")}${rest.length > 8 ? ` and ${rest.length - 8} more` : ""}`);
  if (!members.length) throw new HttpError(400, "this folder has no skills, agents, commands, hooks or MCP servers Odin can import");

  const manifestOut: Obj = { name, description };
  if (version) manifestOut.version = version;
  if (opts.git) manifestOut.source = { type: "git", url: opts.git.url, ...(opts.git.rev ? { rev: opts.git.rev } : {}) };
  out["plugin.json"] = JSON.stringify(manifestOut, null, 2) + "\n";

  const check = parseAsset("plugin", id, out);
  if (check.error) throw new HttpError(400, `the converted plugin is not valid: ${check.error}`);

  const runs: PluginRun[] = [];
  const secrets = new Set<string>();
  for (const [path, content] of Object.entries(out)) {
    if (path.startsWith("settings/")) {
      const hooks = (JSON.parse(content) as { hooks?: Record<string, unknown> }).hooks ?? {};
      for (const [event, value] of Object.entries(hooks)) runs.push({ kind: "hook", member: `settings/${path.slice(9, -5)}`, text: `${event}: ${JSON.stringify(value)}` });
    } else if (path.startsWith("mcp/")) {
      const spec = JSON.parse(content) as { type?: string; command?: string; args?: string[]; url?: string };
      const member = `mcp/${path.slice(4, -5)}`;
      if (spec.type === "stdio" || (spec.type === undefined && spec.command)) runs.push({ kind: "command", member, text: [spec.command, ...(spec.args ?? [])].join(" ") });
      else runs.push({ kind: "remote", member, text: spec.url ?? "" });
      for (const n of secretRefs(content)) secrets.add(n);
    }
  }
  runs.sort((a, b) => a.member.localeCompare(b.member));
  return { id, name, description, version, files: out, members, runs, warnings, secrets: [...secrets].sort() };
}

export interface ExportMember {
  kind: PluginMemberKind;
  id: string;
  /** In library form (relative to the member's own root). */
  files: AssetFiles;
  /** The parsed asset's meta (a settings or MCP spec). */
  meta: Record<string, unknown>;
}

export interface Exported {
  files: AssetFiles;
  skipped: { kind: PluginMemberKind; id: string; reason: string }[];
  notes: string[];
}

/** Writes an Odin plugin's members in the Claude Code plugin layout. Secrets stay placeholders; OAuth is dropped. */
export function exportClaudePlugin(plugin: { id: string; name: string; description: string; version: string | null }, members: ExportMember[]): Exported {
  const files: AssetFiles = {};
  const skipped: Exported["skipped"] = [];
  const notes: string[] = [];
  const mcpServers: Record<string, unknown> = {};
  const hooks: Record<string, unknown[]> = {};
  const secrets = new Set<string>();

  for (const m of members) {
    if (m.kind === "skill") {
      for (const [rel, content] of Object.entries(m.files)) files[`skills/${m.id}/${rel}`] = content;
    } else if (m.kind === "agent") {
      for (const [rel, content] of Object.entries(m.files)) files[`agents/${rel}`] = content;
    } else if (m.kind === "mcp") {
      const { oauth, ...spec } = m.meta as { oauth?: unknown } & Obj;
      if (oauth !== undefined) notes.push(`MCP server "${m.id}": OAuth settings were dropped (Claude Code signs in on its own)`);
      mcpServers[m.id] = spec;
      for (const n of secretRefs(JSON.stringify(spec))) secrets.add(n);
    } else if (m.kind === "settings") {
      const spec = m.meta as { hooks?: Record<string, unknown>; permissions?: unknown; codex?: unknown; opencode?: unknown };
      if (spec.hooks && Object.keys(spec.hooks).length) {
        for (const [event, value] of Object.entries(spec.hooks)) hooks[event] = [...(hooks[event] ?? []), ...(Array.isArray(value) ? value : [value])];
        if (spec.permissions || spec.codex || spec.opencode) notes.push(`settings "${m.id}": only its hooks were exported; permission rules and other runtimes' policy have no place in a Claude Code plugin`);
      } else skipped.push({ kind: m.kind, id: m.id, reason: "a Claude Code plugin carries hooks, not permission rules or other runtimes' policy" });
    } else skipped.push({ kind: m.kind, id: m.id, reason: "a Claude Code plugin has no instruction fragments" });
  }
  if (Object.keys(mcpServers).length) files[".mcp.json"] = JSON.stringify({ mcpServers }, null, 2) + "\n";
  if (Object.keys(hooks).length) files["hooks/hooks.json"] = JSON.stringify({ hooks }, null, 2) + "\n";
  if (secrets.size) notes.push(`secret placeholders left in .mcp.json (never values): ${[...secrets].sort().map((n) => `\${secret:${n}}`).join(", ")}; whoever installs it must replace them`);
  const manifest: Obj = { name: plugin.id, description: plugin.description || plugin.name };
  if (plugin.version) manifest.version = plugin.version;
  files[".claude-plugin/plugin.json"] = JSON.stringify(manifest, null, 2) + "\n";
  return { files, skipped, notes };
}
