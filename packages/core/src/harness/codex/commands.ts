// Codex slash commands. Codex's own slash commands live in its terminal UI; app-server exposes the useful ones as
// methods, so the driver offers those as built-ins next to library and native skills. docs/contracts.md#harness.
import type { SlashCommand } from "@odin/shared/harness";

type Wire = Record<string, unknown>;

export const CODEX_BUILTINS: SlashCommand[] = [
  {
    name: "compact",
    description: "Summarize the conversation so far to free up context",
    argumentHint: "",
    source: "builtin",
  },
  {
    name: "review",
    description: "Review code changes",
    argumentHint: "uncommitted | branch <name> | commit <sha> | <instructions>",
    source: "builtin",
    choices: [
      { label: "Uncommitted changes", insert: "uncommitted" },
      { label: "Against a base branch", insert: "branch ", hint: "<branch>" },
      { label: "A commit", insert: "commit ", hint: "<sha>" },
      { label: "Custom instructions", insert: "", hint: "<what to review>" },
    ],
  },
];

/** A message that runs a built-in instead of starting an ordinary turn. */
export type CodexCommand =
  | { kind: "compact" }
  | { kind: "review"; target: Wire };

export function parseCodexCommand(text: string): CodexCommand | null {
  const m = /^\s*\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!m) return null;
  const args = (m[2] ?? "").trim();
  if (m[1] === "compact" && !args) return { kind: "compact" };
  if (m[1] !== "review") return null;
  if (!args || args === "uncommitted") return { kind: "review", target: { type: "uncommittedChanges" } };
  const branch = /^branch\s+(\S+)$/.exec(args);
  if (branch) return { kind: "review", target: { type: "baseBranch", branch: branch[1] } };
  const commit = /^commit\s+([0-9a-fA-F]{4,40})(?:\s+([\s\S]+))?$/.exec(args);
  if (commit) return { kind: "review", target: { type: "commit", sha: commit[1], title: commit[2]?.trim() || null } };
  return { kind: "review", target: { type: "custom", instructions: args } };
}

export interface CodexSkill {
  name: string;
  path: string;
  description?: string;
}

/** `skills/list` → enabled skills (deduplicated by name; the first entry wins). */
export function nativeSkills(result: unknown): CodexSkill[] {
  const data = (result as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out = new Map<string, CodexSkill>();
  for (const entry of data) {
    const skills = (entry as { skills?: unknown } | null)?.skills;
    if (!Array.isArray(skills)) continue;
    for (const s of skills as Wire[]) {
      if (typeof s?.name !== "string" || typeof s.path !== "string" || s.enabled === false || out.has(s.name)) continue;
      const description = typeof s.shortDescription === "string" && s.shortDescription ? s.shortDescription : typeof s.description === "string" ? s.description : "";
      out.set(s.name, { name: s.name, path: s.path, description });
    }
  }
  return [...out.values()];
}

/** Built-ins, then library skills, then native skills; a library skill wins a name clash with a native one. */
export function codexSlashCommands(library: CodexSkill[], native: CodexSkill[]): SlashCommand[] {
  const taken = new Set(CODEX_BUILTINS.map((c) => c.name));
  const out = [...CODEX_BUILTINS];
  for (const [skills, source] of [[library, "library"], [native, "custom"]] as const) {
    for (const s of skills) {
      if (taken.has(s.name)) continue;
      taken.add(s.name);
      out.push({ name: s.name, description: s.description ?? "", argumentHint: "", source });
    }
  }
  return out;
}
