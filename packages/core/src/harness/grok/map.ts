// Pure ACP → Odin event mapping. No process, no credentials.
import type { Effort, PermissionMode, TokenUsage } from "@odin/shared/api";
import type { HarnessEvent, PermissionRequest, SlashCommand, TaskActivity, ToolResult, TranscriptEntry } from "@odin/shared/harness";
import { TOOL_RESULT_MAX_CHARS, taskKey } from "@odin/shared/harness";
import type { AgentSpec, McpServerStart } from "../types.ts";
import type { Wire } from "./transport.ts";

export const GROK_MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions", "auto"];

export const TURN_TIMEOUT_MS = 30 * 60 * 1000;

/** costUsdTicks / 1e9 matched a short live turn (116586000 ticks ≈ $0.12). */
export function costUsd(ticks: unknown): number | null {
  return typeof ticks === "number" && Number.isFinite(ticks) ? ticks / 1e9 : null;
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
  return typeof value === "string" && (GROK_MODES as string[]).includes(value);
}

export function authMethod(init: Wire): string {
  const methods = Array.isArray(init.authMethods) ? init.authMethods.map((method: Wire) => method?.id).filter((id: unknown) => typeof id === "string") : [];
  if (methods.includes("cached_token")) return "cached_token";
  const fallback = init._meta?.defaultAuthMethodId;
  if (typeof fallback === "string" && fallback !== "grok.com" && methods.includes(fallback)) return fallback;
  throw new Error("Run grok login first");
}

export interface GrokModel {
  effortLevels?: import("@odin/shared/api").Effort[];
  defaultEffort?: import("@odin/shared/api").Effort;
  value: string;
  displayName: string;
  description: string;
  contextWindow: number | null;
}

const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function effortOf(value: unknown): Effort | undefined {
  return typeof value === "string" && (EFFORTS as readonly string[]).includes(value) ? value as Effort : undefined;
}

export function modelsFrom(init: Wire): GrokModel[] {
  const models = init._meta?.modelState?.availableModels;
  if (!Array.isArray(models)) return [];
  return models.flatMap((model: Wire) => {
    const id = typeof model?.modelId === "string" ? model.modelId : typeof model?.id === "string" ? model.id : typeof model?.value === "string" ? model.value : "";
    if (!id) return [];
    const window = model._meta?.totalContextTokens;
    const levels = Array.isArray(model._meta?.reasoningEfforts) ? model._meta.reasoningEfforts : [];
    const effortLevels = levels.map((e: Wire | string) => effortOf(typeof e === "string" ? e : e?.value)).filter((e: Effort | undefined): e is Effort => !!e);
    const marked = levels.find((e: Wire) => e && typeof e === "object" && e.default);
    const defaultEffort = effortOf(marked && typeof marked === "object" ? marked.value : undefined) ?? effortOf(model._meta?.reasoningEffort);
    const name = typeof model.name === "string" && model.name.trim() ? model.name.trim() : id;
    return [{
      ...(effortLevels.length ? { effortLevels, ...(defaultEffort ? { defaultEffort } : {}) } : {}),
      value: id,
      displayName: name,
      description: typeof model.description === "string" ? model.description : "",
      contextWindow: typeof window === "number" ? window : null,
    }];
  });
}

/** Keep a richer catalog record when a later list only repeats the id. */
export function mergeModels(current: GrokModel[], incoming: GrokModel[]): GrokModel[] {
  const byId = new Map(current.map((model) => [model.value, model]));
  for (const next of incoming) {
    const prev = byId.get(next.value);
    if (!prev) {
      byId.set(next.value, next);
      continue;
    }
    const displayName = next.displayName && next.displayName !== next.value ? next.displayName : prev.displayName || next.displayName;
    byId.set(next.value, {
      ...prev,
      ...next,
      displayName,
      description: next.description || prev.description,
      contextWindow: next.contextWindow ?? prev.contextWindow,
      ...(next.effortLevels?.length ? { effortLevels: next.effortLevels } : prev.effortLevels ? { effortLevels: prev.effortLevels } : {}),
      ...(next.defaultEffort ? { defaultEffort: next.defaultEffort } : prev.defaultEffort ? { defaultEffort: prev.defaultEffort } : {}),
    });
  }
  const seen = new Set<string>();
  const merged: GrokModel[] = [];
  for (const model of [...current, ...incoming]) {
    if (seen.has(model.value)) continue;
    seen.add(model.value);
    const kept = byId.get(model.value);
    if (kept) merged.push(kept);
  }
  return merged;
}

