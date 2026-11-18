// The Claude driver: the Harness interface over @anthropic-ai/claude-agent-sdk. The only file set in core allowed to
// import the SDK (src/harness/claude/**). docs/contracts.md#harness.
//
// One `query()` per live handle in streaming-input mode. map.ts turns SDK messages into events, permissions.ts maps
// prompts and answers, history.ts maps stored conversations, input.ts feeds user messages, tools.ts serves host tools.
import { EventQueue as Channel } from "../queue.ts";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import * as sdk from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentDefinition,
  CanUseTool,
  EffortLevel,
  McpServerConfig,
  ModelInfo as SdkModelInfo,
  Options,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKSessionInfo,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ModelInfo, PermissionAnswer, PermissionMode, UserMessage } from "@odin/shared/api";
import type { HarnessEvent, PermissionRequest } from "@odin/shared/harness";
import { ODIN_MCP_SERVER } from "@odin/shared";
import type { Harness, HarnessSessionInfo, HostTool, McpServerStart, SessionHandle, StartOptions } from "../types.ts";
import { historyEntries } from "./history.ts";
import { InputQueue, toSdkUserMessage } from "./input.ts";
import { commandsKnown, createMapState, mapMessage, setState } from "./map.ts";
import { cancelledResult, toPermissionRequest, toPermissionResult } from "./permissions.ts";
import { hostToolDefinitions } from "./tools.ts";
import { toolOverride } from "../../tools/resolve.ts";

/** The SDK functions the driver uses; tests replace them (never spawn `claude`). */
export interface ClaudeSdk {
  listSubagents: typeof sdk.listSubagents;
  getSubagentMessages: typeof sdk.getSubagentMessages;
  query: typeof sdk.query;
  listSessions: typeof sdk.listSessions;
  getSessionInfo: typeof sdk.getSessionInfo;
  getSessionMessages: typeof sdk.getSessionMessages;
  renameSession: typeof sdk.renameSession;
  forkSession: typeof sdk.forkSession;
  deleteSession: typeof sdk.deleteSession;
  createSdkMcpServer: typeof sdk.createSdkMcpServer;
}

export interface ClaudeHarnessOptions {
  /** Override the bundled claude executable (tests never start one). */
  pathToClaudeCodeExecutable?: string;
  /** Replace SDK functions (tests inject a fake `query`). */
  sdk?: Partial<ClaudeSdk>;
  /** Where the CLI's stderr and driver diagnostics go. Never returned to clients. Default: console.error. */
  log?: (line: string) => void;
  now?: () => Date;
  /** Resolves a package specifier (for check()). Default: Node resolution from the SDK's own location. */
  resolvePackage?: (specifier: string) => string;
  /** Reads the Settings tool override (tests inject one). Default: tools/resolve.ts. Called at each start/check. */
  toolOverride?: (name: "claude") => string | null;
}

/**
 * Only when the CLI can't report its catalog (not installed, failed to start). The CLI's own list (versions, resolved
 * ids, per-model effort levels) is the source of truth; this stays deliberately bare so it never goes stale.
 */
const FALLBACK_MODELS: ModelInfo[] = [
  { value: "default", displayName: "Default", description: "The account's default model", resolved: null },
  { value: "opus", displayName: "Opus", description: "", resolved: null },
  { value: "sonnet", displayName: "Sonnet", description: "", resolved: null },
  { value: "haiku", displayName: "Haiku", description: "", resolved: null },
];

/** How long models() waits for the CLI's catalog when nothing is cached yet. */
const CATALOG_TIMEOUT_MS = 20_000;

/** The CLI's model rows as Odin's catalog. */
function catalog(models: SdkModelInfo[]): ModelInfo[] {
  return models.map((m) => ({
    value: m.value,
    displayName: m.displayName,
    description: m.description,
    resolved: m.resolvedModel ?? null,
    ...(m.supportedEffortLevels?.length ? { effortLevels: [...m.supportedEffortLevels] } : {}),
  }));
}

/** The platform binary packages the SDK may use here, most specific first. */
export function binaryPackages(platform: string = process.platform, arch: string = process.arch): string[] {
  const base = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;
  return platform === "linux" ? [base, `${base}-musl`] : [base];
}

function defaultResolve(specifier: string): string {
  const require = createRequire(import.meta.url);
  const from = createRequire(require.resolve("@anthropic-ai/claude-agent-sdk"));
  return from.resolve(specifier);
}

