// One default agent per session. Explicit settings override app defaults; project resources are loaded natively.
// docs/contracts.md#launch.
import type { AssetKind, McpServerSpec, PermissionMode, StartSessionRequest, UserMessage } from "@odin/shared/api";
import { fillPrompt } from "@odin/shared/library";
import { sessionBranch } from "@odin/shared/session";
import { HttpError } from "../http/util.ts";
import { validateMessage } from "../sessions/message.ts";
import type { McpServerStart } from "../harness/types.ts";
import type { Deps, LaunchPlan, LaunchService, Services } from "../services.ts";
import { validBranchName } from "../git-policy.ts";
import { runtimeOptions } from "../sessions/native.ts";
export { validBranchName } from "../git-policy.ts";

export const PERMISSION_MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk", "auto"];

/** The prompt's first non-empty line, at most 120 characters. */
export function titleFromPrompt(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > 120 ? `${line.slice(0, 119).trimEnd()}…` : line;
}

function bad(message: string): never {
  throw new HttpError(400, message);
}

function stringList(value: unknown, what: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) bad(`${what} must be a list of strings`);
  return [...new Set((value as string[]).map((v) => v.trim()).filter(Boolean))];
}

/** A library asset that must exist and parse, else 400. */
function libraryAsset(services: Services, kind: AssetKind, id: string) {
  const asset = services.library.get(kind, id);
  if (!asset) bad(`unknown library ${kind} ${id}`);
  if (asset.error) bad(`library ${kind} ${id} has errors: ${asset.error}`);
  return asset;
}

/** The library MCP spec as the harness wants it: name/description (and anything unknown) dropped. */
function mcpStart(id: string, meta: Record<string, unknown>): McpServerStart {
  const spec = meta as Partial<McpServerSpec> & Record<string, unknown>;
  const strings = (v: unknown) => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined);
  const record = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : undefined);
  if (spec.type === "stdio" && typeof spec.command === "string") {
    const out: McpServerStart = { type: "stdio", command: spec.command };
    const args = strings(spec.args);
    const env = record(spec.env);
    if (args) out.args = args;
    if (env) out.env = env;
    return out;
  }
  if ((spec.type === "http" || spec.type === "sse") && typeof spec.url === "string") {
    const out: McpServerStart = { type: spec.type, url: spec.url };
    const headers = record(spec.headers);
    if (headers) out.headers = headers;
    return out;
  }
  return bad(`library mcp ${id} is not a valid server spec`);
}

