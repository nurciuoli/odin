// Where Odin finds the external tools it runs (claude, codex, grok, gh, git). An absolute path set in
// AppSettings.toolPaths wins; otherwise the bare name (or a driver's own PATH search). Read lazily on every call so a
// settings change applies on the next start or check without a restart. docs/desktop.md#finding-the-tools.
import type { DatabaseSync } from "node:sqlite";
import { isAbsolute } from "node:path";
import { TOOL_NAMES, type ToolName } from "@odin/shared/api";

export type ToolPaths = Partial<Record<ToolName, string>>;

let source: (() => ToolPaths) | null = null;

/** Installs where overrides come from (the settings service at boot). Null clears it (tests, app close). */
export function setToolPathSource(fn: (() => ToolPaths) | null): void {
  source = fn;
}

export function getToolPathSource(): (() => ToolPaths) | null {
  return source;
}

/** The configured override for a tool, or null when none is set. */
export function toolOverride(name: ToolName): string | null {
  let paths: ToolPaths = {};
  try {
    paths = source?.() ?? {};
  } catch {
    // A broken settings read means no override, not a failure to run the tool.
  }
  const p = paths[name];
  return typeof p === "string" && p.trim() ? p.trim() : null;
}

/** The override if set, else the bare name for a PATH lookup. */
export function resolveTool(name: ToolName): string {
  return toolOverride(name) ?? name;
}

export function gitBinary(): string {
  return resolveTool("git");
}

/** Reads toolPaths straight from the app_settings row (for boot code that runs before services exist). */
export function readToolPaths(db: DatabaseSync): ToolPaths {
  try {
    const row = db.prepare("SELECT value FROM app_settings WHERE key = 'toolPaths'").get() as { value: string } | undefined;
    if (!row) return {};
    const parsed = JSON.parse(row.value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: ToolPaths = {};
    for (const [k, v] of Object.entries(parsed)) {
      if ((TOOL_NAMES as readonly string[]).includes(k) && typeof v === "string" && isAbsolute(v.trim())) out[k as ToolName] = v.trim();
    }
    return out;
  } catch {
    return {};
  }
}
