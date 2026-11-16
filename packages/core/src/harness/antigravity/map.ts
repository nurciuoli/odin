// Pure Antigravity ACP → Odin event mapping. No process, no credentials.
import type { Effort, PermissionMode, TokenUsage } from "@odin/shared/api";
import type { HarnessEvent, PermissionRequest, SlashCommand, ToolResult, TranscriptEntry } from "@odin/shared/harness";
import { TOOL_RESULT_MAX_CHARS } from "@odin/shared/harness";
import type { McpServerStart } from "../types.ts";
import type { Wire } from "./transport.ts";

export const ANTIGRAVITY_MODES: PermissionMode[] = ["auto", "plan", "acceptEdits", "default", "bypassPermissions", "dontAsk"];

export const TURN_TIMEOUT_MS = 30 * 60 * 1000;

export const DEFAULT_EFFORT_LEVELS: Effort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

export function toNativeMode(mode?: PermissionMode | null): "auto" | "plan" | "accept-edits" {
  if (mode === "plan") return "plan";
  if (mode === "acceptEdits") return "accept-edits";
  return "auto";
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(textOf).join("");
  if (content && typeof content === "object") {
    const block = content as Wire;
    if (typeof block.text === "string") return block.text;
    if (block.type === "diff") {
      const path = typeof block.path === "string" ? `${block.path}\n` : "";
      const oldText = typeof block.oldText === "string" ? block.oldText : "";
      const newText = typeof block.newText === "string" ? block.newText : "";
      return `${path}---\n${oldText}\n+++\n${newText}`;
    }
    if (block.content !== undefined) return textOf(block.content);
    for (const key of ["Error", "NotFound", "error", "message"]) {
      if (typeof block[key] === "string") return block[key];
    }
  }
  return "";
}

export function toolResult(text: string, ok: boolean): ToolResult {
  return { ok, text: text.slice(0, TOOL_RESULT_MAX_CHARS), truncated: text.length > TOOL_RESULT_MAX_CHARS };
}

export function isMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (ANTIGRAVITY_MODES as string[]).includes(value);
}

export interface AntigravityModel {
  value: string;
  displayName: string;
  description: string;
  contextWindow: number | null;
  effortLevels?: Effort[];
  defaultEffort?: Effort;
}

export const FALLBACK_MODELS: AntigravityModel[] = [
  {
    value: "gemini-3.8-flash",
    displayName: "Gemini 3.8 Flash",
    description: "Fast, versatile frontier multimodal model with 1M context window",
    contextWindow: 1_048_576,
    effortLevels: DEFAULT_EFFORT_LEVELS,
    defaultEffort: "medium",
  },
  {
    value: "gemini-3.8-pro",
    displayName: "Gemini 3.8 Pro",
    description: "Highest reasoning frontier model with 2M context window",
    contextWindow: 2_097_152,
    effortLevels: DEFAULT_EFFORT_LEVELS,
    defaultEffort: "medium",
  },
  {
    value: "gemini-3.8-flash-lite",
    displayName: "Gemini 3.8 Flash Lite",
    description: "Lightweight, ultra-fast model for high-throughput coding tasks",
    contextWindow: 1_048_576,
    effortLevels: DEFAULT_EFFORT_LEVELS,
    defaultEffort: "low",
  },
];

export function modelsFrom(init: Wire): AntigravityModel[] {
  const models = init._meta?.modelState?.availableModels ?? init.models;
  if (!Array.isArray(models) || models.length === 0) return FALLBACK_MODELS;
  return models.flatMap((model: Wire) => {
    const id = model.modelId ?? model.id ?? model.value;
    if (typeof id !== "string") return [];
    const window = model._meta?.totalContextTokens ?? model.contextWindow;
    const known = DEFAULT_EFFORT_LEVELS as string[];
    const levels = Array.isArray(model._meta?.reasoningEfforts) ? model._meta.reasoningEfforts : DEFAULT_EFFORT_LEVELS;
    const effortLevels = levels.map((e: Wire | string) => typeof e === "string" ? e : e.value).filter((e: unknown) => typeof e === "string" && known.includes(e));
    const defaultEffort = model._meta?.reasoningEffort ?? (effortLevels.includes("medium") ? "medium" : undefined);
    return [{
      value: id,
      displayName: typeof model.name === "string" ? model.name : typeof model.displayName === "string" ? model.displayName : id,
      description: typeof model.description === "string" ? model.description : "",
      contextWindow: typeof window === "number" ? window : 1_048_576,
      effortLevels: effortLevels.length ? (effortLevels as Effort[]) : undefined,
      defaultEffort: defaultEffort as Effort | undefined,
    }];
  });
}

export function slashCommands(commands: unknown): SlashCommand[] {
  if (!Array.isArray(commands)) return [];
  return commands.flatMap((command: Wire) => {
    if (typeof command?.name !== "string" || !command.name) return [];
    return [{
      name: command.name,
      description: typeof command.description === "string" ? command.description : "",
      argumentHint: typeof command.input?.hint === "string" ? command.input.hint : "",
      source: command._meta?.scope ? "custom" as const : "builtin" as const,
    }];
  });
}