export function createLaunchService(_deps: Deps, services: Services): LaunchService {
  function resolveMcpServers(ids: string[]): Record<string, McpServerStart> {
    const servers: Record<string, McpServerStart> = {};
    for (const id of ids) servers[id] = mcpStart(id, libraryAsset(services, "mcp", id).meta);
    return servers;
  }
  return {
    resolveMcpServers,
    async plan(req: StartSessionRequest, sessionId: string): Promise<LaunchPlan> {
      if (!req || typeof req !== "object") bad("invalid request");

      if (typeof req.project !== "string" || !req.project) bad("project is required");
      const project = services.projects.get(req.project);
      if (!project) throw new HttpError(404, `unknown project ${req.project}`);
      const projects = req.projects === undefined ? [req.project] : stringList(req.projects, "projects");
      if (!projects.includes(project.name)) bad("projects must include the working project");
      for (const name of projects) {
        const configured = services.projects.get(name);
        if (!configured) throw new HttpError(404, `unknown project ${name}`);
        if (configured.missing) throw new HttpError(409, `project ${name} is missing on disk`);
      }

      const settings = services.settings.get();

      if (req.title !== undefined && typeof req.title !== "string") bad("title must be a string");
      if (req.model !== undefined && (typeof req.model !== "string" || !req.model.trim())) bad("model must be a non-empty string");
      if (req.permissionMode !== undefined && !PERMISSION_MODES.includes(req.permissionMode)) bad(`unknown permission mode ${String(req.permissionMode)}`);
      if (req.worktree !== undefined && typeof req.worktree !== "boolean") bad("worktree must be a boolean");
      if (req.branch !== undefined && (typeof req.branch !== "string" || !validBranchName(req.branch))) bad("invalid branch name");
      if (req.variables !== undefined && (typeof req.variables !== "object" || req.variables === null || Object.values(req.variables).some((v) => typeof v !== "string"))) {
        bad("variables must map names to strings");
      }
      const reqTags = req.tags === undefined ? undefined : stringList(req.tags, "tags");
      const reqMcp = req.mcp === undefined ? undefined : stringList(req.mcp, "mcp");

      if (req.templateId !== undefined || req.agent !== undefined) bad("Sessions use the default agent. Install skills or subagents from the library instead of selecting a template or agent.");
      const tags = reqTags ?? [];
      const harnessId = req.harness ?? settings.defaultHarness ?? "claude";
      const family = harnessId === "codex-wsl" ? "codex" : harnessId;
      const defaults = settings.harnessDefaults?.[harnessId] ?? settings.harnessDefaults?.[family];
      const mode = req.permissionMode ?? defaults?.permissionMode ?? (family === "claude" ? settings.defaultPermissionMode : "default");
      const selectedModel = req.model?.trim() ?? defaults?.model ?? (family === "claude" ? settings.defaultModel : null);
      const harness = _deps.harnesses[harnessId];
      if (!harness || !Object.hasOwn(_deps.harnesses, harnessId)) bad(`unknown harness ${harnessId}`);
      if (req.runtimeOptions !== undefined) runtimeOptions(req.runtimeOptions, harness.capabilities);
      if (projects.length > 1 && harness.capabilities?.additionalDirectories === false) bad(`${harnessId} does not support additional project directories`);
      if (harness.capabilities && !harness.capabilities.permissionModes.includes(mode)) bad(`${harnessId} does not support permission mode ${mode}`);
      if (family === "codex" && selectedModel && /^(opus|sonnet|haiku|claude-)/.test(selectedModel)) bad("Choose a Codex model");
      if (family === "grok" && selectedModel && /^(opus|sonnet|haiku|claude-|gpt-)/i.test(selectedModel)) bad("Choose a Grok model");

      // A session always begins with the user's own message.
      const raw = validateMessage(req.prompt);
      if (raw.attachments?.length && harness.capabilities?.attachments === false) bad(`${harnessId} does not support attachments`);
      const promptText = raw.text;
      if (!promptText.trim()) bad("a prompt is required");

      // MCP servers: library ids → server specs.
      const mcpServers = resolveMcpServers(reqMcp ?? []);

      // Variables: built-ins first, the caller's override them. A null-prototype object so `{{constructor}}` stays as written.
      const values: Record<string, string> = Object.create(null);
      values.project = project.name;
      for (const [k, v] of Object.entries(req.variables ?? {})) values[k] = v;

      // `{{branch}}`: the worktree branch (known once the title is), else the checkout's current branch.
      const worktree = req.worktree ?? project.settings.defaultWorktree ?? settings.defaultWorktree;
      const callerBranch = "branch" in values;
      if (!worktree && !callerBranch) {
        let current: string | null = null;
        try {
          current = services.projects.detail(project.name)?.git.branch ?? null;
        } catch {
          current = null;
        }
        if (current) values.branch = current;
      }
      const title = (req.title?.trim() || titleFromPrompt(fillPrompt(promptText, values)) || "Untitled session").slice(0, 200);
      const branch = worktree ? (req.branch ?? sessionBranch(title, sessionId)) : null;
      if (branch && !callerBranch) values.branch = branch;
      const prompt: UserMessage = { text: fillPrompt(promptText, values) };
      if (raw?.attachments?.length) prompt.attachments = raw.attachments;

      return {
        title,
        prompt,
        model: selectedModel,
        permissionMode: mode,
        mcpServers,
        worktree,
        branch,
        tags,
      };
    },
  };
}