/**
 * Usage reports a runtime id such as `grok-4.7-build` for catalog id `grok-4.7`.
 * An exact catalog id wins, including `grok-4.7-build-fast`. Otherwise the longest catalog id that is a hyphen-prefix.
 */
export function canonicalModel(catalogIds: readonly string[], reported: string): string {
  if (catalogIds.includes(reported)) return reported;
  let best = "";
  for (const id of catalogIds) {
    if (reported.startsWith(`${id}-`) && id.length > best.length) best = id;
  }
  return best || reported;
}

/** Extra rules for `session/new` and `session/load`. Empty when there is nothing to append. */
export function grokRules(instructions?: string, agents?: Record<string, AgentSpec>): string {
  const parts: string[] = [];
  const text = instructions?.trim();
  if (text) parts.push(text);
  const specs = Object.entries(agents ?? {}).filter(([, spec]) => spec && (spec.prompt || spec.description));
  if (specs.length) {
    const body = specs.map(([name, spec]) => {
      const tools = spec.tools?.length ? `Tools: ${spec.tools.join(", ")}` : "";
      return [`## ${name}`, spec.description?.trim(), tools, spec.prompt?.trim()].filter(Boolean).join("\n");
    }).join("\n\n");
    parts.push(`Odin subagents available in this session:\n${body}`);
  }
  return parts.join("\n\n");
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
  const usage = meta.usage;
  if (!usage || typeof usage !== "object") return null;
  const modelUsage = usage.modelUsage && typeof usage.modelUsage === "object" ? usage.modelUsage as Record<string, Wire> : {};
  const model = Object.keys(modelUsage)[0] ?? (typeof meta.modelId === "string" ? meta.modelId : "grok");
  const bucket = modelUsage[model] ?? usage;
  const tokens: TokenUsage = {
    input: numberOf(bucket.inputTokens),
    // TokenUsage has no reasoning counter. Reasoning tokens are model output, so they stay in the output total.
    output: numberOf(bucket.outputTokens) + numberOf(bucket.reasoningTokens),
    cacheRead: numberOf(bucket.cachedReadTokens),
    cacheWrite: numberOf(bucket.cacheCreationTokens),
  };
  return {
    type: "usage",
    model,
    usage: tokens,
    cumulative: false,
    costUsd: costUsd(bucket.costUsdTicks),
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
  const kind = /askuserquestion/i.test(name) || /ask_user_question/i.test(name) ? "question" : /plan/i.test(String(tool.kind ?? "")) || /exitplan/i.test(name) ? "plan" : "tool";
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
  // Never infer permission scope from an opaque id or broaden a once approval.
  return null;
}

const ATTACHMENT_TAG = /<attachment\s+name="([^"]*)"\s+media-type="([^"]*)"\s*\/>/g;
const ATTACHMENT_BODY = /<attachment\s+name="([^"]*)"\s+media-type="([^"]*)">[\s\S]*?<\/attachment>/g;
const FILE_CONTENTS = /<file_contents\s+path="([^"]*)"[^>]*>[\s\S]*?<\/file_contents>/g;
const DROPPED = /<image_dropped_notice>([\s\S]*?)<\/image_dropped_notice>/g;
const IMAGE_FILES = /<image_files>([\s\S]*?)<\/image_files>/;

const unescapeAttr = (s: string) => s.replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function fileName(path: string): string {
  const base = path.split(/[/\\]/).filter(Boolean).pop() ?? "file";
  try { return decodeURIComponent(base); } catch { return base; }
}

export interface UserFacing {
  text: string;
  attachments: { name: string; mediaType: string }[];
  notices: string[];
}

function contentBlocks(content: unknown): Wire[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content.filter((block): block is Wire => !!block && typeof block === "object");
  if (content && typeof content === "object") return [content as Wire];
  return [];
}