export function acpMcpServers(servers: Record<string, McpServerStart> | undefined): Wire[] {
  if (!servers) return [];
  return Object.entries(servers).map(([name, server]) => {
    if (server.type === "stdio") {
      return {
        name,
        command: server.command,
        args: server.args ?? [],
        env: Object.entries(server.env ?? {}).map(([key, value]) => ({ name: key, value })),
      };
    }
    return {
      type: server.type,
      name,
      url: server.url,
      headers: Object.entries(server.headers ?? {}).map(([key, value]) => ({ name: key, value })),
    };
  });
}

export function usageFrom(result: Wire, contextWindow: number | null): HarnessEvent | null {
  const meta = result._meta ?? {};
  const usage = meta.usage ?? result.usage;
  if (!usage || typeof usage !== "object") return null;
  const modelUsage = usage.modelUsage && typeof usage.modelUsage === "object" ? usage.modelUsage as Record<string, Wire> : {};
  const model = Object.keys(modelUsage)[0] ?? (typeof meta.modelId === "string" ? meta.modelId : "gemini-3.8-flash");
  const bucket = modelUsage[model] ?? usage;
  const tokens: TokenUsage = {
    input: numberOf(bucket.inputTokens ?? bucket.input_tokens),
    output: numberOf(bucket.outputTokens ?? bucket.output_tokens) + numberOf(bucket.reasoningTokens ?? bucket.thinking_tokens),
    cacheRead: numberOf(bucket.cachedReadTokens ?? bucket.cache_read_tokens),
    cacheWrite: numberOf(bucket.cacheCreationTokens ?? bucket.cache_creation_tokens),
  };
  return {
    type: "usage",
    model,
    usage: tokens,
    cumulative: false,
    costUsd: typeof bucket.costUsd === "number" ? bucket.costUsd : null,
    contextTokens: null,
    ...(contextWindow !== null ? { contextWindow } : {}),
  };
}

function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export interface PermissionOption {
  optionId: string;
  kind: string;
}

export function permissionOptions(raw: unknown): PermissionOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((option: Wire) => {
    if (typeof option?.optionId !== "string") return [];
    return [{ optionId: option.optionId, kind: typeof option.kind === "string" ? option.kind : "" }];
  });
}

export function permissionRequest(id: string, sessionId: string, params: Wire, at: string): PermissionRequest {
  const tool = params.toolCall ?? {};
  const name = toolCallName(tool);
  const options = permissionOptions(params.options);
  const title = textField(tool.title);
  const kind = /askuserquestion/i.test(name) || /ask_user_question/i.test(name) || /ask_question/i.test(name)
    ? "question"
    : /plan/i.test(String(tool.kind ?? "")) || /exitplan/i.test(name)
    ? "plan"
    : "tool";
  return {
    id,
    sessionId,
    kind,
    toolName: name,
    toolUseId: typeof tool.toolCallId === "string" ? tool.toolCallId : null,
    input: toolCallInput(tool),
    title: isCompactToolTitle(title) ? title : null,
    description: null,
    canAlwaysAllow: options.some((option) => option.kind === "allow_always"),
    defaultToDeny: false,
    createdAt: at,
  };
}

export function optionFor(options: PermissionOption[], behavior: "allow" | "deny", scope: string): string | null {
  const kind = behavior === "deny" ? "reject_once" : scope === "once" ? "allow_once" : "allow_always";
  const exact = options.find((option) => option.kind === kind);
  if (exact) return exact.optionId;
  if (behavior === "allow" && scope !== "once") {
    const once = options.find((option) => option.kind === "allow_once");
    if (once) return once.optionId;
  }
  return null;
}

function textField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function isCompactToolTitle(title: string): boolean {
  return title.length > 0 && title.length <= 32 && !title.includes("`") && !title.includes("\n");
}

const KIND_NAME: Record<string, string> = {
  read_file: "Read",
  write_file: "Write",
  edit_file: "Edit",
  run_command: "Bash",
  search_web: "WebSearch",
  invoke_subagent: "Subagent",
  execute: "Bash",
  read: "Read",
  edit: "Edit",
  search: "Grep",
};

export function toolCallName(update: Wire, previous?: string): string {
  const programmatic = textField(update.name) || textField(update.tool);
  if (programmatic) {
    return KIND_NAME[programmatic] || programmatic;
  }
  const title = textField(update.title);
  if (/^web search\b/i.test(title)) return "WebSearch";
  const kind = KIND_NAME[textField(update.kind)];
  if (kind) return kind;
  if (isCompactToolTitle(title)) return title;
  return previous || "tool";
}

export function toolCallInput(update: Wire, previous?: Record<string, unknown>): Record<string, unknown> {
  const raw = update.rawInput ?? update.args ?? update.arguments;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return previous ?? {};
  const input = { ...(raw as Record<string, unknown>) };
  if (typeof input.Path === "string" && typeof input.path !== "string") input.path = input.Path;
  if (typeof input.CommandLine === "string" && typeof input.command !== "string") input.command = input.CommandLine;
  if (typeof input.file_path !== "string" && typeof input.target_file === "string") input.file_path = input.target_file;
  return input;
}

export { EventQueue } from "../queue.ts";
