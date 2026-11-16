import { randomUUID } from "node:crypto";
import type { PermissionAnswer, Session } from "@odin/shared/api";
import type { PermissionRequest } from "@odin/shared/harness";
import type { HostTool, HostToolResult } from "../harness/types.ts";

/** The same approval boundary protects host execution regardless of native driver behavior. */
export function hostToolApprovals(options: {
  session(id: string): Session | null;
  request(sessionId: string, request: PermissionRequest): void;
  resolved(sessionId: string, requestId: string): void;
  timeoutMs?: number;
}) {
  const pending = new Map<string, { sessionId: string; resolve: (answer: PermissionAnswer) => void }>();
  const allowed = new Map<string, Set<string>>();
  function answer(sessionId: string, requestId: string, answer: PermissionAnswer): boolean {
    const call = pending.get(requestId);
    if (!call || call.sessionId !== sessionId) return false;
    pending.delete(requestId);
    call.resolve(answer);
    return true;
  }
  function cancel(sessionId: string) {
    for (const [id, call] of pending) if (call.sessionId === sessionId) answer(sessionId, id, { behavior: "deny", message: "Session stopped" });
    allowed.delete(sessionId);
  }
  function wrap(sessionId: string, tool: HostTool): HostTool {
    if (!tool.effect) return tool;
    return { ...tool, async handler(input): Promise<HostToolResult> {
      const session = options.session(sessionId);
      if (!session) return { text: "Session is unavailable", isError: true };
      const mode = session.permissionMode ?? "default";
      if (mode === "plan" || mode === "dontAsk") return { text: `Notebook ${tool.effect} denied in ${mode} mode`, isError: true };
      if (mode === "bypassPermissions" || allowed.get(sessionId)?.has(tool.name)) return tool.handler(input);
      const id = `odin-host-${randomUUID()}`;
      let timer: NodeJS.Timeout | undefined;
      const decision = new Promise<PermissionAnswer>(resolve => {
        pending.set(id, { sessionId, resolve });
        timer = setTimeout(() => answer(sessionId, id, { behavior: "deny", message: "Approval expired" }), options.timeoutMs ?? 9 * 60_000);
        timer.unref?.();
      });
      try {
        options.request(sessionId, {
          id, sessionId, kind: "tool", toolName: tool.name, toolUseId: null, input,
          title: `Allow notebook ${tool.effect}?`, description: tool.description,
          canAlwaysAllow: false, defaultToDeny: true, createdAt: new Date().toISOString(),
        });
        const approval = await decision;
        if (approval.behavior !== "allow") return { text: approval.message ?? "Notebook operation denied", isError: true };
        // Once is deliberately the only advertised scope until native policy mappings are proven.
        if (approval.scope !== "once") return { text: "Notebook approval supports this call only", isError: true };
        const latest = options.session(sessionId);
        if (!latest || latest.permissionMode === "plan" || latest.permissionMode === "dontAsk") return { text: "Notebook permission changed before execution", isError: true };
        return await tool.handler(approval.updatedInput ?? input);
      } finally {
        clearTimeout(timer);
        pending.delete(id);
        options.resolved(sessionId, id);
      }
    } };
  }
  return { wrap, answer, cancel };
}
