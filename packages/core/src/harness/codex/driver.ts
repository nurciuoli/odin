import { hostToolSchema } from "../host-schema.ts";
import { boundHostToolResult } from "../host-result.ts";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { readNativeHistory } from "./history.ts";
import { itemTasks, taskEntries } from "./activity.ts";
import { foldHarnessEvents } from "@odin/shared/transcript";
import { TOOL_RESULT_MAX_CHARS } from "@odin/shared/harness";
import type { DatabaseSync } from "node:sqlite";
import type {
  HarnessEvent,
  PermissionRequest,
  TranscriptEntry,
  TaskActivity,
} from "@odin/shared/harness";
import type {
  ModelInfo,
  PermissionAnswer,
  PermissionMode,
  UserMessage,
} from "@odin/shared/api";
import type {
  Harness,
  HarnessSessionInfo,
  HarnessMeasurement,
  SessionHandle,
  StartOptions,
} from "../types.ts";
import {
  CODEX_MODES,
  EventQueue,
  itemEntry,
  policy,
  userInput,
} from "./map.ts";
import {
  codexCommand,
  connectCodex,
  projectDirectories,
  fromWslPath,
  initialize,
  wslPath,
  type Rpc,
  type Wire,
} from "./transport.ts";
import type { CodexLibrary } from "./library.ts";
import { rolloutMeasurements } from "./measurements.ts";
import { codexFailure } from "./errors.ts";
import { codexSlashCommands, nativeSkills, parseCodexCommand, type CodexSkill } from "./commands.ts";

export interface CodexOptions {
  /** Native session rollout directory, injectable for isolated tests. */
  historyRoot?: string;
  db: DatabaseSync;
  wsl?: boolean;
  connect?: (cwd?: string) => Rpc;
  prepare?: (
    options: StartOptions,
    nativePath: (value: string) => string,
  ) => CodexLibrary;
}

