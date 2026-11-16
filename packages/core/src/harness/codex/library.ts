// The canonical library and its project drift stay unchanged. Codex gets disposable, content-addressed native
// projections under ODIN_HOME, never a rewrite of the user's ~/.codex config or source assets.
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type {
  AssetFiles,
  PermissionMode,
  SettingsProfileSpec,
} from "@odin/shared/api";
import { ASSET_ID_PATTERN } from "@odin/shared/library";
import { parseAgentFile } from "../../agents/parse.ts";
import { parseFrontmatter } from "../../frontmatter.ts";
import { filesHash } from "../../hash.ts";
import {
  resolveInside,
  writeFileAtomic,
} from "../../library/files.ts";
import { parseAsset } from "../../library/parse.ts";
import type { Services } from "../../services.ts";
import type { StartOptions } from "../types.ts";
import type { Wire } from "./transport.ts";

export interface CodexLibrary {
  config: Wire;
  instructions: string;
  skills: { name: string; path: string }[];
  permissionMode?: PermissionMode;
}

export function adaptLibrary(
  services: Services,
  home: string,
  project: string,
  options: StartOptions,
  nativePath: (value: string) => string,
): CodexLibrary {
  const out: CodexLibrary = {
    config: {},
    instructions: "",
    skills: [],
  };
  const instructions: string[] = options.instructions ? [options.instructions] : [];
  const agents: Wire = {};
  const servers: Wire = {};
  const root = resolveInside(home, "native-library/codex");
  resolveInside(home, "native-library/codex/.containment-check");
  mkdirSync(root, { recursive: true });
  function materialize(files: AssetFiles): string {
    const dir = resolveInside(root, filesHash(files));
    resolveInside(root, `${filesHash(files)}/.containment-check`);
    mkdirSync(dir, { recursive: true });
    for (const [file, content] of Object.entries(files))
      writeFileAtomic(resolveInside(dir, file), content);
    return dir;
  }
  function agent(id: string, files: AssetFiles) {
    const content = files[`${id}.md`];
    if (!content) throw new Error(`Agent ${id} has no instructions`);
    const spec = parseAgentFile(id, content);
    if (spec.error) throw new Error(`Agent ${id} is invalid`);
    const fm = parseFrontmatter(content).data;
    const preferred = fm?.["codex-model"];
    const readOnly =
      !!spec.tools?.length &&
      !spec.tools.some((tool) =>
        ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool),
      );
    const hints = spec.tools?.length
      ? `\nTool preferences: ${spec.tools.join(", ")}. Use the equivalent Codex tools; Codex sandbox and approvals govern access.`
      : "";
    const prompt = spec.prompt + hints;
    const native = `developer_instructions = ${JSON.stringify(prompt)}\nsandbox_mode = ${JSON.stringify(readOnly ? "read-only" : "workspace-write")}\n${typeof preferred === "string" ? `model = ${JSON.stringify(preferred)}\n` : ""}`;
    const dir = materialize({ [`${id}.toml`]: native });
    agents[id] = {
      description: spec.description,
      config_file: nativePath(join(dir, `${id}.toml`)),
    };
  }
  for (const installation of services.library.installations(project)) {
    if (!ASSET_ID_PATTERN.test(installation.id))
      throw new Error("Invalid installed library id");
    const files = services.library.projectFiles(
      project,
      installation.kind,
      installation.id,
    );
    if (!files)
      throw new Error(
        `Installed ${installation.kind} ${installation.id} is missing; update or forget it before starting Codex`,
      );
    const id = installation.id;
    switch (installation.kind) {
      case "agent":
        agent(id, files);
        break;
      case "skill":
      case "command": {
        let native = files;
        if (installation.kind === "command") {
          const parsed = parseFrontmatter(files[`${id}.md`] ?? "");
          native = {
            "SKILL.md": `---\nname: ${id}\ndescription: ${JSON.stringify(parsed.data?.description ?? `Run the ${id} command`)}\n---\n\n${parsed.body}`,
          };
        }
        const dir = materialize(native);
        out.skills.push({ name: id, path: nativePath(join(dir, "SKILL.md")) });
        break;
      }
      case "mcp": {
        const parsed = parseAsset("mcp", id, files);
        if (parsed.error)
          throw new Error(`Installed MCP server ${id} is invalid`);
        const spec = parsed.meta;
        if (spec.type === "sse")
          throw new Error(
            `MCP ${id}: Codex requires HTTP or stdio, not legacy SSE`,
          );
        servers[id] =
          spec.type === "stdio"
            ? {
                command: spec.command,
                args: spec.args ?? [],
                env: spec.env ?? {},
              }
            : { url: spec.url, http_headers: spec.headers ?? {} };
        break;
      }
      case "settings": {
        // Native overrides live in the exact installed version, not the latest central version.
        const saved = services.library.files(
          "settings",
          id,
          installation.installedVersion,
        );
        const parsed = saved ? parseAsset("settings", id, saved) : null;
        const spec = parsed?.meta as SettingsProfileSpec | undefined;
        if (!spec || parsed?.error)
          throw new Error(`Settings profile ${id} is invalid`);
        if (!spec.codex && (spec.permissions || spec.hooks))
          throw new Error(
            `Settings profile ${id} needs a native Codex policy; Claude permission rules and hooks cannot be translated safely`,
          );
        if (spec.codex) {
          if (
            out.permissionMode &&
            out.permissionMode !== spec.codex.permissionMode
          )
            throw new Error(
              "Installed settings profiles have conflicting Codex policies",
            );
          out.permissionMode = spec.codex.permissionMode;
          if (spec.codex.instructions)
            instructions.push(spec.codex.instructions);
        }
        break;
      }
    }
  }
  if (Object.keys(agents).length) out.config.agents = agents;
  if (Object.keys(servers).length) out.config.mcp_servers = servers;
  if (out.skills.length)
    instructions.push(
      `Shared library skills (read their SKILL.md before using them):\n${out.skills.map((skill) => `- $${skill.name}: ${skill.path}`).join("\n")}\nSlash commands from the shared library are available as the corresponding skills.`,
    );
  out.instructions = instructions.join("\n\n");
  return out;
}
