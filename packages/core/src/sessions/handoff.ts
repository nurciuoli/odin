// The briefing a harness handoff starts the new session with. Pure: built from the source's stored transcript, todos and
// git facts, with no model call. docs/contracts.md#sessions, docs/plans/harness-handoff.md.
import type { Todo } from "@odin/shared/api";
import type { TranscriptEntry } from "@odin/shared/harness";

export const BRIEF_MAX_CHARS = 24 * 1024;
const TASK_MAX = 4096;
const SUMMARY_MAX = 4096;
const RECENT_ENTRIES = 12;
const RECENT_TEXT_MAX = 500;
const FILES_MAX = 40;
const DIFF_STAT_MAX = 2000;
const CUT = "[… cut]";

export interface BriefInput {
  sessionId: string;
  title: string;
  harness: string;
  harnessName: string;
  targetName: string;
  model: string | null;
  firstPrompt: string | null;
  transcript: TranscriptEntry[];
  todos: Todo[];
  branch: string | null;
  /** Paths from `git status`. */
  files: string[];
  /** `git diff --stat` output, may be empty. */
  diffStat: string;
}

export interface Brief {
  text: string;
  truncated: boolean;
}

function cap(text: string, max: number, mark: { cut: boolean }): string {
  const t = text.trim();
  if (t.length <= max) return t;
  mark.cut = true;
  return `${t.slice(0, max).trimEnd()} ${CUT}`;
}

/** One line for a tool call: its name and the most telling argument. */
function toolLine(name: string, input: Record<string, unknown>): string {
  const arg = ["file_path", "path", "command", "pattern", "url", "description", "query"].map((k) => input[k]).find((v) => typeof v === "string") as string | undefined;
  const short = arg ? arg.replace(/\s+/g, " ").slice(0, 120) : "";
  return short ? `${name} ${short}` : name;
}

function fence(text: string): string {
  return "```\n" + text.replace(/```/g, "'''") + "\n```";
}

export function buildBrief(input: BriefInput): Brief {
  const mark = { cut: false };
  const out: string[] = [];
  out.push(
    `# Handoff from ${input.harnessName}`,
    "",
    `You are taking over a coding session that was started on ${input.harnessName}, and you are running on ${input.targetName}. ` +
      "You have none of its conversation history, only this briefing. The files in the working directory are the real, current state: " +
      "check them before relying on anything below, then carry on with the task.",
  );

  const firstUser = input.transcript.find((e) => e.kind === "user" && !e.parentToolUseId);
  const task = firstUser?.kind === "user" ? firstUser.text : input.firstPrompt;
  if (task?.trim()) out.push("", "## Task", "", cap(task, TASK_MAX, mark));

  const main = input.transcript.filter((e) => !e.parentToolUseId);
  const lastAssistant = [...main].reverse().find((e) => e.kind === "assistant" && e.text.trim());
  if (lastAssistant?.kind === "assistant") out.push("", "## Where it stands", "", "The last thing the previous agent said:", "", cap(lastAssistant.text, SUMMARY_MAX, mark));

  if (input.todos.length) {
    const mark2 = (s: Todo["status"]) => (s === "completed" ? "[x]" : s === "in_progress" ? "[~]" : "[ ]");
    out.push("", "## Plan", "", ...input.todos.map((t) => `- ${mark2(t.status)} ${t.content.replace(/\s+/g, " ").trim()}`));
  }

  const recent = main.filter((e) => e.kind === "user" || e.kind === "assistant" || e.kind === "tool").slice(-RECENT_ENTRIES);
  if (recent.length) {
    out.push("", "## Recent conversation", "");
    for (const e of recent) {
      if (e.kind === "tool") out.push(`- tool: ${toolLine(e.name, e.input)}${e.result && !e.result.ok ? " (failed)" : ""}`);
      else if (e.kind === "user") out.push(`- user: ${cap(e.text, RECENT_TEXT_MAX, mark).replace(/\s*\n\s*/g, " ")}`);
      else if (e.kind === "assistant") out.push(`- assistant: ${cap(e.text, RECENT_TEXT_MAX, mark).replace(/\s*\n\s*/g, " ")}`);
    }
  }

  const tree: string[] = [];
  if (input.branch) tree.push(`Branch: \`${input.branch}\``);
  if (input.files.length) {
    const shown = input.files.slice(0, FILES_MAX);
    if (input.files.length > shown.length) mark.cut = true;
    tree.push(`Uncommitted changes (${input.files.length}):`, "", ...shown.map((f) => `- ${f}`), ...(input.files.length > shown.length ? [`- … and ${input.files.length - shown.length} more`] : []));
  } else tree.push("No uncommitted changes.");
  if (input.diffStat.trim()) tree.push("", fence(cap(input.diffStat, DIFF_STAT_MAX, mark)));
  out.push("", "## Working tree", "", ...tree);

  out.push(
    "",
    "## Source",
    "",
    `Session "${input.title.replace(/\s+/g, " ").trim()}" on ${input.harnessName}${input.model ? ` (${input.model})` : ""}, Odin session ${input.sessionId}.`,
  );

  let text = out.join("\n");
  if (text.length > BRIEF_MAX_CHARS) {
    mark.cut = true;
    text = `${text.slice(0, BRIEF_MAX_CHARS - CUT.length - 1).trimEnd()}\n${CUT}`;
  }
  return { text, truncated: mark.cut };
}
