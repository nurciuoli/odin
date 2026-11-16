// Grok Build harness. One `grok agent stdio` process per live session. ACP JSON-RPC.
// Native session ids differ from Odin ids and live in harness_session_links.
import { projectDirectories } from "../directories.ts";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import type { ModelInfo, PermissionAnswer, PermissionMode, UserMessage } from "@odin/shared/api";
import type { HarnessEvent, SlashCommand, TranscriptEntry } from "@odin/shared/harness";
import type { Harness, HarnessSessionInfo, SessionHandle, StartOptions } from "../types.ts";
import { startHostBridge, type HostBridge } from "./bridge.ts";
import { listSessions, readMessages, sessionInfo } from "./history.ts";
import {
  EventQueue,
  GROK_MODES,
  TURN_TIMEOUT_MS,
  acpMcpServers,
  authMethod,
  isMode,
  modelsFrom,
  optionFor,
  permissionOptions,
  permissionRequest,
  slashCommands,
  textOf,
  toolCallInput,
  toolCallName,
  toolResult,
  usageFrom,
  type GrokModel,
} from "./map.ts";
import { imagePromptsAccepted, promptBlocks } from "./input.ts";
import { connectGrok, grokBinary, grokVersion, type Rpc, type Wire } from "./transport.ts";

export interface GrokOptions {
  db: DatabaseSync;
  historyRoot?: string;
  connect?: () => Rpc;
  /** Binary lookup for check(). Default: grok on PATH. */
  binary?: () => string | null;
  version?: (command: string) => Promise<void>;
  execFile?: typeof execFile;
  now?: () => Date;
  directories?: (projectPath: string) => Promise<string[]>;
}

const HARNESS_ID = "grok";

