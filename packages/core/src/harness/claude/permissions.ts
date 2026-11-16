// Pure permission mapping: the SDK's canUseTool call → a PermissionRequest, and a PermissionAnswer → the SDK's
// PermissionResult (with scopes as permission updates). docs/contracts.md#harness.
import type { PermissionResult, PermissionUpdate, PermissionUpdateDestination } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionAnswer } from "@odin/shared/api";
import type { PermissionRequest } from "@odin/shared/harness";

/** What the driver keeps from `canUseTool`'s options (the AbortSignal stays in the driver). */
export interface CanUseToolInfo {
  requestId: string;
  toolUseID: string;
  title?: string;
  displayName?: string;
  description?: string;
  suggestions?: PermissionUpdate[];
  defaultToNo?: boolean;
  suppressAlwaysAllowRule?: boolean;
}

export function requestKind(toolName: string): PermissionRequest["kind"] {
  if (toolName === "ExitPlanMode") return "plan";
  if (toolName === "AskUserQuestion") return "question";
  return "tool";
}

export function toPermissionRequest(
  sessionId: string,
  toolName: string,
  input: Record<string, unknown>,
  info: CanUseToolInfo,
  createdAt: string,
): PermissionRequest {
  return {
    id: info.requestId,
    sessionId,
    kind: requestKind(toolName),
    toolName,
    toolUseId: info.toolUseID ?? null,
    input,
    title: info.title ?? null,
    description: info.description ?? null,
    canAlwaysAllow: !info.suppressAlwaysAllowRule,
    defaultToDeny: !!info.defaultToNo,
    createdAt,
  };
}

const DESTINATIONS: Record<"session" | "project" | "local" | "user", PermissionUpdateDestination> = {
  session: "session",
  project: "projectSettings",
  local: "localSettings",
  user: "userSettings",
};

export const DEFAULT_DENY_MESSAGE = "The user denied this.";

/**
 * allow once → updatedInput only; allow with a scope → also `updatedPermissions`: the addRules suggestions re-targeted
 * to the scope (or one rule for the tool when there are none), plus setMode suggestions for scope session.
 */
export function toPermissionResult(
  answer: PermissionAnswer,
  toolName: string,
  input: Record<string, unknown>,
  suggestions: PermissionUpdate[] = [],
): PermissionResult {
  if (answer.behavior === "deny") {
    return {
      behavior: "deny",
      message: answer.message || DEFAULT_DENY_MESSAGE,
      interrupt: !!answer.interrupt,
      decisionClassification: "user_reject",
    };
  }
  const updatedInput = answer.updatedInput ?? input;
  if (answer.scope === "once") return { behavior: "allow", updatedInput, decisionClassification: "user_temporary" };
  const destination = DESTINATIONS[answer.scope];
  const rules: PermissionUpdate[] = suggestions
    .filter((s) => s.type === "addRules")
    .map((s) => ({ ...s, destination }));
  if (!rules.length) rules.push({ type: "addRules", rules: [{ toolName }], behavior: "allow", destination });
  const modes: PermissionUpdate[] = answer.scope === "session" ? suggestions.filter((s) => s.type === "setMode") : [];
  return { behavior: "allow", updatedInput, updatedPermissions: [...rules, ...modes], decisionClassification: "user_permanent" };
}

/** What a withdrawn prompt (interrupt, close, the SDK's abort) resolves to. */
export function cancelledResult(): PermissionResult {
  return { behavior: "deny", message: "The prompt was cancelled.", interrupt: true, decisionClassification: "user_reject" };
}
