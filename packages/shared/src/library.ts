// The library: reusable assets under <ODIN_HOME>/library/, one directory per kind. docs/contracts.md#library.
// Hashing itself lives in core (node:crypto); this file holds the rules both sides need.
import type { AssetKind } from "./api.ts";

export const ASSET_KINDS: AssetKind[] = ["instruction", "skill", "agent", "mcp", "settings"];
export const ASSET_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Layout under the library root. `file` kinds are one file `<dir>/<id><ext>`; `folder` kinds are `<dir>/<id>/` with
 * an entry file (a skill's SKILL.md) plus any others.
 */
export const LIBRARY_LAYOUT: Record<AssetKind, { dir: string; shape: "file" | "folder"; entry: string }> = {
  instruction: { dir: "instructions", shape: "folder", entry: "AGENTS.md" },
  agent: { dir: "agents", shape: "file", entry: ".md" },
  skill: { dir: "skills", shape: "folder", entry: "SKILL.md" },
  command: { dir: "commands", shape: "file", entry: ".md" },
  prompt: { dir: "prompts", shape: "file", entry: ".md" },
  template: { dir: "templates", shape: "file", entry: ".json" },
  mcp: { dir: "mcp", shape: "file", entry: ".json" },
  settings: { dir: "settings", shape: "file", entry: ".json" },
};

/**
 * Where an installable kind goes in a project. copy: the asset's files land at `<target>/<id><ext>` or
 * `<target>/<id>/…`. merge: the asset is merged into one JSON file under a key Odin owns (mcp: `mcpServers.<id>`;
 * settings: permission rules appended and hooks added, remembered so they can be removed or diffed).
 */
export const INSTALL_TARGETS: Partial<Record<AssetKind, { mode: "copy" | "merge"; target: string }>> = {
  instruction: { mode: "merge", target: "AGENTS.md" },
  agent: { mode: "copy", target: ".claude/agents" },
  skill: { mode: "copy", target: ".claude/skills" },
  mcp: { mode: "merge", target: ".mcp.json" },
  settings: { mode: "merge", target: ".claude/settings.json" },
};

export function isInstallable(kind: AssetKind): boolean {
  return kind in INSTALL_TARGETS;
}

/** Historical session attribution and legacy template parsing only; new sessions always use the default agent. */
export const LIBRARY_AGENT_PREFIX = "library:";

export function libraryAgentId(agent: string | null | undefined): string | null {
  return agent && agent.startsWith(LIBRARY_AGENT_PREFIX) ? agent.slice(LIBRARY_AGENT_PREFIX.length) : null;
}

/** Content normalisation before hashing: CRLF → LF, trailing whitespace per line trimmed, one final newline. */
export function normaliseContent(text: string): string {
  return text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/\s+$/, "")).join("\n").replace(/\n*$/, "\n");
}

/** `{{name}}` variables in a prompt, in order of first use. Names: letters, digits, `_`, `-`, `.`. */
export function promptVariables(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) if (!out.includes(m[1]!)) out.push(m[1]!);
  return out;
}

/** Fills `{{name}}`; unknown names are left as written so the user sees what's missing. */
export function fillPrompt(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (all, name: string) => (name in values ? values[name]! : all));
}

/** Built-in variables a session start fills when the caller doesn't: project and branch. */
export const BUILTIN_PROMPT_VARIABLES = ["project", "branch"] as const;
