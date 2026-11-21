// Antigravity harness. Speaks Agent Client Protocol (ACP) JSON-RPC over `agy acp --stdio`.
// Native session ids differ from Odin ids and live in harness_session_links.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import type { ModelInfo, PermissionAnswer, PermissionMode, UserMessage } from "@odin/shared/api";
import type { HarnessEvent, SlashCommand, TranscriptEntry, TaskActivity } from "@odin/shared/harness";
import { grokRules } from "../grok/map.ts";
import type { Harness, HarnessSessionInfo, SessionHandle, StartOptions } from "../types.ts";
import { startHostBridge, type HostBridge } from "./bridge.ts";
import { defaultHistoryRoot, listSessions, readMessages, sessionInfo } from "./history.ts";
import {
  ANTIGRAVITY_MODES,
  FALLBACK_MODELS,
  TURN_TIMEOUT_MS,
  acpMcpServers,
  modelsFrom,
  optionFor,
  permissionOptions,
  permissionRequest,
  slashCommands,
  textOf,
  toNativeMode,
  toolCallInput,
  toolCallName,
  toolResult,
  usageFrom,
  type AntigravityModel,
} from "./map.ts";
import { hostMcpScript } from "../grok/driver.ts";
import {
  antigravityBinary,
  antigravityVersion,
  connectAntigravity,
  type Rpc,
  type Wire,
} from "./transport.ts";
import { EventQueue } from "../queue.ts";

export interface AntigravityOptions {
  db: DatabaseSync;
  historyRoot?: string;
  connect?: () => Rpc;
  binary?: () => string | null;
  version?: (command: string) => Promise<void>;
  execFile?: typeof execFile;
  now?: () => Date;
}

const HARNESS_ID = "antigravity";

function withRules<T extends Record<string, unknown>>(body: T, opts: StartOptions): T {
  const rules = grokRules(opts.instructions, opts.agents);
  if (!rules) return body;
  return { ...body, _meta: { ...((body._meta as Record<string, unknown> | undefined) ?? {}), rules } };
}

