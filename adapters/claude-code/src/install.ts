// Installs / removes Odin's Claude Code hooks in <project>/.claude/settings.local.json (not committed, so other
// machines are untouched). Existing hooks and keys are kept; Odin's entries are recognised by their command
// naming odin-hook or the pre-rename minerva-hook, so removal takes only them, even if the repo has moved.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SETTINGS_RELATIVE_PATH = ".claude/settings.local.json";
export const HOOK_EVENTS = ["SessionStart", "PostToolUse", "PostToolUseFailure", "SubagentStop", "Stop", "SessionEnd"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];
/** The hook script next to this file; core passes it to installHooks. */
export const HOOK_SCRIPT_PATH = join(import.meta.dirname, "odin-hook.ts");

/** Matches odin-hook and the pre-rename minerva-hook, as .ts, .js, or .cmd, so older installs are replaced. */
const MARKER = /(?:odin|minerva)-hook\.(?:ts|js|cmd)\b/;
/** Seconds Claude Code waits for the hook; the script itself gives up after 2s. */
const HOOK_TIMEOUT_S = 5;

type Json = Record<string, any>;

export function settingsPath(projectPath: string): string {
  return join(projectPath, ".claude", "settings.local.json");
}

function isRecord(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Missing file → {}. A file that isn't a JSON object throws, so an install never clobbers it. */
function readSettings(projectPath: string): Json {
  const file = settingsPath(projectPath);
  if (!existsSync(file)) return {};
  const raw = readFileSync(file, "utf8");
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${SETTINGS_RELATIVE_PATH} is not valid JSON`);
  }
  if (!isRecord(parsed)) throw new Error(`${SETTINGS_RELATIVE_PATH} is not a JSON object`);
  return parsed;
}

function writeSettings(projectPath: string, settings: Json): void {
  const file = settingsPath(projectPath);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
  renameSync(tmp, file);
}

const isOdinHook = (h: unknown): boolean => isRecord(h) && typeof h.command === "string" && MARKER.test(h.command);

/** Drops Odin's hooks from one event's groups; groups left empty go too. */
function strip(groups: unknown): unknown[] {
  if (!Array.isArray(groups)) return [];
  const out: unknown[] = [];
  for (const g of groups) {
    if (!isRecord(g) || !Array.isArray(g.hooks)) {
      out.push(g);
      continue;
    }
    const hooks = g.hooks.filter((h) => !isOdinHook(h));
    if (hooks.length === g.hooks.length) out.push(g);
    else if (hooks.length > 0) out.push({ ...g, hooks });
  }
  return out;
}

const quote = (p: string) => `"${p.replace(/(["\\$`])/g, "\\$1")}"`;

/** A .cmd wrapper (packaged Windows app) runs its own node; a .ts/.js script runs with node. */
export function hookCommand(hookScriptPath: string, event: string): string {
  return /\.cmd$/i.test(hookScriptPath) ? `${quote(hookScriptPath)} ${event}` : `node ${quote(hookScriptPath)} ${event}`;
}

/** Adds Odin's hooks (replacing any earlier Odin entries) and keeps everything else in the file. */
export function installHooks(projectPath: string, hookScriptPath: string): void {
  const settings = readSettings(projectPath);
  if (settings.hooks !== undefined && !isRecord(settings.hooks)) throw new Error(`${SETTINGS_RELATIVE_PATH} has a "hooks" value that is not an object`);
  const hooks: Json = { ...(settings.hooks ?? {}) };
  for (const event of HOOK_EVENTS) {
    const kept = hooks[event] === undefined ? [] : Array.isArray(hooks[event]) ? strip(hooks[event]) : null;
    if (kept === null) throw new Error(`${SETTINGS_RELATIVE_PATH} has a "hooks.${event}" value that is not a list`);
    const entry = { type: "command", command: hookCommand(hookScriptPath, event), timeout: HOOK_TIMEOUT_S };
    hooks[event] = [...kept, event === "PostToolUse" || event === "PostToolUseFailure" ? { matcher: "*", hooks: [entry] } : { hooks: [entry] }];
  }
  writeSettings(projectPath, { ...settings, hooks });
}

/** Removes only Odin's hooks. A settings file with nothing else left is deleted. */
export function removeHooks(projectPath: string): void {
  if (!existsSync(settingsPath(projectPath))) return;
  const settings = readSettings(projectPath);
  if (!isRecord(settings.hooks)) return;
  const hooks: Json = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const kept = Array.isArray(groups) ? strip(groups) : groups;
    if (!Array.isArray(kept) || kept.length > 0) hooks[event] = kept;
  }
  const { hooks: _old, ...rest } = settings;
  const next = Object.keys(hooks).length > 0 ? { ...rest, hooks } : rest;
  if (Object.keys(next).length === 0) rmSync(settingsPath(projectPath), { force: true });
  else writeSettings(projectPath, next);
}

/** True when every Odin hook is present. Unreadable settings count as not installed. */
export function hooksInstalled(projectPath: string): boolean {
  let settings: Json;
  try {
    settings = readSettings(projectPath);
  } catch {
    return false;
  }
  const hooks = settings.hooks;
  if (!isRecord(hooks)) return false;
  return HOOK_EVENTS.every((event) => {
    const groups = hooks[event];
    return Array.isArray(groups) && groups.some((g) => isRecord(g) && Array.isArray(g.hooks) && g.hooks.some(isOdinHook));
  });
}
