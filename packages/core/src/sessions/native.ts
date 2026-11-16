import type { HarnessCapabilities, NativeSessionAction, RuntimeOptions } from "@odin/shared/api";
import { HttpError } from "../http/util.ts";

const bad = (message: string): never => { throw new HttpError(400, message); };
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) bad("expected an object");
  return value as Record<string, unknown>;
};
const text = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !value.trim()) bad(`${name} must be a non-empty string`);
  return value as string;
};

export function runtimeOptions(value: unknown, capabilities?: HarnessCapabilities): RuntimeOptions {
  const input = object(value);
  if (!capabilities?.native) bad("this runtime does not support native options");
  const out: RuntimeOptions = {};
  for (const key of Object.keys(input)) if (!["agent", "variant", "permissionRules"].includes(key)) bad(`unknown native option ${key}`);
  for (const key of ["agent", "variant"] as const) {
    if (input[key] === undefined) continue;
    if (!capabilities?.native?.[key === "agent" ? "agents" : "variants"]) bad(`this runtime does not support ${key}`);
    out[key] = input[key] === null ? null : text(input[key], key);
  }
  if (input.permissionRules !== undefined) {
    if (!capabilities?.native?.permissionRules) bad("this runtime does not support native permission rules");
    if (!Array.isArray(input.permissionRules) || input.permissionRules.length > 1000) bad("permissionRules must be a list of at most 1000 rules");
    out.permissionRules = (input.permissionRules as unknown[]).map(value => {
      const rule = object(value);
      if (Object.keys(rule).some(k => !["action", "resource", "effect"].includes(k))) bad("unknown permission rule field");
      if (!["allow", "deny", "ask"].includes(rule.effect as string)) bad("unknown permission effect");
      return { action: text(rule.action, "action"), resource: text(rule.resource, "resource"), effect: rule.effect as "allow" | "deny" | "ask" };
    });
  }
  return out;
}

export function nativeAction(value: unknown, capabilities?: HarnessCapabilities): NativeSessionAction {
  const input = object(value);
  const type = text(input.type, "type") as NativeSessionAction["type"];
  if (!capabilities?.native?.actions.includes(type)) bad(`this runtime does not support ${type}`);
  switch (type) {
    case "compact": case "commitRevert": case "unrevert": case "reload": return { type };
    case "updatePlugins":
      if (!Array.isArray(input.targets) || !input.targets.length || input.targets.length > 100) bad("targets must contain 1 to 100 plugin identifiers");
      return { type, targets: (input.targets as unknown[]).map(value => text(value, "target")) };
    case "revert":
      if (input.files !== undefined && typeof input.files !== "boolean") bad("files must be a boolean");
      return { type, messageId: text(input.messageId, "messageId"), ...(input.files === undefined ? {} : { files: input.files as boolean }) };
    case "command": return { type, name: text(input.name, "name"), arguments: typeof input.arguments === "string" ? input.arguments : bad("arguments must be a string") };
    case "shell": return { type, command: text(input.command, "command") };
    default: return bad("unknown native action");
  }
}
