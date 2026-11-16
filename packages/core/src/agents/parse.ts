// Agent files (Claude Code subagent format) → ParsedAgent. Used for a project's .claude/agents/ and for library
// agents. Never throws: a bad field is reported in `error`.
import { parseToolList } from "@odin/shared/agents";
import { fileHash } from "../hash.ts";
import { type FrontmatterValue, parseFrontmatter } from "../frontmatter.ts";

export const AGENTS_DIR = ".claude/agents";
export const MAX_AGENT_BYTES = 256 * 1024;

export interface ParsedAgent {
  id: string;
  name: string;
  description: string;
  model: string | null;
  tools: string[] | null;
  /** The body: the agent's system prompt. */
  prompt: string;
  /** fileHash(`<id>.md`, content): the same version the library computes. */
  version: string;
  error: string | null;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export function parseAgentFile(id: string, content: string, label = `${id}.md`): ParsedAgent {
  const fm = parseFrontmatter(content, label);
  const errors = [...fm.errors];
  const data: Record<string, FrontmatterValue> = fm.data ?? {};
  const str = (key: string): string | undefined => {
    const v = data[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string") {
      errors.push(`${key} must be a single value`);
      return undefined;
    }
    return v.trim() || undefined;
  };
  let tools: string[] | null = null;
  const rawTools = data.tools;
  if (rawTools !== undefined && rawTools !== null) {
    if (typeof rawTools === "string" || Array.isArray(rawTools)) tools = parseToolList(rawTools as string | string[]);
    else errors.push("tools must be a list");
  }
  return {
    id,
    name: oneLine(str("name") ?? id),
    description: oneLine(str("description") ?? ""),
    model: str("model") ?? null,
    tools,
    prompt: fm.body.trim(),
    version: fileHash(`${id}.md`, content),
    error: errors.length ? errors.join("; ") : null,
  };
}
