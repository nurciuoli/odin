import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { OpenCodeClient, OpenCodeEvent, SessionInfo, SessionMessageInfo, ModelRef, FormInfo, SessionMessageAssistantTool } from "@opencode/client";
import type { NativeCatalog, NativeSessionAction, NativeSessionState, PermissionAnswer, RuntimeOptions, UserMessage } from "@odin/shared/api";
import { taskKey, type HarnessEvent, type PermissionRequest, type TranscriptEntry, type TaskActivity } from "@odin/shared/harness";
import type { Harness, HarnessMeasurement, HarnessSessionInfo, StartOptions, SessionHandle } from "../types.ts";
import { projectDirectories } from "../directories.ts";
import { contentId, EventQueue, messageEntries, modelValue, permissionRequest, result, timestamp, tokenUsage } from "./map.ts";

export interface OpenCodeRuntime {
  client: OpenCodeClient;
  ready?(cwd: string): Promise<void>;
  resources?(sessionId: string): { agents: { name: string; description: string }[]; skills: { id: string; name: string; description: string }[] };
  prepare(sessionId: string, options: StartOptions): Promise<void>;
  close(): Promise<void>;
}
export interface OpenCodeOptions {
  db: DatabaseSync;
  runtime: () => Promise<OpenCodeRuntime>;
  check?: () => Promise<{ available: boolean; note: string | null }>;
  now?: () => number;
  directories?: (project: string) => Promise<string[]>;
}