/** The query a person typed, plus files Grok stored beside it. Scaffolding and dropped-image notes stay out of `text`. */
export function userFacing(line: Wire): UserFacing {
  const empty: UserFacing = { text: "", attachments: [], notices: [] };
  if (line.synthetic_reason) return empty;
  const attachments: UserFacing["attachments"] = [];
  const notices: string[] = [];
  let raw = "";
  for (const block of contentBlocks(line.content)) {
    if (block.type === "image") {
      const url = typeof block.url === "string" ? block.url : "";
      const mime = /^data:([^;,]+)/i.exec(url)?.[1] ?? "image/png";
      attachments.push({ name: "image", mediaType: mime });
    } else raw += textOf(block);
  }
  for (const match of raw.matchAll(DROPPED)) if (match[1]?.trim()) notices.push(match[1].trim());
  for (const match of raw.matchAll(FILE_CONTENTS)) {
    const path = unescapeAttr(match[1] ?? "");
    if (path) attachments.push({ name: fileName(path), mediaType: "text/plain" });
  }
  const listed: string[] = [];
  const imageList = IMAGE_FILES.exec(raw);
  if (imageList?.[1]) {
    for (const row of imageList[1].split(/\n/)) {
      const path = row.replace(/^\s*\d+\.\s*/, "").trim();
      if (/[/\\]/.test(path)) listed.push(fileName(path));
    }
  }
  const tags = [...raw.matchAll(ATTACHMENT_TAG)].map((match) => ({
    name: unescapeAttr(match[1] ?? "") || "image",
    mediaType: unescapeAttr(match[2] ?? "") || "image/png",
  }));
  let listedAt = 0;
  let tagAt = 0;
  for (const attachment of attachments) {
    if (!attachment.mediaType.toLowerCase().startsWith("image")) continue;
    if (listed[listedAt]) attachment.name = listed[listedAt++]!;
    else if (tags[tagAt]) {
      attachment.name = tags[tagAt]!.name;
      attachment.mediaType = tags[tagAt]!.mediaType;
      tagAt += 1;
    }
  }
  if (!attachments.some((attachment) => attachment.mediaType.toLowerCase().startsWith("image"))) {
    while (tagAt < tags.length) attachments.push(tags[tagAt++]!);
  }
  for (const match of raw.matchAll(ATTACHMENT_BODY)) {
    attachments.push({ name: unescapeAttr(match[1] ?? "") || "file", mediaType: unescapeAttr(match[2] ?? "") || "text/plain" });
  }
  let clean = raw
    .replace(IMAGE_FILES, "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(ATTACHMENT_BODY, "")
    .replace(ATTACHMENT_TAG, "")
    .trim();
  if (/^\s*<user_info>/.test(clean) && !clean.includes("<user_query>")) return empty;
  const queryAt = clean.indexOf("<user_query>");
  const queryEnd = clean.lastIndexOf("</user_query>");
  const interrupt = /^\s*The user interrupted the previous turn:/.test(clean);
  if (queryAt >= 0 && queryEnd > queryAt && (clean.slice(0, queryAt).trim() === "" || interrupt)) {
    clean = clean.slice(queryAt + "<user_query>".length, queryEnd).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  }
  clean = clean.replace(/^@((?:[A-Za-z]:[\\/])?[^\s]*[\\/][^\s]+)\s+/, "");
  return { text: clean.trim(), attachments, notices };
}

/** Grok persists its prompt scaffolding as user messages, alongside actual queries. */
export function userText(line: Wire): string {
  const face = userFacing(line);
  return face.text || face.attachments.map((a) => a.name).join(", ");
}

const KIND_NAME: Record<string, string> = {
  read: "Read",
  edit: "Edit",
  delete: "Delete",
  move: "Move",
  search: "Grep",
  execute: "Bash",
  fetch: "WebFetch",
  think: "Thinking",
};

function textField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function metaToolName(update: Wire): string {
  const meta = update._meta ?? update.meta;
  if (!meta || typeof meta !== "object") return "";
  const nested = meta["x.ai/tool"];
  const tool = nested && typeof nested === "object" ? nested as Wire : meta;
  return textField(tool.name);
}

/** A title short enough to be a tool name. ACP titles like `Execute \`npm test …\`` are not. */
export function isCompactToolTitle(title: string): boolean {
  return title.length > 0 && title.length <= 32 && !title.includes("`") && !title.includes("\n");
}

/** The name stored on a tool row. Prefer the programmatic name, then the kind, then a short title. */
export function toolCallName(update: Wire, previous?: string): string {
  const programmatic = textField(update.name) || metaToolName(update);
  if (programmatic) return programmatic;
  const title = textField(update.title);
  const meta = update._meta ?? update.meta;
  const backend = !!meta && typeof meta === "object" && (meta as Wire).backend === true;
  if (backend || /^web search\b/i.test(title)) return "WebSearch";
  const kind = KIND_NAME[textField(update.kind)];
  if (kind) return kind;
  if (isCompactToolTitle(title)) return title;
  return previous || "tool";
}

/** rawInput, with the file path and command aliases the transcript row already understands. */
export function toolCallInput(update: Wire, previous?: Record<string, unknown>): Record<string, unknown> {
  if (!update.rawInput || typeof update.rawInput !== "object" || Array.isArray(update.rawInput)) return previous ?? {};
  const input = { ...(update.rawInput as Record<string, unknown>) };
  const execute = /^Execute `([\s\S]+)`$/.exec(textField(update.title));
  if (execute && typeof input.command !== "string") input.command = execute[1];
  if (typeof input.file_path !== "string" && typeof input.target_file === "string") input.file_path = input.target_file;
  if (typeof input.path !== "string" && typeof input.target_directory === "string") input.path = input.target_directory;
  return input;
}

export interface GrokActivity {
  tasks: TaskActivity[];
  willWake: boolean;
  turnCompleted: boolean;
  spawnTool: { id: string; description: string } | null;
}

function textAt(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function agentState(status: unknown, error: unknown): TaskActivity["state"] {
  const value = textAt(status).toLowerCase();
  if (value === "cancelled" || value === "canceled" || value === "stopped") return "stopped";
  if (value === "failed" || value === "error" || error) return "failed";
  if (value === "completed" || value === "complete" || value === "success") return "completed";
  if (value === "running" || value === "in_progress" || value === "pending") return "running";
  return error ? "failed" : "completed";
}

function commandState(status: unknown, exitCode: unknown, killed: unknown): TaskActivity["state"] {
  if (killed === true) return "stopped";
  const value = textAt(status).toLowerCase();
  if (value === "cancelled" || value === "canceled" || value === "killed" || value === "stopped") return "stopped";
  if (value === "running" || value === "in_progress" || value === "pending" || value === "backgrounded") return "running";
  if (value === "failed" || value === "error") return "failed";
  if (typeof exitCode === "number") return exitCode === 0 ? "completed" : "failed";
  if (value === "completed" || value === "complete" || value === "success") return "completed";
  return "running";
}

function taskBase(partial: Pick<TaskActivity, "taskId" | "runId" | "kind" | "label" | "state"> & Partial<TaskActivity>, at: string): TaskActivity {
  return {
    toolUseId: null,
    parentToolUseId: null,
    childSessionId: null,
    startedAt: partial.state === "running" ? at : null,
    completedAt: partial.state === "running" ? null : at,
    observedAt: null,
    ...partial,
  };
}

/** One ACP session update, as a task snapshot. Message and tool chunks are ignored. */
export function grokActivity(update: Wire, at: string): GrokActivity {
  const kind = textAt(update.sessionUpdate);
  const empty: GrokActivity = { tasks: [], willWake: update.will_wake === true, turnCompleted: kind === "turn_completed", spawnTool: null };
  if (kind === "tool_call" || kind === "tool_call_update") {
    const name = toolCallName(update);
    const id = textAt(update.toolCallId);
    const description = textAt(update.rawInput?.description);
    if (name === "spawn_subagent" && id) empty.spawnTool = { id, description };
    return empty;
  }
  if (kind === "subagent_spawned" || kind === "subagent_finished") {
    const taskId = textAt(update.subagent_id);
    if (!taskId) return empty;
    const finished = kind === "subagent_finished";
    const state = finished ? agentState(update.status, update.error) : "running";
    const output = textAt(update.output);
    const label = textAt(update.description) || textAt(update.subagent_type) || "Subagent";
    const child = textAt(update.child_session_id) || taskId;
    empty.tasks = [taskBase({
      taskId,
      runId: textAt(update.attempt_id) || null,
      kind: "agent",
      label,
      state,
      childSessionId: child,
      ...(finished && output ? { summary: output } : {}),
    }, at)];
    return empty;
  }
  if (kind === "task_backgrounded") {
    const taskId = textAt(update.task_id);
    if (!taskId) return empty;
    empty.tasks = [taskBase({
      taskId,
      runId: null,
      kind: "command",
      label: textAt(update.description) || textAt(update.command) || "Command",
      state: "running",
      toolUseId: textAt(update.tool_call_id) || null,
    }, at)];
    return empty;
  }
  if (kind === "background_tasks" && Array.isArray(update.tasks)) {
    empty.tasks = update.tasks.flatMap((row: Wire) => {
      const taskId = textAt(row?.task_id);
      if (!taskId) return [];
      return [taskBase({
        taskId,
        runId: null,
        kind: "command",
        label: textAt(row.description) || textAt(row.command) || "Command",
        state: commandState(row.status, row.exit_code, row.explicitly_killed),
        toolUseId: textAt(row.tool_call_id) || null,
        ...(typeof row.started_at === "string" ? { startedAt: row.started_at } : {}),
        ...(typeof row.ended_at === "string" ? { completedAt: row.ended_at } : {}),
      }, at)];
    });
    return empty;
  }
  if (kind === "task_completed") {
    const snap = update.task_snapshot && typeof update.task_snapshot === "object" ? update.task_snapshot as Wire : update;
    const taskId = textAt(snap.task_id) || textAt(update.task_id);
    if (!taskId) return empty;
    const output = textAt(snap.output);
    const state = commandState(snap.status, snap.exit_code, snap.explicitly_killed ?? update.explicitly_killed);
    empty.tasks = [taskBase({
      taskId,
      runId: null,
      kind: "command",
      label: textAt(snap.description) || textAt(snap.command) || "Command",
      state: state === "running" ? "completed" : state,
      toolUseId: textAt(snap.tool_call_id) || textAt(update.tool_call_id) || null,
      ...(output ? { output: toolResult(output, (snap.exit_code ?? 0) === 0 && state !== "failed" && state !== "stopped") } : {}),
    }, at)];
    return empty;
  }
  return empty;
}

function terminal(state: TaskActivity["state"]): boolean {
  return state === "completed" || state === "failed" || state === "stopped";
}

function mergeActivity(prev: TaskActivity | undefined, next: TaskActivity): TaskActivity {
  if (!prev) return next;
  const state = terminal(prev.state) && next.state === "running" ? prev.state : next.state;
  return {
    ...prev,
    ...next,
    state,
    label: next.label || prev.label,
    toolUseId: next.toolUseId ?? prev.toolUseId,
    childSessionId: next.childSessionId ?? prev.childSessionId,
    startedAt: prev.startedAt ?? next.startedAt,
    completedAt: state === "running" ? null : next.completedAt ?? prev.completedAt,
    ...(next.summary ? { summary: next.summary } : prev.summary ? { summary: prev.summary } : {}),
    ...(next.output ? { output: next.output } : prev.output ? { output: prev.output } : {}),
  };
}

export interface SpawnLink {
  id: string;
  description: string;
  claimed: boolean;
}

/** Match a subagent spawn to the tool call that asked for the same description. */
export function claimSpawn(spawns: SpawnLink[], description: string): string | null {
  const wanted = description.trim();
  const match = [...spawns].reverse().find((spawn) => !spawn.claimed && (!wanted || spawn.description === wanted));
  if (!match) return null;
  match.claimed = true;
  return match.id;
}

function stamp(line: Wire): string {
  if (typeof line.timestamp_us === "number") return new Date(line.timestamp_us / 1000).toISOString();
  if (typeof line.timestamp === "number") return new Date(line.timestamp * 1000).toISOString();
  return new Date(0).toISOString();
}

function updateOf(line: Wire): Wire | null {
  const params = line.params;
  if (params && typeof params === "object" && !Array.isArray(params)) {
    const update = (params as Wire).update;
    if (update && typeof update === "object" && !Array.isArray(update)) return update as Wire;
  }
  return typeof line.sessionUpdate === "string" ? line : null;
}

/** Latest task per id from `updates.jsonl`. Chat text stays in `historyEntries`. */
export function tasksFromUpdates(lines: Wire[]): TranscriptEntry[] {
  const tasks = new Map<string, TaskActivity>();
  const spawns: SpawnLink[] = [];
  for (const line of lines) {
    const update = updateOf(line);
    if (!update) continue;
    const activity = grokActivity(update, stamp(line));
    if (activity.spawnTool) spawns.push({ ...activity.spawnTool, claimed: false });
    for (const task of activity.tasks) {
      if (task.kind === "agent" && !task.toolUseId) task.toolUseId = claimSpawn(spawns, textAt(update.description));
      const key = taskKey(task);
      tasks.set(key, mergeActivity(tasks.get(key), task));
    }
  }
  return [...tasks.values()].map((task) => ({ kind: "task", id: taskKey(task), task, at: task.completedAt ?? task.startedAt, parentToolUseId: null }));
}

function inputOf(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { return inputOf(JSON.parse(value)); } catch { return { arguments: value }; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function historyEntries(lines: Wire[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const tools = new Map<string, Extract<TranscriptEntry, { kind: "tool" }>>();
  lines.forEach((line, index) => {
    const type = line.type;
    if (type === "system" || typeof type !== "string") return;
    const id = `grok-${index}`;
    if (type === "user") {
      const face = userFacing(line);
      face.notices.forEach((notice, i) => entries.push({ kind: "system", id: `${id}:notice:${i}`, level: "warning", text: notice, at: null, parentToolUseId: null }));
      if (face.text || face.attachments.length) entries.push({ kind: "user", id, text: face.text, ...(face.attachments.length ? { attachments: face.attachments } : {}), at: null, parentToolUseId: null });
    } else if (type === "assistant") {
      const text = textOf(line.content);
      if (text) entries.push({ kind: "assistant", id, text, model: typeof line.model_id === "string" ? line.model_id : null, at: null, parentToolUseId: null });
      for (const call of Array.isArray(line.tool_calls) ? line.tool_calls : []) {
        if (typeof call.id !== "string") continue;
        const tool: Extract<TranscriptEntry, { kind: "tool" }> = { kind: "tool", id: call.id, name: call.name ?? call.function?.name ?? "tool", input: inputOf(call.arguments ?? call.function?.arguments), at: null, parentToolUseId: null };
        tools.set(tool.id, tool);
        entries.push(tool);
      }
    }
    else if (type === "thinking" || type === "reasoning") {
      const summary = type === "reasoning" && Array.isArray(line.summary) ? line.summary : [];
      const thought = summary.map((part: Wire) => typeof part?.text === "string" ? part.text : textOf(part)).filter(Boolean).join("\n") || textOf(line.content);
      const thoughtId = typeof line.id === "string" ? line.id : id;
      if (thought) entries.push({ kind: "thinking", id: thoughtId, text: thought, at: null, parentToolUseId: null });
    }
    else if (type === "backend_tool_call") {
      const kind = line.kind && typeof line.kind === "object" ? line.kind as Wire : {};
      const action = kind.action && typeof kind.action === "object" ? kind.action as Wire : {};
      const query = typeof action.query === "string" ? action.query : "";
      const sources = Array.isArray(action.sources) ? action.sources : [];
      const listed = sources.flatMap((source: Wire) => typeof source?.url === "string" ? [source.url] : []).join("\n");
      const toolId = typeof kind.id === "string" ? kind.id : typeof line.id === "string" ? line.id : id;
      const name = kind.tool_type === "web_search" ? "WebSearch" : typeof kind.tool_type === "string" ? kind.tool_type : "tool";
      entries.push({ kind: "tool", id: toolId, name, input: query ? { query } : {}, ...(listed || kind.tool_type ? { result: toolResult(listed, line.status !== "failed") } : {}), at: null, parentToolUseId: null });
    }
    else if (type === "tool_result") {
      const tool = tools.get(line.tool_call_id);
      const text = textOf(line.content);
      if (tool) tool.result = toolResult(text, line.is_error !== true && !/^Tool execution was halted/.test(text));
    }
    else if (type === "tool" || type === "tool_use" || type === "tool_call") {
      const name = typeof line.name === "string" ? line.name : typeof line.tool === "string" ? line.tool : "tool";
      const input = line.input && typeof line.input === "object" ? line.input as Record<string, unknown> : {};
      entries.push({ kind: "tool", id: typeof line.id === "string" ? line.id : id, name, input, at: null, parentToolUseId: null });
    }
  });
  return entries;
}

export { EventQueue } from "../queue.ts";
