import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { OpenCodeClient } from "@opencode/client";
import type { OpenCode } from "@opencode/sdk";
import type { Plugin } from "@opencode/plugin";
import type { StartOptions } from "../types.ts";
import type { OpenCodeRuntime } from "./driver.ts";
import { hostToolSchema } from "../host-schema.ts";
import type { OpenCodeLibrary } from "./library.ts";
import { resolveTool } from "../../tools/resolve.ts";
import { boundHostToolResult } from "../host-result.ts";

export interface RuntimeOptions {
  home: string;
  /** Injectable for isolated tests; production shares the native CLI database and runtime-owned login. */
  databasePath?: string;
  projectLibrary?: (options: StartOptions) => OpenCodeLibrary;
  create?: (options: OpenCode.CreateOptions) => Promise<OpenCode.Interface>;
}

export async function nativeDatabasePath(options: {
  env?: NodeJS.ProcessEnv; home?: string;
  lookup?: () => Promise<string>;
} = {}): Promise<string> {
  const lookup = options.lookup ?? (async () => (await promisify(execFile)(resolveTool("opencode"), ["debug", "paths", "db"], { timeout: 5000, windowsHide: true })).stdout);
  try {
    const path = (await lookup()).trim();
    if (isAbsolute(path)) return path;
  } catch { /* A CLI is optional for the embedded SDK; documented native defaults follow. */ }
  const env = options.env ?? process.env;
  const data = join(env.XDG_DATA_HOME || join(options.home ?? homedir(), ".local", "share"), "opencode");
  const override = env.OPENCODE_DB?.trim();
  if (override === ":memory:") return override;
  return override ? (isAbsolute(override) ? override : resolve(data, override)) : join(data, "opencode.db");
}

/** One embedded router and persistent native database; per-session plugins prevent projection leakage. */
export async function createOpenCodeRuntime(options: RuntimeOptions): Promise<OpenCodeRuntime> {
  const prepared = new Map<string, { options: StartOptions; library: OpenCodeLibrary }>();
  const owners = new Map<string, string>();
  const generations = new Map<string, number>();
  const instanceOwners = new Map<string, string>();
  const databasePath = options.databasePath ?? await nativeDatabasePath();
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
  function pluginFor(id: string): Plugin.Plugin {
    return {
      id: "odin-host",
      async setup(context) {
        const get = () => {
          const value = prepared.get(id);
          if (!value) throw new Error("OpenCode session must be prepared by Odin before acquiring host capabilities");
          return value;
        };
        const registrations: { dispose(): Promise<void> }[] = [];
        registrations.push(await context.session.hook("context", input => {
          if (get().library.instructions) input.system.push({ type: "text", text: get().library.instructions });
        }));
        registrations.push(await context.agent.transform(editor => {
          for (const agent of get().library.agents) editor.update(agent.name, entry => {
            entry.name = agent.name as typeof entry.name;
            entry.mode = "subagent";
            entry.description = agent.description;
            entry.system = agent.prompt;
            if (agent.permissionRules) entry.permissions = agent.permissionRules;
          });
        }));
        registrations.push(await context.skill.transform(editor => {
          for (const skill of get().library.skills) editor.add({ ...skill, id: skill.name } as Parameters<typeof editor.add>[0]);
        }));
        registrations.push(await context.mcp.transform(editor => {
          for (const [name, server] of Object.entries(get().library.mcpServers)) {
            if (server.type === "stdio") editor.set(name, { type: "local", command: [server.command, ...(server.args ?? [])], environment: server.env });
            else editor.set(name, { type: "remote", url: server.url, headers: server.headers });
          }
        }));
        registrations.push(await context.tool.transform(editor => {
          for (const tool of get().options.hostTools ?? []) editor.add({
            name: tool.name,
            description: tool.description,
            input: hostToolSchema(tool.params),
            async execute(input, call) {
              if ((owners.get(call.sessionID) ?? call.sessionID) !== id) throw new Error("Host tool session mismatch");
              const handler = get().options.hostTools?.find(candidate => candidate.name === tool.name);
              if (!handler) throw new Error("Host tool is unavailable");
              const result = boundHostToolResult(await handler.handler(input as Record<string, unknown>));
              if (result.isError) throw new Error(result.text);
              return { content: result.content?.length ? [
                { type: "text" as const, text: result.text },
                ...result.content.map(block => block.type === "image"
                  ? { type: "file" as const, uri: `data:${block.mimeType};base64,${block.data}`, mime: block.mimeType }
                  : { type: "text" as const, text: block.text }),
              ] : result.text };
            },
          });
        }));
        return async () => { await Promise.all(registrations.map(registration => registration.dispose())); };
      },
    };
  }
  const create = options.create ?? (await import("@opencode/sdk")).OpenCode.create;
  const host = await create({
    database: { path: databasePath },
    instances: {
      key: (session: { id: string; parentID?: string }) => {
        const owner = prepared.has(session.id) ? session.id : session.parentID ? owners.get(session.parentID) ?? session.parentID : session.id;
        owners.set(session.id, owner);
        if (!prepared.has(owner)) return "native:" + session.id;
        const key = `odin:${owner}:${generations.get(owner) ?? 0}`;
        instanceOwners.set(key, owner);
        return key;
      },
      configure: (key: string) => ({ plugins: instanceOwners.has(key) ? [pluginFor(instanceOwners.get(key)!)] : [] }),
    },
  });
  return {
    client: host as unknown as OpenCodeClient,
    resources(sessionId: string) {
      const library = prepared.get(sessionId)?.library;
      return { agents: library?.agents.map(({ name, description }) => ({ name, description })) ?? [], skills: library?.skills.map(({ name, description }) => ({ id: name, name, description })) ?? [] };
    },
    async ready(cwd: string) {
      const deadline = Date.now() + 5000;
      do {
        const agents = await host.agent.list({ location: { directory: cwd } });
        if (agents.data.some((agent: { mode: string; hidden: boolean }) => agent.mode !== "subagent" && !agent.hidden)) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      } while (Date.now() < deadline);
      throw new Error("OpenCode native plugins did not initialize a primary agent; check native plugin configuration");
    },
    async prepare(sessionId, start) {
      const library = options.projectLibrary?.(start) ?? { instructions: start.instructions ?? "", agents: [], skills: [], mcpServers: { ...start.mcpServers } };
      prepared.set(sessionId, { options: start, library });
      generations.set(sessionId, (generations.get(sessionId) ?? 0) + 1);
      if (library.permissionRules && start.runtimeOptions?.permissionRules === undefined) await host.session.update({ sessionID: sessionId, permissions: library.permissionRules });
    },
    close: () => host.close(),
  };
}