export function createGrokHarness(options: GrokOptions): Harness {
  const historyRoot = options.historyRoot ?? join(process.env.GROK_HOME || join(homedir(), ".grok"), "sessions");
  const connect = options.connect ?? (() => connectGrok());
  const now = options.now ?? (() => new Date());
  const links = options.db;
  let catalog: GrokModel[] = [];

  function nativeOf(sessionId: string): string {
    const row = links.prepare("SELECT native_id FROM harness_session_links WHERE harness = ? AND session_id = ?").get(HARNESS_ID, sessionId) as { native_id: string } | undefined;
    return row?.native_id ?? sessionId;
  }
  function bind(sessionId: string, nativeId: string) {
    links.prepare("INSERT OR REPLACE INTO harness_session_links (harness, session_id, native_id) VALUES (?, ?, ?)").run(HARNESS_ID, sessionId, nativeId);
  }
  function localOf(nativeId: string): string {
    const row = links.prepare("SELECT session_id FROM harness_session_links WHERE harness = ? AND native_id = ?").get(HARNESS_ID, nativeId) as { session_id: string } | undefined;
    if (row) return row.session_id;
    // Preserve imported legacy records that used their native id directly.
    const legacy = links.prepare("SELECT id FROM sessions WHERE id = ? AND harness = ?").get(nativeId, HARNESS_ID);
    const local = legacy ? nativeId : HARNESS_ID + ":" + nativeId;
    bind(local, nativeId);
    return local;
  }
  function remember(models: GrokModel[]) {
    if (models.length) catalog = models;
  }
  async function handshake(rpc: Rpc, isClosed = () => false): Promise<Wire> {
    const init = await rpc.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "odin", version: "0" },
    });
    if (isClosed()) return init;
    remember(modelsFrom(init));
    await rpc.request("authenticate", { methodId: authMethod(init) });
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
    let requestedMode: PermissionMode | null = mode;
    let model = opts.model ?? null;
    let effort = opts.effort;
    let allowImages = true;
    let reportedModel: string | null = null;
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

    // Grok's ACP extension uses set_model metadata, independent of permission mode.
    async function applyEffort(value: import("@odin/shared/api").Effort | null) {
      const selected = catalog.find(m => m.value === model) ?? (!model ? catalog[0] : undefined);
      const level = value ?? selected?.defaultEffort;
      if (!level) throw new Error("Grok did not advertise a default effort for this model");
      const modelId = model ?? selected?.value;
      if (!modelId) throw new Error("Grok did not report its current model");
      await rpc.request("session/set_model", { sessionId: native, modelId, _meta: { reasoningEffort: level } });
    }
    function flushText() {
      const at = now().toISOString();
      if (thought) emit({ type: "entry", entry: { kind: "thinking", id: `${turnKey}:${segment}:thought`, text: thought, at, parentToolUseId: null } });
      if (message) emit({ type: "entry", entry: { kind: "assistant", id: `${turnKey}:${segment}:assistant`, text: message, model, at, parentToolUseId: null } });
      thought = "";
      message = "";
      segment += 1;
    }

    function emit(event: HarnessEvent) {
      if (exited) return;
      if (event.type === "exit") {
        exited = true;
        queue.push(event);
        queue.end();
        return;
      }
      if (!initialized) {
        early.push(event);
        return;
      }
      queue.push(event);
    }
    function finish(error: Error | null) {
      if (exited) return;
      closed = true;
      ready = false;
      pending.length = 0;
      void bridge?.close();
      for (const id of permissions.keys()) emit({ type: "permission.resolved", requestId: id, behavior: "cancelled" });
      permissions.clear();
      emit({ type: "exit", outcome: error ? "failed" : "closed", error: error ? error.message : null });
      rpc.close();
    }
    function noteUpdate(params: Wire) {
      const update = params.update ?? {};
      const kind = update.sessionUpdate;
      if (kind === "available_commands_update") {
        commands = slashCommands(update.availableCommands);
        const tools = update._meta?.tools;
        if (Array.isArray(tools)) commandTools = tools.filter((tool: unknown) => typeof tool === "string");
        if (initialized) emit({ type: "commands", slashCommands: commands });
      } else if (kind === "model_changed") {
        const id = typeof update.model_id === "string" ? update.model_id : typeof update.modelId === "string" ? update.modelId : "";
        if (id) {
          reportedModel = id;
          if (initialized && id !== model) {
            model = id;
            emit({ type: "model", model: id });
          }
        }
      } else if (kind === "current_mode_update" && isMode(update.currentModeId)) {
        mode = update.currentModeId;
        if (initialized) emit({ type: "permission.mode", mode: update.currentModeId });
      } else if (kind === "plan" && pumping && Array.isArray(update.entries)) {
        emit({ type: "todos", todos: update.entries.flatMap((entry: Wire) => {
          if (typeof entry.content !== "string" || !["pending", "in_progress", "completed"].includes(entry.status)) return [];
          return [{ content: entry.content, status: entry.status }];
        }) });
      } else if (kind === "agent_thought_chunk") {
        if (!pumping) return;
        if (message) flushText();
        const text = textOf(update.content);
        thought += text;
        if (text) emit({ type: "delta", entryId: `${turnKey}:${segment}:thought`, kind: "thinking", text, parentToolUseId: null });
      } else if (kind === "agent_message_chunk") {
        if (!pumping) return;
        if (thought) flushText();
        const text = textOf(update.content);
        message += text;
        if (text) emit({ type: "delta", entryId: `${turnKey}:${segment}:assistant`, kind: "assistant", text, parentToolUseId: null });
      } else if (kind === "tool_call" || kind === "tool_call_update") {
        if (!pumping || typeof update.toolCallId !== "string") return;
        if (thought || message) flushText();
        const id = typeof update.toolCallId === "string" ? update.toolCallId : `${turnKey}:tool`;
        const previous = liveTools.get(id);
        const entry: Extract<TranscriptEntry, { kind: "tool" }> = { ...previous, kind: "tool", id, name: toolCallName(update, previous?.name), input: toolCallInput(update, previous?.input), at: previous?.at ?? now().toISOString(), parentToolUseId: null };
        liveTools.set(id, entry);
        emit({ type: "entry", entry: { ...entry, input: { ...entry.input } } });
        const status = update.status;
        if (status === "completed" || status === "failed") {
          entry.result = toolResult(textOf(update.content ?? update.rawOutput), status === "completed");
          emit({ type: "tool.result", toolUseId: id, result: entry.result });
        }
      }
    }
    let commandTools: string[] = [];
    const sessionUpdates = new Set(["session/update", "_x.ai/session/update", "_x.ai/session_notification"]);
    rpc.onMessage = (incoming) => {
      if (closed) return;
      if (sessionUpdates.has(incoming.method)) {
        noteUpdate(incoming.params ?? {});
        if (incoming.id !== undefined) rpc.respond(incoming.id, {});
      } else if (incoming.method === "session/request_permission" && incoming.id !== undefined) {
        const id = String(incoming.id);
        const optionsFor = permissionOptions(incoming.params?.options);
        permissions.set(id, optionsFor);
        emit({ type: "permission.request", request: permissionRequest(id, odinId, incoming.params ?? {}, now().toISOString()) });
        emit({ type: "state", state: "waiting" });
      } else if (incoming.method && incoming.id !== undefined) {
        rpc.reject(incoming.id, "Unsupported client method");
      }
    };
    rpc.onExit = (error) => {
      if (!closed) finish(error ?? new Error("Grok exited"));
    };

    async function runTurn(user: UserMessage) {
      turnCount += 1;
      turnKey = `${streamId}:turn-${turnCount}`;
      segment = 0;
      liveTools.clear();
      thought = "";
      message = "";
      emit({ type: "state", state: "running" });
      let result: Wire;
      try {
        const built = promptBlocks(user, allowImages);
        for (const text of built.skipped) emit({ type: "notice", level: "warning", text });
        result = await rpc.request("session/prompt", { sessionId: native, prompt: built.blocks }, TURN_TIMEOUT_MS);
      } catch (error) {
        flushText();
        const text = error instanceof Error ? error.message : "Grok turn failed";
        emit({ type: "turn.end", durationMs: 0, ok: false, error: /cancel/i.test(text) ? "interrupted" : text });
        emit({ type: "state", state: "idle" });
        return;
      }
      flushText();
      const usage = usageFrom(result, contextWindow);
      if (usage && usage.type === "usage") {
        model = usage.model;
        emit(usage);
        emit({ type: "model", model: usage.model });
      }
      const stop = result.stopReason;
      const interrupted = stop === "cancelled";
      emit({
        type: "turn.end",
        durationMs: typeof result._meta?.usage?.apiDurationMs === "number" ? result._meta.usage.apiDurationMs : 0,
        ok: stop === "end_turn",
        error: stop === "end_turn" ? null : interrupted ? "interrupted" : typeof stop === "string" ? stop : "Grok turn failed",
      });
      emit({ type: "state", state: "idle" });
    }
    async function pump() {
      if (pumping || !ready) return;
      pumping = true;
      try {
        while (pending.length && !closed) await runTurn(pending.shift()!);
      } finally {
        pumping = false;
        if (pending.length && !closed) void pump();
      }
    }
    void (async () => {
      try {
        const init = await handshake(rpc, () => closed);
        if (closed) return;
        allowImages = imagePromptsAccepted(init);
        const mcp = await mcpServers(opts);
        bridge = mcp.bridge;
        if (closed) { await bridge?.close(); return; }
        if (opts.resume && !opts.fork) {
          native = nativeOf(opts.resume);
          await rpc.request("session/load", { sessionId: native, cwd: opts.cwd, mcpServers: mcp.servers }, TURN_TIMEOUT_MS);
        } else if (opts.resume && opts.fork) {
          const parent = nativeOf(opts.resume);
          await rpc.request("session/load", { sessionId: parent, cwd: opts.cwd, mcpServers: mcp.servers }, TURN_TIMEOUT_MS);
          if (closed) return;
          const forked = await rpc.request("session/fork", { sessionId: parent, cwd: opts.cwd });
          if (closed) return;
          native = typeof forked.sessionId === "string" ? forked.sessionId : "";
          if (!native) throw new Error("Grok fork did not return a session id");
          bind(odinId, native);
        } else {
          const created = await rpc.request("session/new", { cwd: opts.cwd, mcpServers: mcp.servers });
          if (closed) return;
          native = typeof created.sessionId === "string" ? created.sessionId : "";
          if (!native) throw new Error("Grok did not return a session id");
          bind(odinId, native);
          const createdModels = modelsFrom({ _meta: { modelState: { availableModels: created.models?.availableModels } } });
          remember(createdModels);
        }
        if (closed) return;
        if (opts.model && native) {
          const known = catalog.length === 0 || catalog.some((item) => item.value === opts.model);
          if (!known) {
            emit({ type: "notice", level: "warning", text: `Grok has no model ${opts.model}. This session continues with ${reportedModel ?? "the model Grok already has"}.` });
            if (reportedModel) model = reportedModel;
          } else {
            try {
              await rpc.request("session/set_model", { sessionId: native, modelId: opts.model });
              model = opts.model;
            } catch (error) {
              const text = error instanceof Error ? error.message : "Grok rejected the model";
              emit({ type: "notice", level: "warning", text: `Grok kept its current model. ${text}` });
              if (reportedModel) model = reportedModel;
            }
          }
        } else if (reportedModel) model = reportedModel;
        if (effort !== undefined && (catalog.find(m => m.value === model) ?? (!model ? catalog[0] : undefined))?.effortLevels?.length) {
          let applied: typeof effort;
          do { applied = effort; await applyEffort(applied ?? null); } while (applied !== effort);
        }
        if (requestedMode && native) {
          try {
            const initialMode = requestedMode;
            await rpc.request("session/set_mode", { sessionId: native, modeId: initialMode });
            mode = initialMode;
            while (requestedMode !== mode) {
              const nextMode: PermissionMode | null = requestedMode;
              await rpc.request("session/set_mode", { sessionId: native, modeId: nextMode });
              mode = nextMode;
            }
          } catch (error) {
            const text = error instanceof Error ? error.message : "Grok rejected the permission mode";
            emit({ type: "notice", level: "warning", text: `Grok kept its current permission mode. ${text}` });
          }
        }
        if (closed) return;
        contextWindow = catalog.find((item) => item.value === model)?.contextWindow ?? catalog[0]?.contextWindow ?? null;
        const tools = [...commandTools, ...(opts.hostTools?.map((tool) => tool.name) ?? [])];
        queue.push({
          type: "init",
          sessionId: odinId,
          model,
          permissionMode: mode,
          cwd: opts.cwd,
          tools,
          slashCommands: commands,
          agents: [],
        });
        initialized = true;
        for (const event of early) queue.push(event);
        early.length = 0;
        if ((opts.agents && Object.keys(opts.agents).length) || opts.instructions) {
          emit({ type: "notice", level: "warning", text: "Grok does not accept Odin subagent definitions or extra instructions on session start." });
        }
        ready = true;
        if (opts.prompt) pending.push(opts.prompt);
        else emit({ type: "state", state: "idle" });
        await pump();
      } catch (error) {
        finish(error instanceof Error ? error : new Error("Grok failed to start"));
      }
    })();

    return {
      sessionId: odinId,
      events: queue,
      send(message) {
        if (closed) throw new Error("Grok session closed");
        pending.push(message);
        void pump();
      },
      answer(requestId, answer: PermissionAnswer) {
        const choices = permissions.get(requestId);
        if (!choices) return;
        permissions.delete(requestId);
        const behavior = answer.behavior;
        const scope = answer.behavior === "allow" ? answer.scope : "once";
        const optionId = optionFor(choices, behavior, scope);
        const id: string | number = /^\d+$/.test(requestId) ? Number(requestId) : requestId;
        if (!optionId) {
          rpc.respond(id, { outcome: { outcome: "cancelled" } });
          emit({ type: "permission.resolved", requestId, behavior: "cancelled" });
        } else {
          rpc.respond(id, {
            outcome: { outcome: "selected", optionId },
            ...(answer.behavior === "allow" && answer.updatedInput ? { _meta: { updatedInput: answer.updatedInput } } : {}),
          });
          emit({ type: "permission.resolved", requestId, behavior });
        }
        emit({ type: "state", state: permissions.size ? "waiting" : "running" });
      },
      async interrupt() {
        if (closed) return;
        if (native) rpc.notify("session/cancel", { sessionId: native });
      },
      async setEffort(value) {
        if (closed) throw new Error("Grok session closed");
        if (initialized) await applyEffort(value);
        effort = value;
      },
      async setModel(value) {
        if (closed) throw new Error("Grok session closed");
        if (native) await rpc.request("session/set_model", { sessionId: native, modelId: value });
        model = value;
        emit({ type: "model", model: value });
      },
      async setPermissionMode(value) {
        if (closed) throw new Error("Grok session closed");
        if (!isMode(value)) throw new Error(`Grok does not support permission mode ${value}`);
        requestedMode = value;
        if (!initialized) return;
        if (native) await rpc.request("session/set_mode", { sessionId: native, modeId: value });
        mode = value;
        emit({ type: "permission.mode", mode: value });
      },
      async close() {
        if (closed) return;
        closed = true;
        pending.length = 0;
        try {
          if (native) await rpc.request("session/close", { sessionId: native }, 10_000);
        } catch {
          /* The process is going away either way. */
        }
        finish(null);
        await bridge?.close();
      },
    };
  }

  return {
    id: HARNESS_ID,
    name: "Grok",
    capabilities: { permissionModes: GROK_MODES, permissionScopes: ["once", "session"], additionalDirectories: false, instructions: false, attachments: true },
    async check() {
      const command = (options.binary ?? grokBinary)();
      if (!command) return { available: false, note: "Install Grok Build and sign in with grok login" };
      try {
        await (options.version ?? ((binary: string) => grokVersion(binary, options.execFile ?? execFile)))(command);
        return { available: true, note: `Uses the existing Grok Build installation and login (${command})` };
      } catch {
        return { available: false, note: "Install Grok Build and sign in with grok login" };
      }
    },
    start: open,
    async list(projectPath) {
      const directories = await (options.directories ?? projectDirectories)(projectPath);
      const found = new Map<string, HarnessSessionInfo>();
      for (const directory of directories) for (const info of listSessions(historyRoot, directory)) {
        const local = localOf(info.sessionId);
        found.set(local, { ...info, sessionId: local });
      }
      return [...found.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async info(sessionId, projectPath) {
      const native = nativeOf(sessionId);
      if (!projectPath) return null;
      const info = sessionInfo(join(historyRoot, encodeURIComponent(projectPath), native));
      return info ? { ...info, sessionId: localOf(native) } : null;
    },
    async messages(sessionId, projectPath): Promise<TranscriptEntry[]> {
      if (!projectPath) return [];
      return readMessages(historyRoot, projectPath, nativeOf(sessionId));
    },
    async rename() {
      /* Grok ACP has no rename method. Odin keeps the title. */
    },
    async fork(sessionId, projectPath) {
      if (!projectPath) throw new Error("Grok fork needs a working directory");
      const parent = nativeOf(sessionId);
      const rpc = connect();
      try {
        await handshake(rpc);
        await rpc.request("session/load", { sessionId: parent, cwd: projectPath, mcpServers: [] }, TURN_TIMEOUT_MS);
        const created = await rpc.request("session/fork", { sessionId: parent, cwd: projectPath });
        const native = created.sessionId;
        if (typeof native !== "string" || !native) throw new Error("Grok fork did not return a session id");
        const local = randomUUID();
        bind(local, native);
        return local;
      } finally {
        rpc.close();
      }
    },
    async delete(sessionId) {
      const native = nativeOf(sessionId);
      const command = (options.binary ?? grokBinary)();
      if (!command) throw new Error("Grok Build is not installed");
      await promisify(options.execFile ?? execFile)(command, ["sessions", "delete", native], { timeout: 15_000, windowsHide: true });
      links.prepare("DELETE FROM harness_session_links WHERE harness = ? AND session_id = ?").run(HARNESS_ID, sessionId);
    },
    async models(): Promise<ModelInfo[]> {
      if (!catalog.length) {
        const rpc = connect();
        try {
          const init = await rpc.request("initialize", {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: { name: "odin", version: "0" },
          });
          remember(modelsFrom(init));
        } catch {
          return [{ value: "grok-4.7", displayName: "Grok 4.7", description: "Default Grok Build model", resolved: null }];
        } finally {
          rpc.close();
        }
      }
      return catalog.map((model) => ({ value: model.value, displayName: model.displayName, description: model.description, resolved: model.value, ...(model.effortLevels ? { effortLevels: model.effortLevels } : {}) }));
    },
  };
}

/** host-mcp.js beside the running module when core is bundled, else the .ts source. */
export function hostMcpScript(base: string = import.meta.url): string {
  const js = fileURLToPath(new URL("./host-mcp.js", base));
  return existsSync(js) ? js : fileURLToPath(new URL("./host-mcp.ts", base));
}