export function createAntigravityHarness(options: AntigravityOptions): Harness {
  const historyRoot = options.historyRoot ?? defaultHistoryRoot();
  const connect = options.connect ?? (() => connectAntigravity());
  const now = options.now ?? (() => new Date());
  const links = options.db;
  let catalog: AntigravityModel[] = [...FALLBACK_MODELS];

  function nativeOf(sessionId: string): string {
    const row = links
      .prepare("SELECT native_id FROM harness_session_links WHERE harness = ? AND session_id = ?")
      .get(HARNESS_ID, sessionId) as { native_id: string } | undefined;
    return row?.native_id ?? sessionId;
  }

  function bind(sessionId: string, nativeId: string) {
    links
      .prepare("INSERT OR REPLACE INTO harness_session_links (harness, session_id, native_id) VALUES (?, ?, ?)")
      .run(HARNESS_ID, sessionId, nativeId);
  }

  function localOf(nativeId: string): string {
    const row = links
      .prepare("SELECT session_id FROM harness_session_links WHERE harness = ? AND native_id = ?")
      .get(HARNESS_ID, nativeId) as { session_id: string } | undefined;
    if (row) return row.session_id;
    const legacy = links.prepare("SELECT id FROM sessions WHERE id = ? AND harness = ?").get(nativeId, HARNESS_ID);
    const local = legacy ? nativeId : HARNESS_ID + ":" + nativeId;
    bind(local, nativeId);
    return local;
  }

  function remember(models: AntigravityModel[]) {
    if (models.length) catalog = models;
  }

  async function handshake(rpc: Rpc, isClosed = () => false): Promise<Wire> {
    const init = await rpc.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        tools: true,
        models: true,
      },
      clientInfo: { name: "odin", version: "0" },
    });
    if (isClosed()) return init;
    remember(modelsFrom(init));
    return init;
  }

  async function mcpServers(opts: StartOptions): Promise<{ servers: Wire[]; bridge: HostBridge | null }> {
    const servers = acpMcpServers(opts.mcpServers);
    if (!opts.hostTools?.length) return { servers, bridge: null };
    const bridge = await startHostBridge(opts.hostTools);
    const script = hostMcpScript();
    servers.push({
      name: "odin",
      command: process.execPath,
      args: [script, "--port", String(bridge.port)],
      env: process.env.ELECTRON_RUN_AS_NODE ? [{ name: "ELECTRON_RUN_AS_NODE", value: process.env.ELECTRON_RUN_AS_NODE }] : [],
    });
    return { servers, bridge };
  }

  function open(opts: StartOptions): SessionHandle {
    const odinId = opts.sessionId ?? opts.resume ?? randomUUID();
    const queue = new EventQueue<HarnessEvent>();
    const rpc = connect();
    const pending: UserMessage[] = [];
    const permissions = new Map<string, ReturnType<typeof permissionOptions>>();
    let native = "";
    let bridge: HostBridge | null = null;
    let closed = false;
    let exited = false;
    let initialized = false;
    let ready = false;
    let pumping = false;
    let mode: PermissionMode | null = opts.permissionMode ?? null;
    let model = opts.model ?? null;
    let effort = opts.effort ?? null;
    let commands: SlashCommand[] = [];
    let contextWindow: number | null = catalog.find((item) => item.value === model)?.contextWindow ?? catalog[0]?.contextWindow ?? null;
    const early: HarnessEvent[] = [];
    let thought = "";
    let message = "";
    const streamId = randomUUID();
    let turnKey = `${streamId}:turn-0`;
    let turnCount = 0;
    let segment = 0;
    const liveTools = new Map<string, Extract<TranscriptEntry, { kind: "tool" }>>();
    const liveTasks = new Map<string, TaskActivity>();

    function push(event: HarnessEvent) {
      if (exited) return;
      if (event.type === "exit") {
        exited = true;
        queue.push(event);
        queue.end();
        return;
      }
      if (!initialized) early.push(event);
      else queue.push(event);
    }

    function emitInit() {
      if (initialized) return;
      initialized = true;
      const tools = opts.hostTools?.map((tool) => tool.name) ?? [];
      queue.push({
        type: "init",
        sessionId: odinId,
        permissionMode: mode ?? "auto",
        model: model ?? catalog[0]?.value ?? "gemini-3.8-flash",
        cwd: opts.cwd,
        tools,
        slashCommands: commands,
        agents: [],
      });
      for (const event of early) queue.push(event);
      early.length = 0;
    }

    function emitEntry(entry: TranscriptEntry) {
      push({ type: "entry", entry });
    }

    function flushDeltas() {
      if (thought) {
        emitEntry({ kind: "thinking", id: `${turnKey}:think:${segment++}`, text: thought, at: now().toISOString(), parentToolUseId: null });
        thought = "";
      }
      if (message) {
        emitEntry({ kind: "assistant", id: `${turnKey}:reply:${segment++}`, text: message, model, at: now().toISOString(), parentToolUseId: null });
        message = "";
      }
    }

    async function applyModel(newModel: string) {
      model = newModel;
      const match = catalog.find((m) => m.value === newModel);
      if (match?.contextWindow) contextWindow = match.contextWindow;
      try {
        await rpc.request("session/set_model", {
          sessionId: native,
          modelId: newModel,
          _meta: effort ? { reasoningEffort: effort } : {},
        });
      } catch {
        /* Continue with existing model */
      }
    }

    async function applyEffort(newEffort: import("@odin/shared/api").Effort | null) {
      effort = newEffort;
      if (!model) return;
      try {
        await rpc.request("session/set_model", {
          sessionId: native,
          modelId: model,
          _meta: { reasoningEffort: newEffort ?? "medium" },
        });
      } catch {
        /* Ignore */
      }
    }

    async function applyMode(newMode: PermissionMode) {
      mode = newMode;
      try {
        await rpc.request("session/set_mode", {
          sessionId: native,
          modeId: toNativeMode(newMode),
        });
      } catch {
        /* Ignore */
      }
    }

    rpc.onMessage = (msg: Wire) => {
      const method = msg.method;
      const params = (msg.params ?? {}) as Wire;

      if (method === "session/request_permission" && typeof msg.id === "number") {
        const id = String(msg.id);
        const req = permissionRequest(id, odinId, params, now().toISOString());
        permissions.set(id, permissionOptions(params.options));
        push({ type: "permission.request", request: req });
        push({ type: "state", state: "waiting" });
        return;
      }

      if (method === "session/update") {
        const update = (params.update ?? {}) as Wire;
        const kind = update.sessionUpdate ?? update.kind ?? update.type;

        if (kind === "agent_thought_chunk" || kind === "agent_thought") {
          const delta = textOf(update.content ?? update.delta ?? update.text);
          if (delta) {
            thought += delta;
            push({ type: "delta", entryId: `${turnKey}:think:${segment}`, kind: "thinking", text: delta, parentToolUseId: null });
          }
        } else if (kind === "agent_message_chunk" || kind === "agent_message") {
          const delta = textOf(update.content ?? update.delta ?? update.text);
          if (delta) {
            message += delta;
            push({ type: "delta", entryId: `${turnKey}:reply:${segment}`, kind: "assistant", text: delta, parentToolUseId: null });
          }
        } else if (kind === "tool_call") {
          flushDeltas();
          const toolUseId = typeof update.toolCallId === "string" ? update.toolCallId : randomUUID();
          const name = toolCallName(update);
          const input = toolCallInput(update);
          const toolEntry: Extract<TranscriptEntry, { kind: "tool" }> = {
            kind: "tool",
            id: toolUseId,
            name,
            input,
            at: now().toISOString(),
            parentToolUseId: null,
          };
          liveTools.set(toolUseId, toolEntry);
          emitEntry(toolEntry);

          if (name === "Subagent" || update.name === "invoke_subagent") {
            const task: TaskActivity = {
              taskId: toolUseId,
              runId: toolUseId,
              kind: "agent",
              label: typeof input.Role === "string" ? input.Role : "Subagent",
              state: "running",
              toolUseId,
              parentToolUseId: null,
              childSessionId: null,
              startedAt: now().toISOString(),
              completedAt: null,
              observedAt: now().toISOString(),
            };
            liveTasks.set(toolUseId, task);
            push({ type: "task", task });
          }
        } else if (kind === "tool_call_update") {
          const toolUseId = typeof update.toolCallId === "string" ? update.toolCallId : "";
          const status = update.status;
          if (toolUseId && (status === "completed" || status === "failed" || status === "denied")) {
            const ok = status === "completed";
            const text = textOf(update.content ?? update.result);
            const res = toolResult(text, ok);
            push({ type: "tool.result", toolUseId, result: res });
            const existing = liveTools.get(toolUseId);
            if (existing) existing.result = res;

            if (liveTasks.has(toolUseId)) {
              const task = liveTasks.get(toolUseId)!;
              task.state = ok ? "completed" : status === "denied" ? "stopped" : "failed";
              task.completedAt = now().toISOString();
              push({ type: "task", task });
            }
          }
        }
      }
    };

    rpc.onExit = (err) => {
      if (exited) return;
      exited = true;
      if (!initialized) emitInit();
      push({ type: "exit", outcome: closed ? "closed" : "failed", error: err ? err.message : null });
      if (bridge) void bridge.close();
    };

    async function initSession(): Promise<void> {
      try {
        const init = await handshake(rpc, () => closed);
        if (closed) return;
        commands = slashCommands(init._meta?.commands ?? init.commands);
        const { servers, bridge: b } = await mcpServers(opts);
        bridge = b;

        if (opts.resume) {
          native = nativeOf(opts.resume);
          await rpc.request(
            "session/load",
            withRules({ sessionId: native, cwd: opts.cwd, mcpServers: servers }, opts),
            TURN_TIMEOUT_MS,
          );
        } else {
          const created = await rpc.request(
            "session/new",
            withRules({
              cwd: opts.cwd,
              mcpServers: servers,
              additionalDirectories: opts.additionalDirectories ?? [],
            }, opts),
            TURN_TIMEOUT_MS,
          );
          native = typeof created.sessionId === "string" ? created.sessionId : randomUUID();
          bind(odinId, native);
        }

        if (model) await applyModel(model);
        if (effort) await applyEffort(effort);
        if (mode) await applyMode(mode);

        emitInit();
        ready = true;
        if (opts.prompt) pending.push(opts.prompt);
        void pump();
      } catch (error) {
        emitInit();
        push({ type: "exit", outcome: "failed", error: error instanceof Error ? error.message : "Failed to start" });
        rpc.close();
      }
    }

    async function pump(): Promise<void> {
      if (pumping || !ready || closed) return;
      pumping = true;
      while (pending.length && !closed) {
        const next = pending.shift()!;
        turnCount++;
        turnKey = `${streamId}:turn-${turnCount}`;
        segment = 0;
        liveTools.clear();
        push({ type: "state", state: "running" });

        emitEntry({
          kind: "user",
          id: `${turnKey}:user`,
          text: next.text,
          ...(next.attachments?.length ? { attachments: next.attachments } : {}),
          at: now().toISOString(),
          parentToolUseId: null,
        });

        const startAt = Date.now();
        let ok = true;
        let turnError: string | null = null;

        try {
          const files = (next.attachments ?? []).map((att) => ({
            name: att.name,
            mediaType: att.mediaType,
            content: att.data,
          }));

          const res = await rpc.request(
            "session/prompt",
            {
              sessionId: native,
              prompt: [{ type: "text", text: next.text }],
              files,
              _meta: {
                modelId: model,
                reasoningEffort: effort ?? undefined,
              },
            },
            TURN_TIMEOUT_MS,
          );

          flushDeltas();
          const usage = usageFrom(res, contextWindow);
          if (usage) push(usage);
        } catch (error) {
          flushDeltas();
          ok = false;
          turnError = error instanceof Error ? error.message : "Turn failed";
        }

        push({
          type: "turn.end",
          durationMs: Date.now() - startAt,
          ok,
          error: turnError,
        });
        push({ type: "state", state: "idle" });
      }
      pumping = false;
    }

    void initSession();

    return {
      sessionId: odinId,
      events: queue,
      send(message: UserMessage) {
        if (closed) throw new Error("Session is closed");
        pending.push(message);
        if (ready) void pump();
      },
      answer(requestId: string, answer: PermissionAnswer) {
        const optionsList = permissions.get(requestId) ?? [];
        permissions.delete(requestId);
        const behavior = answer.behavior;
        const scope = answer.behavior === "allow" ? answer.scope : "once";
        const optionId = optionFor(optionsList, behavior, scope);
        if (optionId) {
          rpc.respond(Number(requestId), { outcome: { optionId } });
        } else {
          rpc.reject(Number(requestId), "Permission denied");
        }
        push({ type: "permission.resolved", requestId, behavior });
        push({ type: "state", state: "running" });
      },
      async interrupt() {
        if (closed) return;
        try {
          await rpc.request("session/cancel", { sessionId: native });
        } catch {
          /* Ignore */
        }
      },
      async setModel(newModel: string) {
        await applyModel(newModel);
      },
      async setEffort(newEffort: import("@odin/shared/api").Effort | null) {
        await applyEffort(newEffort);
      },
      async setPermissionMode(newMode: PermissionMode) {
        await applyMode(newMode);
      },
      async close() {
        if (closed) return;
        closed = true;
        rpc.close();
      },
    };
  }

  return {
    id: HARNESS_ID,
    name: "Antigravity",
    capabilities: {
      permissionModes: ANTIGRAVITY_MODES,
      permissionScopes: ["once", "session", "project"],
      additionalDirectories: true,
      instructions: true,
      attachments: true,
    },
    async check() {
      const command = (options.binary ?? antigravityBinary)();
      if (!command) return { available: false, note: "Install Antigravity CLI (agy) and sign in" };
      try {
        await (options.version ?? ((b: string) => antigravityVersion(b, options.execFile ?? execFile)))(command);
        return { available: true, note: `Uses existing Antigravity installation (${command})` };
      } catch {
        return { available: false, note: "Install Antigravity CLI (agy) and sign in" };
      }
    },
    start(opts: StartOptions): SessionHandle {
      return open(opts);
    },
    async list(): Promise<HarnessSessionInfo[]> {
      // The brain directory is shared by all worktrees and its transcripts carry no cwd.
      return listSessions(historyRoot);
    },
    async info(sessionId: string, _projectPath?: string): Promise<HarnessSessionInfo | null> {
      const native = nativeOf(sessionId);
      const info = sessionInfo(historyRoot, native);
      if (!info) return null;
      return { ...info, sessionId: localOf(native) };
    },
    async messages(sessionId: string, _projectPath?: string): Promise<TranscriptEntry[]> {
      const native = nativeOf(sessionId);
      return readMessages(historyRoot, native);
    },
    async rename(_sessionId: string, _title: string): Promise<void> {
      // ACP has no rename endpoint
    },
    async fork(sessionId: string, projectPath?: string): Promise<string> {
      const parent = nativeOf(sessionId);
      const rpc = connect();
      try {
        await handshake(rpc);
        await rpc.request("session/load", { sessionId: parent, cwd: projectPath, mcpServers: [] }, TURN_TIMEOUT_MS);
        const created = await rpc.request("session/fork", { sessionId: parent, cwd: projectPath });
        const native = created.sessionId;
        if (typeof native !== "string" || !native) throw new Error("Antigravity fork did not return a session id");
        const local = randomUUID();
        bind(local, native);
        return local;
      } finally {
        rpc.close();
      }
    },
    async delete(sessionId: string): Promise<void> {
      links.prepare("DELETE FROM harness_session_links WHERE harness = ? AND session_id = ?").run(HARNESS_ID, sessionId);
    },
    async models(): Promise<ModelInfo[]> {
      if (!catalog.length) {
        const rpc = connect();
        try {
          const init = await handshake(rpc);
          remember(modelsFrom(init));
        } catch {
          return FALLBACK_MODELS.map((m) => ({
            value: m.value,
            displayName: m.displayName,
            description: m.description,
            resolved: m.value,
            effortLevels: m.effortLevels,
          }));
        } finally {
          rpc.close();
        }
      }
      return catalog.map((model) => ({
        value: model.value,
        displayName: model.displayName,
        description: model.description,
        resolved: model.value,
        effortLevels: model.effortLevels,
      }));
    },
  };
}