/** SDK types stop at this driver boundary; no native credentials or configuration are returned to Odin. */
export function createOpenCodeHarness(options: OpenCodeOptions): Harness {
  let runtime: Promise<OpenCodeRuntime> | undefined;
  const now = options.now ?? Date.now;
  const live = new Set<SessionHandle>();
  const getRuntime = () => runtime ??= options.runtime().catch(error => { runtime = undefined; throw error; });
  const db = options.db;
  function bind(local: string, native: string): void {
    db.prepare("INSERT OR REPLACE INTO harness_session_links (harness, session_id, native_id) VALUES ('opencode', ?, ?)").run(local, native);
  }
  function nativeId(local: string): string {
    const link = db.prepare("SELECT native_id FROM harness_session_links WHERE harness = 'opencode' AND session_id = ?").get(local) as { native_id: string } | undefined;
    if (link) return link.native_id;
    if (local.startsWith("opencode:")) return local.slice("opencode:".length);
    throw new Error("OpenCode session mapping is unavailable; this session has been preserved.");
  }
  function localId(native: string): string {
    const link = db.prepare("SELECT session_id FROM harness_session_links WHERE harness = 'opencode' AND native_id = ?").get(native) as { session_id: string } | undefined;
    if (link) return link.session_id;
    const local = `opencode:${native}`;
    bind(local, native);
    return local;
  }
  async function history(native: string): Promise<SessionMessageInfo[]> {
    const { client } = await getRuntime();
    const messages: SessionMessageInfo[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    const limit = 100;
    for (;;) {
      // A cursor already carries order and direction. OpenCode rejects the pair with
      // "Cursor cannot be combined with order", and it returns a next cursor for any non-empty page.
      const page = await client.message.list(cursor
        ? { sessionID: native, limit, cursor }
        : { sessionID: native, order: "asc", limit });
      messages.push(...page.data);
      if (page.data.length < limit) break;
      const next = page.cursor.next ?? undefined;
      if (!next) break;
      if (seen.has(next)) throw new Error("OpenCode returned a repeated history cursor");
      seen.add(next);
      cursor = next;
    }
    return messages;
  }
  async function info(native: string): Promise<HarnessSessionInfo> {
    const { client } = await getRuntime();
    const session = await client.session.get({ sessionID: native });
    const messages = await history(native);
    return sessionInfo(session, messages.find(message => message.type === "user")?.text ?? null);
  }
  function sessionInfo(session: SessionInfo, firstPrompt: string | null): HarnessSessionInfo {
    return { sessionId: localId(session.id), title: session.title ?? "OpenCode session", firstPrompt, cwd: session.location.directory, gitBranch: null, createdAt: timestamp(session.time.created), updatedAt: timestamp(session.time.updated)! };
  }
  async function state(native: string): Promise<NativeSessionState> {
    const { client } = await getRuntime();
    const [session, context, diff] = await Promise.all([client.session.get({ sessionID: native }), client.session.context({ sessionID: native }), client.session.diff({ sessionID: native })]);
    return { revert: session.revert ? { messageId: session.revert.messageID, ...(session.revert.partID ? { partId: session.revert.partID } : {}) } : null,
      context: context.flatMap(messageEntries), diff: diff.map(file => ({ path: file.file, patch: file.patch, added: file.additions, removed: file.deletions, status: file.status })) };
  }
  async function taskSnapshots(native: string, messages: SessionMessageInfo[]): Promise<TaskActivity[]> {
    const { client } = await getRuntime();
    const jobs = await client.experimental.job.list({ sessionID: native, descendants: false });
    const links = new Map<string, string>();
    for (const message of messages) if (message.type === "assistant") for (const part of message.content) {
      if (part.type !== "tool" || part.name !== "subagent" || part.state.status === "streaming") continue;
      const metadata = "metadata" in part.state ? part.state.metadata : undefined;
      if (typeof metadata?.sessionID === "string") links.set(metadata.sessionID, part.id);
    }
    return jobs.filter(job => job.kind === "subagent" || job.kind === "shell").map(job => ({
      taskId: job.id, runId: String(job.time.started), kind: job.kind === "subagent" ? "agent" : "command",
      label: job.kind === "subagent" ? job.description : job.command,
      state: job.status === "error" ? "failed" : job.status === "cancelled" ? "stopped" : job.status,
      toolUseId: job.kind === "subagent" ? links.get(job.childSessionID) ?? null : null,
      parentToolUseId: null, childSessionId: job.kind === "subagent" ? job.childSessionID : null,
      startedAt: timestamp(job.time.started), completedAt: timestamp(job.time.completed), observedAt: new Date(now()).toISOString(),
    }));
  }
  async function transcript(native: string): Promise<TranscriptEntry[]> {
    const messages = await history(native);
    const tasks = await taskSnapshots(native, messages);
    return [...messages.flatMap(messageEntries), ...tasks.map((task): TranscriptEntry => ({ kind: "task", id: taskKey(task), task, at: task.startedAt, parentToolUseId: task.parentToolUseId }))];
  }
  async function catalog(cwd: string): Promise<NativeCatalog> {
    const host = await getRuntime();
    await host.ready?.(cwd);
    const { client } = host;
    const location = { directory: cwd };
    const [agents, commands, skills, providers, mcp, plugins] = await Promise.all([
      client.agent.list({ location }), client.command.list({ location }), client.skill.list({ location }),
      client.provider.list({ location }), client.mcp.list({ location }), client.plugin.list({ location }),
    ]);
    return {
      agents: agents.data.map(agent => ({ name: agent.id, description: agent.description ?? agent.name, mode: agent.mode, hidden: agent.hidden })),
      commands: commands.data.map(command => ({ name: command.name, description: command.description ?? "" })),
      skills: skills.data.map(skill => ({ name: skill.name, description: skill.description ?? "" })),
      providers: providers.data.map(provider => ({ id: provider.id, name: provider.name, enabled: provider.activation !== "disabled" })),
      mcp: mcp.data.map(server => ({ name: server.name, status: server.status.status })),
      plugins: plugins.data.map(plugin => plugin.source.type === "package" ? plugin.source.target : plugin.id ?? (plugin.source.type === "local" ? plugin.source.path : plugin.source.type)),
      updatablePlugins: plugins.data.flatMap(plugin => plugin.source.type === "package" ? [plugin.source.target] : []),
    };
  }
  async function modelRef(value: string, variant?: string | null): Promise<ModelRef> {
    const { client } = await getRuntime();
    const models = (await client.model.list({ types: ["chat"] })).data;
    const model = models.find(model => modelValue({ providerID: model.providerID, id: model.id }) === value);
    if (!model || !model.enabled) throw new Error("OpenCode does not offer the selected model");
    if (variant && !model.variants.some(item => item.id === variant)) throw new Error("OpenCode does not offer the selected model variant");
    return { id: model.id, providerID: model.providerID, ...(variant ? { variant } : {}) };
  }

  function start(opts: StartOptions): SessionHandle {
    const sessionId = opts.sessionId ?? opts.resume ?? randomUUID();
    const events = new EventQueue<HarnessEvent>();
    const abort = new AbortController();
    const pending = new Map<string, PermissionRequest>();
    const seenEvents = new Set<string>();
    const stepModels = new Map<string, string>();
    const accountedSteps = new Set<string>();
    const tools = new Map<string, SessionMessageAssistantTool>();
    const emittedEntries = new Map<string, string>();
    let native = "";
    let closed = false;
    let busy = false;
    let initialized = false;
    let model = opts.model ?? null;
    let runtimeOptions = opts.runtimeOptions ?? {};
    let started = now();
    let nativeCommands = new Set<string>();
    let projectedSkills: { id: string; name: string; description: string }[] = [];
    let compacting = false;
    let client: OpenCodeClient;
    let ready: Promise<void>;
    const emit = (event: HarnessEvent) => { if (!closed) events.push(event); };
    function entry(value: TranscriptEntry) {
      const serialized = JSON.stringify(value);
      if (emittedEntries.get(value.id) === serialized) return;
      emittedEntries.set(value.id, serialized);
      emit({ type: "entry", entry: value });
    }
    function finishTurn(ok: boolean, error: string | null) {
      if (!busy) return;
      busy = false;
      compacting = false;
      emit({ type: "turn.end", durationMs: Math.max(0, now() - started), ok, error });
      emit({ type: "state", state: "idle" });
    }
    function fail(error: unknown) {
      if (closed) return;
      const message = error instanceof Error ? error.message : "OpenCode operation failed";
      finishTurn(false, message);
      for (const id of pending.keys()) emit({ type: "permission.resolved", requestId: id, behavior: "cancelled" });
      pending.clear();
      emit({ type: "exit", outcome: "failed", error: message });
      closed = true;
      abort.abort();
      events.end();
      live.delete(handle);
    }
    function addPermission(request: PermissionRequest) {
      if (pending.has(request.id)) return;
      pending.set(request.id, request);
      emit({ type: "permission.request", request });
    }
    function addForm(form: FormInfo) {
      addPermission({ id: `form:${form.id}`, sessionId, kind: "question", toolName: "form", toolUseId: null,
        title: form.title, description: null, input: { nativeForm: form }, canAlwaysAllow: false, defaultToDeny: false, createdAt: new Date(now()).toISOString() });
    }
    async function recoverEntries(baseline = false) {
      const messages = await history(native);
      for (const message of messages) {
        for (const value of messageEntries(message)) entry(value);
        if (message.type === "assistant") {
          stepModels.set(message.id, modelValue(message.model));
          for (const part of message.content) if (part.type === "tool") tools.set(part.id, part);
          if (message.tokens && message.time.completed !== undefined && !accountedSteps.has(message.id)) {
            accountedSteps.add(message.id);
            if (!baseline) emit({ type: "usage", model: modelValue(message.model), usage: tokenUsage(message.tokens), cumulative: false, costUsd: message.cost ?? null, contextTokens: message.tokens.input + message.tokens.cache.read + message.tokens.cache.write, contextWindow: null });
          }
        } else if (message.type === "compaction" && message.status === "completed" && message.tokens && !accountedSteps.has(message.id)) {
          accountedSteps.add(message.id);
          if (!baseline) emit({ type: "usage", model: message.model ? modelValue(message.model) : model ?? "unknown", usage: tokenUsage(message.tokens), cumulative: false, costUsd: message.cost ?? null, contextTokens: message.tokens.input + message.tokens.cache.read + message.tokens.cache.write, contextWindow: null });
        }
      }
      for (const task of await taskSnapshots(native, messages)) emit({ type: "task", task });
    }
    async function sync(baseline = false) {
      await recoverEntries(baseline);
      const [permissions, forms, active] = await Promise.all([
        client.permission.list({ sessionID: native }), client.session.form.list({ sessionID: native }), client.session.active(),
      ]);
      const current = new Set([...permissions.map(item => item.id), ...forms.map(item => `form:${item.id}`)]);
      for (const id of pending.keys()) if (!current.has(id)) { pending.delete(id); emit({ type: "permission.resolved", requestId: id, behavior: "cancelled" }); }
      for (const request of permissions) addPermission(permissionRequest(request, sessionId, new Date(now()).toISOString()));
      for (const form of forms) addForm(form);
      if (active[native]) { if (!busy) started = now(); busy = true; }
      // A lost execution boundary is uncertain. Never acknowledge a durable outbox message as successful.
      else if (busy) finishTurn(false, "OpenCode execution ended while the event stream was disconnected; inspect the recovered history before retrying.");
      emit({ type: "state", state: pending.size ? "waiting" : busy ? "running" : "idle" });
    }
    async function consume(event: OpenCodeEvent) {
      if (event.type === "server.connected") return;
      if (event.type === "location.shutdown") {
        emit({ type: "notice", level: "info", text: "OpenCode reloaded its native configuration." });
        return;
      }
      if (!("sessionID" in event.data) || event.data.sessionID !== native) {
        if (event.type === "form.created" && event.data.form.sessionID === native) addForm(event.data.form);
        if (event.type.startsWith("session.execution.") && "sessionID" in event.data && typeof event.data.sessionID === "string") {
          const child = await client.session.get({ sessionID: event.data.sessionID }).catch(error => { if (isNotFound(error)) return null; throw error; });
          if (child?.parentID === native) for (const task of await taskSnapshots(native, await history(native))) emit({ type: "task", task });
        }
        return;
      }
      if (seenEvents.has(event.id)) return;
      seenEvents.add(event.id);
      const at = timestamp("created" in event ? event.created : now());
      switch (event.type) {
        case "session.execution.started": started = event.created; busy = true; emit({ type: "state", state: "running" }); break;
        case "session.model.selected": model = modelValue(event.data.model); runtimeOptions.variant = event.data.model.variant ?? null; emit({ type: "model", model }); break;
        case "session.execution.succeeded": await recoverEntries(); finishTurn(true, null); break;
        case "session.execution.failed": await recoverEntries(); finishTurn(false, event.data.error.message); break;
        case "session.execution.interrupted": await recoverEntries(); finishTurn(false, "Interrupted"); break;
        case "session.inbox.delivered": await recoverEntries(); break;
        case "session.step.started": stepModels.set(event.data.assistantMessageID, modelValue(event.data.model)); if (!model) { model = modelValue(event.data.model); emit({ type: "model", model }); } break;
        case "session.text.delta": case "session.reasoning.delta": emit({ type: "delta", entryId: contentId(event.data.assistantMessageID, event.data.ordinal), kind: event.type === "session.text.delta" ? "assistant" : "thinking", text: event.data.delta, parentToolUseId: null }); break;
        case "session.text.ended": entry({ kind: "assistant", id: contentId(event.data.assistantMessageID, event.data.ordinal), text: event.data.text, model: stepModels.get(event.data.assistantMessageID) ?? model, at, parentToolUseId: null }); break;
        case "session.reasoning.ended": entry({ kind: "thinking", id: contentId(event.data.assistantMessageID, event.data.ordinal), text: event.data.text, at, parentToolUseId: null }); break;
        case "session.tool.input.started": tools.set(event.data.id, { type: "tool", id: event.data.id, name: event.data.name, state: { status: "streaming", input: "" }, time: { created: event.created } }); break;
        case "session.tool.called": {
          const tool = tools.get(event.data.id);
          if (tool) { tool.state = { status: "running", input: event.data.input, metadata: {} }; for (const value of messageEntries({ id: event.data.assistantMessageID, type: "assistant", time: { created: event.created }, agent: "", model: { providerID: "", id: "" }, content: [tool] })) entry(value); }
          break;
        }
        case "session.tool.success": case "session.tool.failed": {
          const tool = tools.get(event.data.id);
          const text = (event.data.content ?? []).map(item => item.type === "text" ? item.text : `[file: ${item.name ?? item.mime}]`).join("\n");
          const output = result(event.type === "session.tool.failed" ? `${event.data.error.message}${text ? `\n${text}` : ""}` : text, event.type === "session.tool.success");
          emit({ type: "tool.result", toolUseId: event.data.id, result: output });
          if (tool) tool.time.completed = event.created;
          if (tool?.name === "subagent") for (const task of await taskSnapshots(native, await history(native))) emit({ type: "task", task });
          break;
        }
        case "session.step.ended": case "session.step.failed": {
          if (event.data.tokens && !accountedSteps.has(event.data.assistantMessageID)) {
            accountedSteps.add(event.data.assistantMessageID);
            emit({ type: "usage", model: stepModels.get(event.data.assistantMessageID) ?? model ?? "unknown", usage: tokenUsage(event.data.tokens), cumulative: false, costUsd: event.data.cost ?? null, contextTokens: event.data.tokens.input + event.data.tokens.cache.read + event.data.tokens.cache.write, contextWindow: null });
          }
          break;
        }
        case "permission.asked": addPermission(permissionRequest(event.data, sessionId, at!)); emit({ type: "state", state: "waiting" }); break;
        case "permission.replied": pending.delete(event.data.requestID); emit({ type: "permission.resolved", requestId: event.data.requestID, behavior: event.data.reply === "reject" ? "deny" : "allow" }); break;
        case "form.replied": case "form.cancelled": pending.delete(`form:${event.data.id}`); emit({ type: "permission.resolved", requestId: `form:${event.data.id}`, behavior: event.type === "form.replied" ? "allow" : "cancelled" }); break;
        case "session.shell.ended": await recoverEntries(); finishTurn(event.data.shell.status === "exited" && event.data.shell.exit === 0, event.data.shell.status === "exited" && event.data.shell.exit === 0 ? null : `Shell ${event.data.shell.status} (${event.data.shell.exit ?? "unknown exit"})`); break;
        case "session.compaction.ended": await recoverEntries(); if (compacting) finishTurn(true, null); break;
        case "session.compaction.failed": await recoverEntries(); compacting = false; finishTurn(false, event.data.error.message); break;
      }
    }
    async function applyRuntime(value: RuntimeOptions) {
      let agent: string | undefined;
      if (value.agent !== undefined) {
        const agents = (await client.agent.list({ location: { directory: opts.cwd } })).data;
        // Native Agent.list deliberately orders the configured selectable default first (core/src/agent.ts).
        const selected = value.agent === null ? agents.find(item => item.mode !== "subagent" && !item.hidden) : agents.find(item => item.id === value.agent && item.mode !== "subagent");
        if (!selected) throw new Error(value.agent === null ? "OpenCode has no selectable default primary agent" : "OpenCode does not offer the selected primary agent");
        agent = selected.id;
      }
      let selectedModel: ModelRef | undefined;
      if (value.variant !== undefined) {
        let current = model;
        if (!current) {
          const selected = (await client.session.get({ sessionID: native })).model ?? (await client.model.default({ location: { directory: opts.cwd } })).data;
          if (selected) current = modelValue(selected);
        }
        if (current) selectedModel = await modelRef(current, value.variant);
        else if (value.variant) throw new Error("Choose an OpenCode model before selecting a variant");
      }
      if (selectedModel) { await client.session.switchModel({ sessionID: native, model: selectedModel }); model = modelValue(selectedModel); }
      if (agent) await client.session.switchAgent({ sessionID: native, agent });
      if (value.permissionRules) await client.session.update({ sessionID: native, permissions: value.permissionRules });
      runtimeOptions = value;
    }
    async function send(message: UserMessage) {
      await ready;
      if (closed) return;
      busy = true;
      started = now();
      emit({ type: "state", state: "running" });
      const files = message.attachments?.map(file => ({ uri: `data:${file.mediaType};base64,${file.mediaType.startsWith("image/") ? file.data : Buffer.from(file.data).toString("base64")}`, name: file.name }));
      const slash = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(message.text);
      if (slash?.[1] === "compact" && !slash[2] && !files?.length) { compacting = true; await client.session.compact({ sessionID: native, delivery: "queue" }); return; }
      if (slash?.[1] && nativeCommands.has(slash[1])) { await client.session.command({ sessionID: native, name: slash[1], text: slash[2] ?? "", files, delivery: "queue" }); return; }
      let text = message.text;
      let skills: { id: string }[] | undefined;
      if (slash?.[1]) {
        const available = (await client.skill.list({ location: { directory: opts.cwd } })).data;
        const skill = projectedSkills.find(skill => skill.name === slash[1]) ?? available.find(skill => skill.name === slash[1]);
        if (skill) { skills = [{ id: skill.id }]; text = slash[2] ?? ""; }
      }
      await client.session.prompt({ sessionID: native, text, id: message.clientId, files, skills, delivery: "queue", resume: true });
    }
    const handle: SessionHandle = {
      sessionId, events,
      send(message) { if (closed || busy) throw new Error(closed ? "OpenCode session is closed" : "OpenCode is still processing a turn"); busy = true; void send(message).catch(fail); },
      answer(id, answer) {
        if (!pending.has(id) || closed) return;
        void ready.then(async () => {
          if (id.startsWith("form:")) {
            const formID = id.slice(5);
            if (answer.behavior === "deny") await client.session.form.cancel({ sessionID: native, formID, message: answer.message });
            else await client.session.form.reply({ sessionID: native, formID, answer: answer.updatedInput as Record<string, string | number | boolean | string[]> ?? {} });
          } else {
            if (answer.behavior === "allow" && answer.scope !== "once" && answer.scope !== "project") throw new Error("OpenCode supports once or project permission decisions only");
            await client.permission.reply({ sessionID: native, requestID: id, decision: answer.behavior === "deny" ? "reject" : answer.scope === "project" ? "always" : "once", ...(answer.behavior === "deny" && answer.message ? { message: answer.message } : {}) });
          }
          if (answer.behavior === "deny" && answer.interrupt) await handle.interrupt();
        }).catch(fail);
      },
      async interrupt() { await ready; if (!closed) await client.session.interrupt({ sessionID: native, resume: false }); },
      async setModel(value) { await ready; await client.session.switchModel({ sessionID: native, model: await modelRef(value, runtimeOptions.variant) }); model = value; emit({ type: "model", model: value }); },
      async setPermissionMode(mode) { if (mode !== "default") throw new Error("Use OpenCode's native permission rules"); },
      async setRuntimeOptions(value) { await ready; await applyRuntime(value); },
      async nativeAction(action) {
        await ready;
        if (busy) throw new Error("Wait for OpenCode to finish before running this action");
        try { switch (action.type) {
          case "compact": compacting = true; busy = true; started = now(); emit({ type: "state", state: "running" }); await client.session.compact({ sessionID: native }); break;
          case "revert": await client.session.revert.stage({ sessionID: native, messageID: action.messageId, files: action.files }); break;
          case "unrevert": await client.session.revert.clear({ sessionID: native }); break;
          case "commitRevert": await client.session.revert.commit({ sessionID: native }); break;
          case "command": busy = true; started = now(); emit({ type: "state", state: "running" }); await client.session.command({ sessionID: native, name: action.name, text: action.arguments, delivery: "queue" }); break;
          case "shell": busy = true; started = now(); emit({ type: "state", state: "running" }); await client.session.shell({ sessionID: native, command: action.command }); break;
          case "updatePlugins": await client.plugin.update({ location: { directory: opts.cwd }, targets: action.targets }); break;
          case "reload": await client.location.reload(); break;
        }
        return state(native);
        } catch (error) { if (busy) finishTurn(false, error instanceof Error ? error.message : "OpenCode action failed"); throw error; }
      },
      async close() {
        if (closed) return;
        if (initialized) {
          if (busy) await client.session.interrupt({ sessionID: native, resume: false }).catch(() => {});
          for (const id of pending.keys()) {
            if (id.startsWith("form:")) await client.session.form.cancel({ sessionID: native, formID: id.slice(5) }).catch(() => {});
            else await client.permission.reply({ sessionID: native, requestID: id, decision: "reject" }).catch(() => {});
          }
        }
        // Only detach this handle. Runtime ownership belongs to Harness.close(), never to a session.
        for (const id of pending.keys()) emit({ type: "permission.resolved", requestId: id, behavior: "cancelled" });
        pending.clear();
        emit({ type: "exit", outcome: "closed", error: null });
        closed = true; abort.abort(); events.end(); live.delete(handle);
      },
    };
    live.add(handle);
    ready = (async () => {
      const host = await getRuntime();
      client = host.client;
      await host.ready?.(opts.cwd);
      if (closed) return;
      let iterator = client.event.subscribe({ signal: abort.signal })[Symbol.asyncIterator]();
      // Await the connection marker before creating a session or sending any message.
      const first = await iterator.next();
      if (first.done) throw new Error("OpenCode event stream closed during initialization");
      if (closed) return;
      let session: SessionInfo;
      if (opts.resume) session = opts.fork ? await client.session.fork({ sessionID: nativeId(opts.resume) }) : await client.session.get({ sessionID: nativeId(opts.resume) });
      else session = await client.session.create({ location: { directory: opts.cwd }, title: opts.title, agent: runtimeOptions.agent, model: model ? await modelRef(model, runtimeOptions.variant) : undefined, permissions: runtimeOptions.permissionRules });
      native = session.id; bind(sessionId, native);
      if (closed) return;
      model ??= session.model ? modelValue(session.model) : null;
      const directories = opts.additionalDirectories?.length ? `Additional configured working directories:\n${opts.additionalDirectories.join("\n")}\nAccess remains governed by OpenCode's native external_directory, read and edit permissions.` : "";
      await host.prepare(native, { ...opts, instructions: [opts.instructions, directories].filter(Boolean).join("\n\n") });
      await applyRuntime(runtimeOptions);
      if (opts.model && opts.resume) await client.session.switchModel({ sessionID: native, model: await modelRef(opts.model, runtimeOptions.variant) });
      const nativeCatalog = await catalog(opts.cwd);
      const projected = host.resources?.(native);
      projectedSkills = projected?.skills ?? [];
      const skills = [...new Map([...nativeCatalog.skills, ...projectedSkills].map(skill => [skill.name, skill])).values()];
      nativeCommands = new Set(nativeCatalog.commands.map(command => command.name));
      emit({ type: "init", sessionId, cwd: opts.cwd, model, permissionMode: "default", tools: [], agents: [...new Set([...nativeCatalog.agents.map(agent => agent.name), ...(projected?.agents.map(agent => agent.name) ?? [])])], slashCommands: [
        ...nativeCatalog.commands.map(command => ({ ...command, source: "custom" as const, argumentHint: "" })),
        ...skills.filter(skill => !nativeCommands.has(skill.name)).map(skill => ({ name: skill.name, description: skill.description, source: projectedSkills.some(projected => projected.name === skill.name) ? "library" as const : "custom" as const, argumentHint: "" })),
        { name: "compact", description: "Compact the native OpenCode conversation", source: "builtin", argumentHint: "" },
      ] });
      initialized = true;
      await sync(true);
      void (async () => {
        let attempts = 0;
        while (!closed) {
          try {
            for (;;) { const next = await iterator.next(); if (next.done) throw new Error("OpenCode event stream disconnected"); await consume(next.value); if (closed) return; }
          } catch (error) {
            if (closed) return;
            if (++attempts > 3) { fail(error); return; }
            emit({ type: "notice", level: "warning", text: "OpenCode event connection interrupted; recovering native history." });
            iterator = client.event.subscribe({ signal: abort.signal })[Symbol.asyncIterator]();
            const marker = await iterator.next();
            if (marker.done) continue;
            await sync();
          }
        }
      })().catch(fail);
    })();
    void ready.then(() => { if (opts.prompt && !closed) { if (busy) throw new Error("The native OpenCode session is already running"); void send(opts.prompt).catch(fail); } }).catch(fail);
    return handle;
  }

  return {
    id: "opencode", name: "OpenCode",
    capabilities: { permissionModes: ["default"], permissionScopes: ["once", "project"], attachments: true, additionalDirectories: true, instructions: true, settingsOnNextTurn: true,
      native: { agents: true, variants: true, permissionRules: true, actions: ["compact", "revert", "unrevert", "commitRevert", "command", "shell", "updatePlugins", "reload"] } },
    check: options.check ?? (async () => ({ available: true, note: "Local OpenCode v2 SDK; provider authentication stays with OpenCode." })),
    start,
    async close() { await Promise.all([...live].map(handle => handle.close())); if (runtime) await (await runtime).close(); runtime = undefined; },
    nativeCatalog: catalog,
    async nativeState(id) { return state(nativeId(id)); },
    async list(project) {
      const { client } = await getRuntime();
      const sessions = new Map<string, SessionInfo>();
      const limit = 100;
      for (const directory of await (options.directories ?? projectDirectories)(project)) {
        let cursor: string | undefined;
        const seen = new Set<string>();
        for (;;) {
          // A cursor already carries the filter and order, so only the first page names them.
          const page = await client.session.list(cursor
            ? { directory, limit, cursor }
            : { directory, parentID: "null", order: "desc", limit });
          for (const session of page.data) sessions.set(session.id, session);
          if (page.data.length < limit) break;
          const next = page.cursor.next ?? undefined;
          if (!next) break;
          if (seen.has(next)) throw new Error("OpenCode returned a repeated session cursor");
          seen.add(next);
          cursor = next;
        }
      }
      return [...sessions.values()].map(session => sessionInfo(session, null)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async info(id) { try { return await info(nativeId(id)); } catch (error) { if (isNotFound(error)) return null; throw error; } },
    async messages(id) { return transcript(nativeId(id)); },
    async taskMessages(id, task) {
      if (!task.childSessionId) return { status: "unavailable", reason: "No native child session was reported" };
      const { client } = await getRuntime();
      const child = await client.session.get({ sessionID: task.childSessionId });
      if (child.parentID !== nativeId(id)) return { status: "unavailable", reason: "The child does not belong to this parent session" };
      return { status: "available", transcript: await transcript(child.id) };
    },
    async measurements(id) {
      const measurements: HarnessMeasurement[] = [];
      for (const message of await history(nativeId(id))) {
        const at = timestamp(message.time.created)!;
        if (message.type === "assistant") {
          if (message.tokens) measurements.push({ id: `usage:${message.id}`, at, kind: "usage", data: { ...tokenUsage(message.tokens), model: modelValue(message.model), cumulative: false, costUsd: message.cost ?? null, contextTokens: null } });
          for (const part of message.content) if (part.type === "tool" && (part.state.status === "completed" || part.state.status === "error")) measurements.push({ id: `tool:${part.id}`, at: timestamp(part.time.completed ?? part.time.created)!, kind: "tool", data: { name: part.name, ok: part.state.status === "completed" } });
        } else if (message.type === "compaction" && message.status === "completed" && message.tokens) {
          measurements.push({ id: `usage:${message.id}`, at, kind: "usage", data: { ...tokenUsage(message.tokens), model: message.model ? modelValue(message.model) : "unknown", cumulative: false, costUsd: message.cost ?? null, contextTokens: null } });
        } else if (message.type === "idle") measurements.push({ id: `turn:${message.id}`, at, kind: "turn", data: { durationMs: null, ok: message.outcome === "succeeded" } });
      }
      return measurements;
    },
    async rename(id, title) { const { client } = await getRuntime(); await client.session.update({ sessionID: nativeId(id), title }); },
    async fork(id) { const { client } = await getRuntime(); return localId((await client.session.fork({ sessionID: nativeId(id) })).id); },
    async delete(id) {
      const { client } = await getRuntime();
      try {
        await client.session.remove({ sessionID: nativeId(id) });
      } catch (error) {
        // Already removed outside Odin. Keep real failures visible and preserve the Odin record for retry.
        if (!isNotFound(error)) throw error;
      }
      db.prepare("DELETE FROM harness_session_links WHERE harness = 'opencode' AND session_id = ?").run(id);
    },
    async models() { const host = await getRuntime(); return (await host.client.model.list({ types: ["chat"] })).data.filter(model => model.enabled).map(model => ({ value: modelValue({ providerID: model.providerID, id: model.id }), displayName: model.name, description: model.providerID, resolved: model.modelID, variants: model.variants.map(variant => variant.id) })); },
  };
}
function isNotFound(error: unknown): boolean { return typeof error === "object" && error !== null && "status" in error && error.status === 404; }