export function createCodexHarness(options: CodexOptions): Harness {
  const historyRoot = options.historyRoot ?? join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
  const id = options.wsl ? "codex-wsl" : "codex";
  const name = options.wsl ? "Codex (WSL)" : "Codex";
  const connect =
    options.connect ??
    ((cwd?: string) => connectCodex(options.wsl, 30_000, cwd));
  const path = (value: string) => (options.wsl ? wslPath(value) : value);
  const links = options.db;
  const mappedId = (session: string): string | null => {
    const row = links
      .prepare(
        "SELECT native_id FROM harness_session_links WHERE harness = ? AND session_id = ?",
      )
      .get(id, session) as { native_id: string } | undefined;
    return row?.native_id ?? null;
  };
  const nativeId = (session: string): string => {
    const native = mappedId(session);
    if (!native) throw new Error("Codex did not finish creating this session, or its native mapping was lost. Start a new session; this record has been preserved.");
    return native;
  };
  function bind(session: string, native: string): void {
    links
      .prepare(
        "INSERT INTO harness_session_links (harness, session_id, native_id) VALUES (?, ?, ?)",
      )
      .run(id, session, native);
  }
  function localId(native: string): string {
    const row = links
      .prepare(
        "SELECT session_id FROM harness_session_links WHERE harness = ? AND native_id = ?",
      )
      .get(id, native) as { session_id: string } | undefined;
    if (row) return row.session_id;
    const local = `${id}:${native}`;
    bind(local, native);
    return local;
  }
  const storedCwd = (session: string) =>
    (
      links.prepare("SELECT cwd FROM sessions WHERE id = ?").get(session) as
        | { cwd: string }
        | undefined
    )?.cwd;
  async function using<T>(
    run: (rpc: Rpc) => Promise<T>,
    cwd?: string,
  ): Promise<T> {
    const rpc = connect(cwd);
    try {
      await initialize(rpc);
      return await run(rpc);
    } finally {
      rpc.close();
    }
  }
  const usingSession = <T>(session: string, run: (rpc: Rpc) => Promise<T>) =>
    using(run, storedCwd(session));
  function info(thread: Wire, cwd?: string): HarnessSessionInfo {
    return {
      sessionId: localId(thread.id),
      title: thread.name || thread.preview || "Untitled",
      firstPrompt: thread.preview ?? null,
      cwd: cwd ?? thread.cwd ?? null,
      gitBranch: thread.gitInfo?.branch ?? null,
      createdAt: thread.createdAt
        ? new Date(thread.createdAt * 1000).toISOString()
        : null,
      updatedAt: new Date((thread.updatedAt ?? 0) * 1000).toISOString(),
    };
  }

  function start(opts: StartOptions): SessionHandle {
    const sessionId = opts.sessionId ?? opts.resume ?? randomUUID();
    const events = new EventQueue<HarnessEvent>();
    const rpc = connect(opts.cwd);
    let closed = false;
    let initialized = false;
    let threadId = "";
    let turnId: string | null = null;
    let model = opts.model ?? null;
    let nextModel = model;
    let effort = opts.effort ?? null;
    let mode: PermissionMode = opts.permissionMode ?? "default";
    let busy = false;
    let began = 0;
    let previousUsage: Wire | null = null;
    let library: CodexLibrary | null = null;
    const queue: UserMessage[] = opts.prompt ? [opts.prompt] : [];
    const pending = new Map<
      string,
      { wireId: string | number; method: string; params: Wire }
    >();
    const edits = new Map<string, Wire>();
    const activityAgents = new Map<string, TaskActivity>();
    const commands = new Map<string, Wire>();
    const emit = (event: HarnessEvent) => events.push(event);
    let nativeSkillList: CodexSkill[] = [];
    /** Native skills for the cwd (`skills/list`) → a `commands` event when the list changed. Best effort. */
    async function refreshSkills(forceReload = false) {
      try {
        const result = await rpc.request("skills/list", { cwds: [path(opts.cwd)], ...(forceReload ? { forceReload } : {}) });
        if (closed) return;
        const next = nativeSkills(result);
        if (JSON.stringify(next) === JSON.stringify(nativeSkillList)) return;
        nativeSkillList = next;
        emit({ type: "commands", slashCommands: codexSlashCommands(library?.skills ?? [], nativeSkillList) });
      } catch {
        // Older app-servers without skills/list: library skills and built-ins only.
      }
    }
    function resolvePending() {
      for (const requestId of pending.keys())
        emit({ type: "permission.resolved", requestId, behavior: "cancelled" });
      pending.clear();
    }
    function finish(error: Error | null) {
      if (closed) return;
      closed = true;
      resolvePending();
      emit({
        type: "exit",
        outcome: error ? "failed" : "closed",
        error: error?.message ?? null,
      });
      events.end();
      rpc.close();
    }
    async function pump() {
      if (closed || !initialized || busy || !queue.length) return;
      busy = true;
      model = nextModel;
      began = Date.now();
      emit({ type: "state", state: "running" });
      const p = policy(mode);
      const sandboxPolicy =
        p.sandbox === "read-only"
          ? { type: "readOnly" }
          : p.sandbox === "danger-full-access"
            ? { type: "dangerFullAccess" }
            : {
                type: "workspaceWrite",
                writableRoots: [
                  path(opts.cwd),
                  ...(opts.additionalDirectories ?? []).map(path),
                ],
                networkAccess: false,
              };
      try {
        const message = queue.shift()!;
        // Built-ins run over app-server methods; both start ordinary turns (turn/* notifications follow).
        const command = message.attachments?.length ? null : parseCodexCommand(message.text);
        if (command?.kind === "compact") {
          await rpc.request("thread/compact/start", { threadId });
          return;
        }
        if (command?.kind === "review") {
          const result = await rpc.request("review/start", { threadId, target: command.target, delivery: "inline" });
          turnId = result?.turn?.id ?? turnId;
          return;
        }
        const input = userInput(message);
        const named = /^\/([a-z0-9][a-z0-9-]*)\b/.exec(message.text)?.[1];
        const skill = library?.skills.find((s) => s.name === named) ?? nativeSkillList.find((s) => s.name === named);
        if (skill) {
          input[0]!.text = message.text.replace(/^\//, "$");
          input.push({ type: "skill", name: skill.name, path: skill.path });
        }
        const params: Wire = {
          threadId,
          input,
          cwd: path(opts.cwd),
          approvalPolicy: p.approvalPolicy,
          sandboxPolicy,
        };
        if (model && model !== "default") params.model = model;
        params.effort = effort;
        if (mode === "plan" && model)
          params.collaborationMode = {
            mode: "plan",
            settings: {
              model,
              reasoning_effort: effort,
              developer_instructions: null,
            },
          };
        const result = await rpc.request("turn/start", params);
        turnId = result.turn.id;
      } catch (error) {
        finish(error instanceof Error ? error : new Error("Codex turn failed"));
      }
    }
    function request(message: Wire) {
      const p = message.params ?? {};
      if (p.threadId && p.threadId !== threadId) {
        rpc.reject(message.id, "Unknown Odin thread");
        return;
      }
      if (message.method === "item/tool/call") {
        const tool = opts.hostTools?.find((t) => t.name === p.tool);
        if (!tool) {
          rpc.respond(message.id, {
            success: false,
            contentItems: [{ type: "inputText", text: "Unknown host tool" }],
          });
          return;
        }
        void (async () => {
          try {
            const result = boundHostToolResult(await tool.handler(p.arguments ?? {}));
            if (!closed)
              rpc.respond(message.id, {
                success: !result.isError,
                contentItems: [
                  { type: "inputText", text: result.text },
                  ...(result.content ?? []).map(block => block.type === "image"
                    ? { type: "inputImage", imageUrl: `data:${block.mimeType};base64,${block.data}` }
                    : { type: "inputText", text: block.text }),
                ],
              });
          } catch {
            if (!closed)
              rpc.respond(message.id, {
                success: false,
                contentItems: [
                  { type: "inputText", text: "Odin host tool failed" },
                ],
              });
          }
        })();
        return;
      }
      const supported = [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/tool/requestUserInput",
        "item/permissions/requestApproval",
      ];
      if (!supported.includes(message.method)) {
        rpc.reject(message.id, "Unsupported Odin server request");
        return;
      }
      const requestId = String(message.id);
      pending.set(requestId, {
        wireId: message.id,
        method: message.method,
        params: p,
      });
      const question = message.method === "item/tool/requestUserInput";
      const permissions = message.method === "item/permissions/requestApproval";
      const toolName = question
        ? "AskUserQuestion"
        : message.method.includes("fileChange")
          ? "Edit"
          : permissions
            ? "Permissions"
            : "Bash";
      const input: Wire = question
        ? { questions: p.questions }
        : {
            ...(p.command ? { command: p.command } : {}),
            ...(p.cwd ? { cwd: p.cwd } : {}),
            ...(p.grantRoot ? { directory: p.grantRoot } : {}),
            ...(permissions ? { permissions: p.permissions } : {}),
            ...(edits.has(p.itemId)
              ? { changes: edits.get(p.itemId)!.changes }
              : {}),
            ...(p.networkApprovalContext
              ? { network: p.networkApprovalContext }
              : {}),
          };
      const req: PermissionRequest = {
        id: requestId,
        sessionId,
        kind: question ? "question" : "tool",
        toolName,
        toolUseId: p.itemId ?? null,
        input,
        title: question
          ? "Codex has a question"
          : p.networkApprovalContext
            ? "Codex requests network access"
            : `Codex requests ${toolName === "Bash" ? "command execution" : toolName === "Edit" ? "file changes" : "additional permissions"}`,
        description: p.reason ?? null,
        canAlwaysAllow:
          !question &&
          (permissions ||
            !p.availableDecisions ||
            p.availableDecisions.includes("acceptForSession")),
        defaultToDeny: true,
        createdAt: new Date().toISOString(),
      };
      emit({ type: "permission.request", request: req });
      emit({ type: "state", state: "waiting" });
    }
    rpc.onMessage = (message) => {
      if (closed) return;
      if (message.id !== undefined && message.method) {
        request(message);
        return;
      }
      const p = message.params ?? {};
      if (!initialized || (p.threadId && p.threadId !== threadId)) return;
      switch (message.method) {
        case "turn/started":
          turnId = p.turn.id;
          break;
        case "item/started":
        case "item/completed": {
          if (p.item?.type === "commandExecution") {
            if (message.method === "item/started") commands.set(p.item.id, { ...p.item });
            else commands.delete(p.item.id);
          }
          if (p.item?.type === "fileChange") {
            if (message.method === "item/started") edits.set(p.item.id, p.item);
            else edits.delete(p.item.id);
          }
          // Codex items don't carry a historical model identity. Keep that field unknown in both live and history.
          const entry = itemEntry(
            p.item ?? {},
            null,
            message.method === "item/completed",
          );
          if (entry) emit({ type: "entry", entry });
          for (const task of itemTasks(p.item ?? {}, false, activityAgents)) emit({ type: "task", task });
          break;
        }
        case "item/commandExecution/outputDelta": {
          const command = commands.get(p.itemId);
          if (!command || typeof p.delta !== "string") break;
          const text = (command.aggregatedOutput ?? "") + p.delta;
          command.aggregatedOutput = text.slice(0, TOOL_RESULT_MAX_CHARS);
          command.outputTruncated = command.outputTruncated || text.length > TOOL_RESULT_MAX_CHARS;
          for (const task of itemTasks(command)) {
            if (task.output) task.output.truncated ||= command.outputTruncated;
            emit({ type: "task", task });
          }
          break;
        }
        case "item/agentMessage/delta":
        case "item/reasoning/summaryTextDelta":
        case "item/reasoning/textDelta":
          emit({
            type: "delta",
            entryId: p.itemId,
            kind: message.method.includes("reasoning")
              ? "thinking"
              : "assistant",
            text: p.delta ?? "",
            parentToolUseId: null,
          });
          break;
        case "thread/tokenUsage/updated": {
          if (!busy || !turnId || p.turnId !== turnId) break;
          const total = p.tokenUsage?.total;
          if (!total) break;
          const span: Wire = {};
          for (const key of [
            "inputTokens",
            "cachedInputTokens",
            "cacheWriteInputTokens",
            "outputTokens",
          ])
            span[key] = Math.max(
              0,
              previousUsage
                ? (total[key] ?? 0) - (previousUsage[key] ?? 0)
                : (p.tokenUsage.last?.[key] ?? 0),
            );
          previousUsage = { ...total };
          emit({
            type: "usage",
            model: model ?? "codex-default",
            usage: {
              input: Math.max(
                0,
                span.inputTokens -
                  span.cachedInputTokens -
                  span.cacheWriteInputTokens,
              ),
              output: span.outputTokens,
              cacheRead: span.cachedInputTokens,
              cacheWrite: span.cacheWriteInputTokens,
            },
            cumulative: false,
            costUsd: null,
            contextTokens: p.tokenUsage.last?.totalTokens ?? null,
            contextWindow: p.tokenUsage.modelContextWindow ?? null,
          });
          break;
        }
        case "turn/plan/updated":
          emit({
            type: "todos",
            todos: (p.plan ?? []).map((step: Wire) => ({
              content: step.step,
              status:
                step.status === "inProgress"
                  ? "in_progress"
                  : step.status === "completed"
                    ? "completed"
                    : "pending",
            })),
          });
          break;
        case "serverRequest/resolved": {
          const requestId = String(p.requestId);
          if (pending.delete(requestId))
            emit({
              type: "permission.resolved",
              requestId,
              behavior: "cancelled",
            });
          break;
        }
        case "turn/completed":
          resolvePending();
          turnId = null;
          busy = false;
          emit({
            type: "turn.end",
            durationMs: Date.now() - began,
            ok: p.turn.status === "completed",
            error: p.turn.status === "interrupted" ? "interrupted" : p.turn.error ? codexFailure(p.turn.error) : null,
          });
          emit({ type: "state", state: "idle" });
          if (p.turn.status === "completed") void pump();
          break;
        case "skills/changed":
          void refreshSkills(true);
          break;
        case "error":
          emit({
            type: "notice",
            level: "error",
            text: codexFailure(p.error),
          });
          break;
      }
    };
    rpc.onExit = (error) => finish(error);
    const ready = (async () => {
      policy(mode);
      library = options.prepare?.(opts, path) ?? null;
      if (library?.permissionMode) mode = library.permissionMode;
      await initialize(rpc);
      if (closed) return;
      const config: Wire = { ...library?.config };
      // Codex otherwise exposes the question tool but rejects it in default mode.
      config.features = { ...config.features, default_mode_request_user_input: true };
      if (opts.mcpServers) {
        const servers: Wire = {};
        for (const [key, server] of Object.entries(opts.mcpServers)) {
          if (server.type === "sse")
            throw new Error(
              "Codex requires streamable HTTP or stdio MCP; use an HTTP override for this server",
            );
          servers[key] =
            server.type === "stdio"
              ? {
                  command: server.command,
                  args: server.args ?? [],
                  env: server.env ?? {},
                }
              : { url: server.url, http_headers: server.headers ?? {} };
        }
        config.mcp_servers = { ...config.mcp_servers, ...servers };
      }
      const params: Wire = {
        cwd: path(opts.cwd),
        ...policy(mode),
        config,
        excludeTurns: true,
      };
      if (opts.additionalDirectories?.length)
        params.runtimeWorkspaceRoots = [
          path(opts.cwd),
          ...opts.additionalDirectories.map(path),
        ];
      if (model && model !== "default") params.model = model;
      if (library?.instructions || opts.instructions)
        params.developerInstructions = library?.instructions || opts.instructions;
      if (!opts.resume && opts.hostTools?.length)
        params.dynamicTools = opts.hostTools.map((tool) => ({
          type: "function",
          name: tool.name,
          description: tool.description,
          inputSchema: hostToolSchema(tool.params),
        }));
      let result: Wire;
      if (opts.resume)
        result = await rpc.request(
          opts.fork ? "thread/fork" : "thread/resume",
          { ...params, threadId: nativeId(opts.resume) },
        );
      else {
        delete params.excludeTurns;
        result = await rpc.request("thread/start", params);
      }
      if (closed) return;
      threadId = result.thread.id;
      if (!opts.resume || opts.fork) bind(sessionId, threadId);
      model = result.model ?? model;
      nextModel = model;
      initialized = true;
      emit({
        type: "init",
        sessionId,
        model,
        permissionMode: mode,
        cwd: opts.cwd,
        tools: opts.hostTools?.map((tool) => tool.name) ?? [],
        slashCommands: codexSlashCommands(library?.skills ?? [], nativeSkillList),
        agents: Object.keys(opts.agents ?? {}),
      });
      void refreshSkills();
      if (opts.title)
        await rpc.request("thread/name/set", { threadId, name: opts.title });
      if (queue.length) await pump();
      else emit({ type: "state", state: "idle" });
    })();
    void ready.catch((error) =>
      finish(
        error instanceof Error
          ? error
          : new Error("Codex failed to initialize"),
      ),
    );
    return {
      sessionId,
      events,
      send(message) {
        if (closed) throw new Error("Codex session closed");
        queue.push(message);
        void pump();
      },
      answer(requestId: string, answer: PermissionAnswer) {
        const req = pending.get(requestId);
        if (!req || closed) return;
        if (
          answer.behavior === "allow" &&
          answer.scope !== "once" &&
          answer.scope !== "session"
        )
          throw new Error(
            "Codex supports approval for this call or this session only",
          );
        if (
          answer.behavior === "allow" &&
          answer.scope === "session" &&
          req.params.availableDecisions &&
          !req.params.availableDecisions.includes("acceptForSession")
        )
          throw new Error("This Codex request only supports approval once");
        let result: Wire;
        if (req.method === "item/tool/requestUserInput") {
          const answers: Wire = {};
          for (const q of req.params.questions ?? []) {
            const value =
              answer.behavior === "allow"
                ? ((answer.updatedInput?.answers as Wire)?.[q.question] ??
                  (answer.updatedInput?.answers as Wire)?.[q.id])
                : undefined;
            answers[q.id] = {
              answers: Array.isArray(value)
                ? value
                : value
                  ? [String(value)]
                  : [],
            };
          }
          result = { answers };
        } else if (req.method === "item/permissions/requestApproval")
          result = {
            permissions:
              answer.behavior === "allow" ? req.params.permissions : {},
            scope:
              answer.behavior === "allow" && answer.scope === "session"
                ? "session"
                : "turn",
          };
        else
          result = {
            decision:
              answer.behavior === "deny"
                ? "decline"
                : answer.scope === "session"
                  ? "acceptForSession"
                  : "accept",
          };
        rpc.respond(req.wireId, result);
        pending.delete(requestId);
        emit({
          type: "permission.resolved",
          requestId,
          behavior: answer.behavior,
        });
        emit({ type: "state", state: pending.size ? "waiting" : "running" });
        if (answer.behavior === "deny" && answer.interrupt)
          void rpc
            .request("turn/interrupt", { threadId, turnId })
            .catch(() => {});
      },
      async interrupt() {
        await ready;
        queue.length = 0;
        if (turnId && !closed)
          await rpc.request("turn/interrupt", { threadId, turnId });
      },
      async setEffort(value) { effort = value; },
      async setModel(value) {
        nextModel = value;
        emit({ type: "model", model: value });
      },
      async setPermissionMode(value) {
        policy(value);
        mode = value;
        emit({ type: "permission.mode", mode: value });
      },
      async close() {
        queue.length = 0;
        finish(null);
      },
    };
  }
  return {
    id,
    name,
    capabilities: {
      additionalDirectories: true, instructions: true, attachments: true,
      permissionModes: CODEX_MODES,
      permissionScopes: ["once", "session"],
      settingsOnNextTurn: true,
    },
    async check() {
      try {
        await using(async () => {});
        // The resolved executable (Settings override or PATH search); WSL runs codex inside the distribution.
        const where = options.wsl ? "WSL" : codexCommand().command;
        return {
          available: true,
          note: `Uses the existing Codex installation and login (${where})`,
        };
      } catch {
        return {
          available: false,
          note: options.wsl
            ? "Install and sign in to Codex in the default WSL distribution"
            : "Install Codex and sign in with the CLI",
        };
      }
    },
    start,
    async models(): Promise<ModelInfo[]> {
      return using(async (rpc) => {
        const models: ModelInfo[] = [];
        let cursor: string | null = null;
        do {
          const page: Wire = await rpc.request("model/list", { cursor });
          for (const m of page.data ?? [])
            if (!m.hidden)
              models.push({
                value: m.model,
                displayName: m.displayName,
                description: m.description ?? "",
                resolved: m.model,
                effortLevels: m.supportedReasoningEfforts?.map((e: { reasoningEffort: import("@odin/shared/api").Effort }) => e.reasoningEffort),
              });
          cursor = page.nextCursor ?? null;
        } while (cursor);
        return models;
      });
    },
    async list(projectPath) {
      const directories = await projectDirectories(projectPath, options.wsl);
      return using(async (rpc) => {
        const sessions: HarnessSessionInfo[] = [];
        let cursor: string | null = null;
        do {
          const page: Wire = await rpc.request("thread/list", {
            cwd: directories,
            cursor,
            sortKey: "updated_at",
            limit: 100,
          });
          for (const thread of page.data ?? [])
            sessions.push(
              info(
                thread,
                thread.cwd
                  ? options.wsl
                    ? fromWslPath(thread.cwd, projectPath)
                    : thread.cwd
                  : projectPath,
              ),
            );
          cursor = page.nextCursor ?? null;
        } while (cursor);
        return sessions;
      }, projectPath);
    },
    async info(session) {
      if (!mappedId(session)) return null;
      return usingSession(session, async (rpc) => {
        const result = await rpc.request("thread/read", {
          threadId: nativeId(session),
        });
        return info(result.thread);
      });
    },
    async messages(session): Promise<TranscriptEntry[]> {
      // Records exist before thread/start completes, including failed initializations.
      if (!mappedId(session)) return [];
      try { return await usingSession(session, async (rpc) => {
        const entries: TranscriptEntry[] = [];
        const agents = new Map<string, TaskActivity>();
        let cursor: string | null = null;
        do {
          const page: Wire = await rpc.request("thread/items/list", {
            threadId: nativeId(session),
            cursor,
            sortDirection: "asc",
            limit: 100,
          });
          for (const row of page.data ?? []) {
            const entry = itemEntry(
              { ...row.item, startedAtMs: row.startedAtMs },
              null,
            );
            if (entry) entries.push(entry);
            entries.push(...taskEntries(itemTasks({ ...row.item, startedAtMs: row.startedAtMs, completedAtMs: row.completedAtMs }, true, agents)));
          }
          cursor = page.nextCursor ?? null;
        } while (cursor);
        return foldHarnessEvents(entries.map(entry => ({ type: "entry", entry })));
      }); } catch (error) {
        if (!options.wsl) {
          const history = await readNativeHistory(nativeId(session), historyRoot);
          if (history) return history.transcript;
        }
        throw error;
      }
    },
    async taskMessages(session, task) {
      if (task.kind !== "agent" || !task.childSessionId) return { status: "unavailable", reason: "No native child conversation is available" };
      if (!options.wsl) {
        const history = await readNativeHistory(task.childSessionId, historyRoot);
        if (history) return history.parentId === nativeId(session)
          ? { status: "available", transcript: history.transcript }
          : { status: "unavailable", reason: "Child conversation does not belong to this session" };
      }
      try { return await usingSession(session, async rpc => {
        const childId = task.childSessionId!;
        const { thread } = await rpc.request("thread/read", { threadId: childId });
        const nativeParent = thread?.parentThreadId ?? thread?.source?.subAgent?.thread_spawn?.parent_thread_id ?? thread?.source?.subagent?.thread_spawn?.parent_thread_id;
        if (nativeParent !== nativeId(session)) return { status: "unavailable", reason: "Child conversation does not belong to this session" };
        const entries: TranscriptEntry[] = [];
        let cursor: string | null = null;
        const seen = new Set<string>();
        const agents = new Map<string, TaskActivity>();
        do {
          const page: Wire = await rpc.request("thread/items/list", { threadId: childId, cursor, sortDirection: "asc", limit: 100 });
          for (const row of page.data ?? []) {
            const item = { ...row.item, startedAtMs: row.startedAtMs, completedAtMs: row.completedAtMs };
            const entry = itemEntry(item, null);
            if (entry && !seen.has(entry.id)) { seen.add(entry.id); entries.push(entry); }
            entries.push(...taskEntries(itemTasks(item, true, agents)));
          }
          cursor = page.nextCursor ?? null;
        } while (cursor);
        return { status: "available", transcript: foldHarnessEvents(entries.map(entry => ({ type: "entry", entry }))) };
      }); } catch {
        if (!options.wsl) {
          const history = await readNativeHistory(task.childSessionId, historyRoot);
          if (history && history.parentId === nativeId(session)) return { status: "available", transcript: history.transcript };
        }
        return { status: "unavailable", reason: "Native child history is not available" };
      }
    },
    async measurements(session, projectPath) {
      return usingSession(session, async rpc => {
        const threadId = nativeId(session);
        const { thread } = await rpc.request("thread/read", { threadId });
        if (typeof thread?.path !== "string" || !thread.path.endsWith(".jsonl")) return null;
        const file = options.wsl ? fromWslPath(thread.path, projectPath ?? storedCwd(session) ?? "") : thread.path;
        const facts = await rolloutMeasurements(file, threadId);
        if (facts === null) return null;
        if (typeof thread.createdAt === "number") facts.push({
          id: "started", at: new Date(thread.createdAt * 1000).toISOString(), kind: "activity", data: {},
        });
        let cursor: string | null = null;
        const seen = new Set<string>();
        do {
          const page: Wire = await rpc.request("thread/turns/list", {
            threadId, cursor, sortDirection: "asc", itemsView: "full", limit: 100,
          });
          for (const turn of page.data ?? []) {
            if (seen.has(turn.id)) continue;
            seen.add(turn.id);
            const at = typeof turn.completedAt === "number" ? turn.completedAt : turn.startedAt;
            if (typeof at !== "number") continue;
            const timestamp = new Date(at * 1000).toISOString();
            if (turn.status !== "inProgress") {
              const durationMs = typeof turn.durationMs === "number" ? turn.durationMs
                : typeof turn.startedAt === "number" && typeof turn.completedAt === "number"
                  ? Math.max(0, (turn.completedAt - turn.startedAt) * 1000) : null;
              facts.push({ id: `turn:${turn.id}`, at: timestamp, kind: "turn", data: { durationMs, ok: turn.status === "completed" } });
            }
            for (const item of turn.items ?? []) {
              const entry = itemEntry(item, null);
              if (entry?.kind === "tool") facts.push({
                id: `tool:${entry.id}`, at: timestamp, kind: "tool", data: { name: entry.name, ok: entry.result?.ok ?? true },
              });
            }
          }
          cursor = page.nextCursor ?? null;
        } while (cursor);
        return facts.sort((a, b) => a.at.localeCompare(b.at)) satisfies HarnessMeasurement[];
      });
    },
    async rename(session, title) {
      if (!mappedId(session)) return;
      await usingSession(session, (rpc) =>
        rpc.request("thread/name/set", {
          threadId: nativeId(session),
          name: title,
        }),
      );
    },
    async fork(session) {
      return usingSession(session, async (rpc) => {
        const result = await rpc.request("thread/fork", {
          threadId: nativeId(session),
          excludeTurns: true,
        });
        const local = randomUUID();
        bind(local, result.thread.id);
        return local;
      });
    },
    async delete(session) {
      if (!mappedId(session)) return;
      await usingSession(session, (rpc) =>
        rpc.request("thread/delete", { threadId: nativeId(session) }),
      );
      links
        .prepare(
          "DELETE FROM harness_session_links WHERE harness = ? AND session_id = ?",
        )
        .run(id, session);
    },
  };
}