function mcpConfig(s: McpServerStart): McpServerConfig {
  if (s.type === "stdio") return { type: "stdio", command: s.command, ...(s.args ? { args: s.args } : {}), ...(s.env ? { env: s.env } : {}) };
  return { type: s.type, url: s.url, ...(s.headers ? { headers: s.headers } : {}) };
}

function iso(ms: number | undefined): string | null {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function sessionInfo(s: SDKSessionInfo): HarnessSessionInfo {
  return {
    sessionId: s.sessionId,
    title: s.customTitle || s.summary || s.firstPrompt || "Untitled",
    firstPrompt: s.firstPrompt ?? null,
    cwd: s.cwd ?? null,
    gitBranch: s.gitBranch ?? null,
    createdAt: iso(s.createdAt),
    updatedAt: iso(s.lastModified) ?? new Date(0).toISOString(),
  };
}

interface OpenPrompt {
  request: PermissionRequest;
  input: Record<string, unknown>;
  suggestions: PermissionUpdate[];
  resolve: (r: PermissionResult) => void;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createClaudeHarness(options: ClaudeHarnessOptions = {}): Harness {
  const api: ClaudeSdk = {
    listSubagents: sdk.listSubagents,
    getSubagentMessages: sdk.getSubagentMessages,
    query: sdk.query,
    listSessions: sdk.listSessions,
    getSessionInfo: sdk.getSessionInfo,
    getSessionMessages: sdk.getSessionMessages,
    renameSession: sdk.renameSession,
    forkSession: sdk.forkSession,
    deleteSession: sdk.deleteSession,
    createSdkMcpServer: sdk.createSdkMcpServer,
    ...options.sdk,
  };
  const log = options.log ?? ((line: string) => console.error(line));
  const now = options.now ?? (() => new Date());
  const resolvePackage = options.resolvePackage ?? defaultResolve;
  /** The executable for this start/check: the explicit option, else the Settings override, else the SDK's bundled one. */
  const claudeExecutable = (): string | null => options.pathToClaudeCodeExecutable ?? (options.toolOverride ?? toolOverride)("claude");
  let modelCache: ModelInfo[] | null = null;

  function refreshModels(q: Query): void {
    q.supportedModels().then(
      (models) => {
        if (models.length) {
          modelCache = catalog(models);
        }
      },
      (err) => log(`[claude] supportedModels failed: ${errorText(err)}`),
    );
  }

  let probing: Promise<void> | null = null;
  /** Ask an idle CLI (no prompt sent, so no model call) for its catalog. One at a time; a failure retries next call. */
  function probeModels(): Promise<void> {
    probing ??= (async () => {
      const executable = claudeExecutable();
      let q: Query | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        q = api.query({ prompt: new InputQueue<SDKUserMessage>(), options: { ...(executable ? { pathToClaudeCodeExecutable: executable } : {}), stderr: (l) => log(`[claude models] ${l.trimEnd()}`) } });
        const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), CATALOG_TIMEOUT_MS); });
        const models = await Promise.race([q.supportedModels(), timeout]);
        if (models.length && !modelCache) modelCache = catalog(models);
      } catch (err) {
        log(`[claude] reading the model catalog failed: ${errorText(err)}`);
      } finally {
        clearTimeout(timer);
        try { q?.close(); } catch { /* already gone */ }
        probing = null;
      }
    })();
    return probing;
  }

  function start(opts: StartOptions): SessionHandle {
    const executable = claudeExecutable();
    const sessionId = opts.fork || !opts.resume ? (opts.sessionId ?? randomUUID()) : opts.resume;
    const tag = `[claude ${sessionId.slice(0, 8)}]`;
    const events = new Channel<HarnessEvent>();
    const input = new InputQueue<SDKUserMessage>();
    const state = createMapState({ resumed: !!opts.resume });
    const sent = new Set<string>();
    const outbox: UserMessage[] = [];
    const open = new Map<string, OpenPrompt>();
    /** Events produced before `init` (a first message's state and entry) go out right after it. */
    const beforeInit: HarnessEvent[] = [];
    let turnActive = false;
    /** An interrupt was asked for this turn: its result (`error_during_execution` plus a diagnostic) is a stop, not a failure. */
    let interrupting = false;
    /** The last turn ended as an interrupt; the SDK then throws its own "error result" error, which is no failure. */
    let endedInterrupted = false;
    let closed = false;
    let modelsAsked = false;

    const emit = (e: HarnessEvent) => {
      if (closed && e.type !== "exit") return;
      if (!state.initSent && e.type !== "init" && e.type !== "exit") {
        beforeInit.push(e);
        return;
      }
      events.push(e);
      if (e.type === "init") for (const b of beforeInit.splice(0)) events.push(b);
    };
    const emitAll = (list: HarnessEvent[]) => list.forEach(emit);

    function deliver(): void {
      if (closed || turnActive || !outbox.length) return;
      const message = outbox.shift()!;
      const uuid = randomUUID();
      sent.add(uuid);
      turnActive = true;
      endedInterrupted = false;
      input.push(toSdkUserMessage(message, uuid));
      emitAll(setState(state, "running"));
      const attachments = (message.attachments ?? []).map((a) => ({ name: a.name, mediaType: a.mediaType }));
      emit({
        type: "entry",
        entry: {
          kind: "user",
          id: uuid,
          text: message.text,
          ...(attachments.length ? { attachments } : {}),
          at: now().toISOString(),
          parentToolUseId: null,
        },
      });
    }

    /** `resume`: go back to running when no prompt is left (not when the handle is ending). */
    function settle(requestId: string, behavior: "allow" | "deny" | "cancelled", result: PermissionResult, resume = true): void {
      const p = open.get(requestId);
      if (!p) return;
      open.delete(requestId);
      emit({ type: "permission.resolved", requestId, behavior });
      if (resume && !open.size && turnActive && !closed) emitAll(setState(state, "running"));
      p.resolve(result);
    }

    function cancelPrompts(resume: boolean): void {
      for (const id of [...open.keys()]) settle(id, "cancelled", cancelledResult(), resume);
    }

    const canUseTool: CanUseTool = (toolName, toolInput, o) =>
      new Promise<PermissionResult>((resolve) => {
        if (closed || o.signal.aborted) {
          resolve(cancelledResult());
          return;
        }
        const request = toPermissionRequest(sessionId, toolName, toolInput, o, now().toISOString());
        open.set(request.id, { request, input: toolInput, suggestions: o.suggestions ?? [], resolve });
        emit({ type: "permission.request", request });
        emitAll(setState(state, "waiting"));
        o.signal.addEventListener("abort", () => settle(request.id, "cancelled", cancelledResult()), { once: true });
      });

    const mcpServers: Record<string, McpServerConfig> = {};
    for (const [name, s] of Object.entries(opts.mcpServers ?? {})) mcpServers[name] = mcpConfig(s);
    // One in-process MCP server per HostTool.server (default ODIN_MCP_SERVER).
    const byServer = new Map<string, HostTool[]>();
    for (const t of opts.hostTools ?? []) {
      const server = t.server ?? ODIN_MCP_SERVER;
      byServer.set(server, [...(byServer.get(server) ?? []), t]);
    }
    for (const [server, tools] of byServer) {
      mcpServers[server] = api.createSdkMcpServer({ name: server, tools: hostToolDefinitions(tools) });
    }
    const agents: Record<string, AgentDefinition> | undefined = opts.agents
      ? Object.fromEntries(
          Object.entries(opts.agents).map(([k, a]) => [
            k,
            { description: a.description, prompt: a.prompt, ...(a.tools ? { tools: a.tools } : {}), ...(a.model ? { model: a.model } : {}) },
          ]),
        )
      : undefined;

    const queryOptions: Options = {
      cwd: opts.cwd,
      ...(opts.fork || !opts.resume ? { sessionId } : {}),
      ...(opts.resume ? { resume: opts.resume } : {}),
      ...(opts.resume && opts.fork ? { forkSession: true } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.effort ? { effort: opts.effort as EffortLevel } : {}),
      permissionMode: opts.permissionMode ?? "default",
      // Lets the session switch to bypassPermissions later (the CLI refuses it otherwise). It doesn't change the mode.
      allowDangerouslySkipPermissions: true,
      canUseTool,
      includePartialMessages: true,
      settingSources: ["user", "project", "local"],
      ...(opts.instructions ? { systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append: opts.instructions } } : {}),
      ...(agents ? { agents } : {}),
      ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
      ...(opts.additionalDirectories?.length ? { additionalDirectories: opts.additionalDirectories } : {}),
      ...(opts.title ? { title: opts.title } : {}),
      env: process.env,
      stderr: (data: string) => {
        for (const line of data.split("\n")) if (line.trim()) log(`${tag} ${line}`);
      },
      ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
    };

    let q: Query;
    try {
      q = api.query({ prompt: input, options: queryOptions });
    } catch (err) {
      // Same contract as a query that dies: init never comes, one exit failed.
      closed = true;
      queueMicrotask(() => {
        events.push({ type: "exit", outcome: "failed", error: errorText(err) });
        events.end();
      });
      return deadHandle(sessionId, events);
    }

    function finish(error: string | null): void {
      if (closed) return;
      cancelPrompts(false);
      closed = true;
      input.end();
      events.push(error === null ? { type: "exit", outcome: "closed", error: null } : { type: "exit", outcome: "failed", error });
      events.end();
    }

    async function pump(): Promise<void> {
      try {
        for await (const message of q) {
          if (closed) break;
          const out = mapMessage(state, message, sent);
          for (let e of out) {
            if (e.type === "turn.end" && interrupting && !e.ok) e = { ...e, error: "interrupted" };
            emit(e);
            if (e.type === "init" && !modelsAsked) {
              modelsAsked = true;
              refreshModels(q);
            }
            if (e.type === "turn.end") {
              turnActive = false;
              interrupting = false;
              endedInterrupted = e.error === "interrupted";
            }
          }
          if (!turnActive) deliver();
        }
        finish(closed ? null : "claude exited");
      } catch (err) {
        if (!closed && endedInterrupted && /returned an error result/i.test(errorText(err))) {
          finish(null);
          return;
        }
        if (!closed) log(`${tag} query failed: ${errorText(err)}`);
        finish(errorText(err));
      }
    }

    if (opts.prompt) outbox.push(opts.prompt);
    deliver();
    // The initialize response carries the full command list (descriptions, hints, aliases); system/init has names only.
    const initialized = typeof q.initializationResult === "function" ? q.initializationResult() : null;
    initialized?.then(
      (r) => {
        if (!closed && r?.commands) emitAll(commandsKnown(state, r.commands));
      },
      () => {},
    );
    if (!opts.prompt && initialized) {
      // A reattach without a message: the CLI sends system/init only with a turn, so announce the session from the
      // start options and the initialize response, then sit idle.
      initialized.then(
        (r) => {
          if (closed || state.initSent) return;
          emitAll(mapMessage(state, {
            type: "system",
            subtype: "init",
            session_id: sessionId,
            model: opts.model ?? null,
            permissionMode: opts.permissionMode ?? "default",
            cwd: opts.cwd,
            tools: [],
            slash_commands: (r?.commands ?? []).map((c) => c.name),
            agents: (r?.agents ?? []).map((a) => a.name),
          }));
          if (!turnActive) emitAll(setState(state, "idle"));
          if (r?.models?.length && !modelCache) {
            modelCache = catalog(r.models);
          }
        },
        (err) => log(`${tag} initialize failed: ${errorText(err)}`),
      );
    }
    void pump();

    const handle: SessionHandle = {
      sessionId,
      events,
      send(message) {
        if (closed) return;
        outbox.push(message);
        deliver();
      },
      answer(requestId, answer: PermissionAnswer) {
        const p = open.get(requestId);
        if (!p) return;
        settle(requestId, answer.behavior, toPermissionResult(answer, p.request.toolName, p.input, p.suggestions));
      },
      async interrupt() {
        if (closed || !turnActive) return;
        interrupting = true;
        cancelPrompts(true);
        await q.interrupt();
      },
      async setEffort(effort) {
        if (closed) throw new Error("session is closed");
        await q.applyFlagSettings({ effortLevel: effort as EffortLevel | null });
      },
      async setModel(model) {
        if (closed) throw new Error("session is closed");
        await q.setModel(model);
        state.model = model;
        emit({ type: "model", model });
      },
      async setPermissionMode(mode: PermissionMode) {
        if (closed) throw new Error("session is closed");
        await q.setPermissionMode(mode);
        state.permissionMode = mode;
        emit({ type: "permission.mode", mode });
      },
      async close() {
        if (closed) return;
        cancelPrompts(false);
        closed = true;
        outbox.length = 0;
        input.end();
        try {
          q.close();
        } catch (err) {
          log(`${tag} close failed: ${errorText(err)}`);
        }
        events.push({ type: "exit", outcome: "closed", error: null });
        events.end();
      },
    };
    return handle;
  }

  return {
    id: "claude",
    name: "Claude",
    capabilities: { permissionModes: ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions", "auto"], permissionScopes: ["once", "session", "project", "user"], additionalDirectories: true, instructions: true, attachments: true, checkpoints: { forkAt: true } },
    async check() {
      const executable = claudeExecutable();
      if (executable) {
        return existsSync(executable)
          ? { available: true, note: `auth: inherited from the environment (${executable})` }
          : { available: false, note: `claude executable not found at ${executable}` };
      }
      for (const pkg of binaryPackages()) {
        try {
          resolvePackage(`${pkg}/package.json`);
          return { available: true, note: "auth: inherited from the environment" };
        } catch {
          // try the next one
        }
      }
      return { available: false, note: `no Claude Code binary for ${process.platform}-${process.arch} (${binaryPackages()[0]} is not installed)` };
    },
    start,
    async list(projectPath) {
      const sessions = await api.listSessions({ dir: projectPath, includeWorktrees: true });
      return sessions.map(sessionInfo).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async info(sessionId, projectPath) {
      const s = await api.getSessionInfo(sessionId, projectPath ? { dir: projectPath } : undefined);
      return s ? sessionInfo(s) : null;
    },
    async messages(sessionId, projectPath) {
      return historyEntries(await api.getSessionMessages(sessionId, { ...(projectPath ? { dir: projectPath } : {}), includeSystemMessages: true }));
    },
    async taskMessages(sessionId, task, projectPath) {
      if (task.kind !== "agent" || !task.childSessionId) return { status: "unavailable", reason: "No native child conversation is available" };
      const opts = projectPath ? { dir: projectPath } : undefined;
      const agents = await api.listSubagents(sessionId, opts);
      if (!agents.includes(task.childSessionId)) return { status: "unavailable", reason: "Child conversation is not available in this session" };
      return { status: "available", transcript: historyEntries(await api.getSubagentMessages(sessionId, task.childSessionId, opts)) };
    },
    async rename(sessionId, title, projectPath) {
      await api.renameSession(sessionId, title, projectPath ? { dir: projectPath } : undefined);
    },
    async fork(sessionId, projectPath) {
      const r = await api.forkSession(sessionId, projectPath ? { dir: projectPath } : undefined);
      return r.sessionId;
    },
    async forkAt(sessionId, messageId, projectPath) {
      const opts = projectPath ? { dir: projectPath } : undefined;
      const stored = await api.getSessionMessages(sessionId, { ...opts, includeSystemMessages: true });
      // Entry ids are message uuids, with a suffix when one message makes several entries.
      const uuid = messageId.split(":")[0];
      const at = stored.findIndex((m) => m.uuid === uuid && m.type === "user");
      if (at < 0) throw new Error(`${messageId} is not a user message of session ${sessionId}`);
      // `upToMessageId` keeps the named message, so cut at the one before: the conversation just before the user spoke.
      const before = stored[at - 1]?.uuid;
      if (!before) throw new Error("there is nothing before the first message to rewind to; start a new session instead");
      const r = await api.forkSession(sessionId, { ...opts, upToMessageId: before });
      return r.sessionId;
    },
    async delete(sessionId, projectPath) {
      const opts = projectPath ? { dir: projectPath } : undefined;
      try {
        await api.deleteSession(sessionId, opts);
      } catch (error) {
        // Already removed outside Odin (or never created). Keep real I/O failures visible.
        if (await api.getSessionInfo(sessionId, opts)) throw error;
      }
    },
    async models() {
      if (!modelCache) await probeModels();
      return (modelCache ?? FALLBACK_MODELS).map((m) => ({ ...m }));
    },
  };
}

/** The handle of a query that couldn't be created: every call is a no-op; events end with the exit already queued. */
function deadHandle(sessionId: string, events: AsyncIterable<HarnessEvent>): SessionHandle {
  return {
    sessionId,
    events,
    send() {},
    answer() {},
    async interrupt() {},
    async setModel() {
      throw new Error("session is closed");
    },
    async setPermissionMode() {
      throw new Error("session is closed");
    },
    async close() {},
  };
}
