import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { NativePermissionRule, SettingsProfileSpec } from "@odin/shared/api";
import { filesHash } from "../../hash.ts";
import { resolveInside, writeFileAtomic } from "../../library/files.ts";
import { parseAgentFile } from "../../agents/parse.ts";
import { parseFrontmatter } from "../../frontmatter.ts";
import { parseAsset } from "../../library/parse.ts";
import type { Services } from "../../services.ts";
import type { McpServerStart, StartOptions } from "../types.ts";

export interface OpenCodeLibrary {
  instructions: string;
  agents: { name: string; description: string; prompt: string; permissionRules?: NativePermissionRule[] }[];
  skills: { name: string; description: string; path: string; content: string }[];
  mcpServers: Record<string, McpServerStart>;
  permissionRules?: NativePermissionRule[];
}

/** Project-installed versions and edits remain canonical; disposable SDK projections live under Odin home. */
export function adaptOpenCodeLibrary(services: Services, home: string, project: string, options: StartOptions): OpenCodeLibrary {
  const out: OpenCodeLibrary = { instructions: options.instructions ?? "", agents: [], skills: [], mcpServers: { ...options.mcpServers } };
  const instructions: string[] = [out.instructions];
  for (const installation of services.library.installations(project)) {
    const { kind, id } = installation;
    const files = services.library.projectFiles(project, kind, id);
    if (!files) throw new Error(`Installed ${kind} ${id} is missing; update or forget it before starting OpenCode`);
    if (kind === "agent") {
      const parsed = parseAgentFile(id, files[`${id}.md`] ?? "");
      if (parsed.error) throw new Error(`Installed agent ${id} is invalid`);
      if (parsed.model) throw new Error(`Agent ${id} has a Claude-specific model; supply a native OpenCode agent for this restriction`);
      const nativeTools: Record<string, string> = { Read: "read", Grep: "grep", Glob: "glob", Bash: "shell", WebFetch: "webfetch", WebSearch: "websearch", Agent: "subagent", Task: "subagent" };
      if (parsed.tools?.some(tool => !nativeTools[tool])) throw new Error(`Agent ${id} uses tools without an exact OpenCode permission equivalent; supply a native OpenCode agent`);
      const permissionRules: NativePermissionRule[] | undefined = parsed.tools?.length ? [{ action: "*", resource: "*", effect: "deny" }, ...parsed.tools.map(tool => ({ action: nativeTools[tool]!, resource: "*", effect: "allow" as const }))] : undefined;
      out.agents.push({ name: id, description: parsed.description, prompt: parsed.prompt, permissionRules });
    } else if (kind === "skill" || kind === "command") {
      let source = files;
      if (kind === "command") {
        const parsed = parseFrontmatter(files[`${id}.md`] ?? "");
        source = { "SKILL.md": `---\nname: ${id}\ndescription: ${JSON.stringify(parsed.data?.description ?? id)}\n---\n\n${parsed.body}` };
      }
      const parsed = parseFrontmatter(source["SKILL.md"] ?? "");
      const root = resolveInside(home, "native-library/opencode/" + filesHash(source));
      mkdirSync(root, { recursive: true });
      for (const [name, content] of Object.entries(source)) writeFileAtomic(resolveInside(root, name), content);
      out.skills.push({ name: id, description: String(parsed.data?.description ?? id), path: join(root, "SKILL.md"), content: parsed.body });
    } else if (kind === "mcp") {
      const parsed = parseAsset("mcp", id, files);
      if (parsed.error) throw new Error(`Installed MCP ${id} is invalid`);
      const { name: _name, description: _description, ...spec } = parsed.meta;
      if (!(id in out.mcpServers)) out.mcpServers[id] = spec as McpServerStart;
    } else if (kind === "settings") {
      const parsed = parseAsset("settings", id, files);
      if (parsed.error) throw new Error(`Installed settings ${id} are invalid`);
      const spec = parsed.meta as unknown as SettingsProfileSpec;
      if ((spec.permissions || spec.hooks) && !spec.opencode) throw new Error(`Settings ${id} requires an explicit OpenCode native policy`);
      if (spec.opencode?.permissionRules) {
        if (out.permissionRules && JSON.stringify(out.permissionRules) !== JSON.stringify(spec.opencode.permissionRules)) throw new Error("Installed OpenCode settings profiles have conflicting native permission rules");
        out.permissionRules = spec.opencode.permissionRules;
      }
      if (spec.opencode?.instructions) instructions.push(spec.opencode.instructions);
    }
  }
  out.instructions = instructions.filter(Boolean).join("\n\n");
  return out;
}
