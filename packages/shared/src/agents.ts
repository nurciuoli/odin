// Agent files: Claude Code subagent format (`.claude/agents/<id>.md` in a project, `agents/<id>.md` in the library).
//
//   ---
//   name: reviewer
//   description: Reviews diffs for correctness.
//   tools: Read, Grep, Glob
//   model: sonnet            # Claude Code alias or model id, or inherit
//   ---
//   <system prompt>

export const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A `tools:` frontmatter value (comma list or YAML list already split) → names, or null for "all tools". */
export function parseToolList(value: string | string[] | null | undefined): string[] | null {
  if (value === null || value === undefined) return null;
  const parts = (Array.isArray(value) ? value : value.split(",")).map((t) => t.trim()).filter(Boolean);
  return parts.length ? parts : null;
}
