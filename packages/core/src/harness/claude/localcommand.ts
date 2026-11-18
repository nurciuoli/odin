// Transcript wrappers the CLI writes for slash commands and shell commands it runs itself: `<command-name>` (with
// `<command-message>` and `<command-args>`) for the invocation, `<local-command-stdout>` / `<local-command-stderr>`
// for what a local command printed, `<local-command-caveat>` for the note to the model, and `<bash-input>` /
// `<bash-stdout>` / `<bash-stderr>` for `!` commands. The user never sees tags: an invocation reads as what they
// typed (`/mcp`, `!ls`), output as a system line, a caveat not at all. Text that holds anything besides these
// wrappers (after `<system-reminder>` blocks) is the user's own and is left alone.

export interface LocalCommandOutput {
  level: "info" | "error";
  text: string;
}

export interface LocalCommandParts {
  /** What the user typed, when the text holds an invocation. */
  typed: string | null;
  outputs: LocalCommandOutput[];
}

const TAGS = ["command-name", "command-message", "command-args", "local-command-stdout", "local-command-stderr", "local-command-caveat", "bash-input", "bash-stdout", "bash-stderr"] as const;
type Tag = (typeof TAGS)[number];

const REMINDERS = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const unescapeXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

export function parseLocalCommand(text: string): LocalCommandParts | null {
  let rest = text.replace(REMINDERS, "").trim();
  if (!/^<(?:command-name|command-message|command-args|local-command-\w+|bash-(?:input|stdout|stderr))>/.test(rest)) return null;
  const found = new Map<Tag, string[]>();
  while (rest) {
    const open = /^<([a-z-]+)>/.exec(rest);
    const tag = open && (TAGS as readonly string[]).includes(open[1]!) ? (open[1] as Tag) : null;
    if (!tag) return null;
    const bodyAt = open![0].length;
    const closeAt = rest.indexOf(`</${tag}>`, bodyAt);
    // An unclosed block (a truncated message) takes the rest of the text.
    const body = closeAt < 0 ? rest.slice(bodyAt) : rest.slice(bodyAt, closeAt);
    found.set(tag, [...(found.get(tag) ?? []), unescapeXml(body)]);
    rest = closeAt < 0 ? "" : rest.slice(closeAt + tag.length + 3).trimStart();
  }
  const one = (tag: Tag) => (found.get(tag) ?? []).join("\n").trim();
  let typed: string | null = null;
  const name = one("command-name") || one("command-message");
  if (name) typed = [name.startsWith("/") ? name : `/${name}`, one("command-args")].filter(Boolean).join(" ");
  else if (found.has("bash-input")) typed = `!${one("bash-input")}`;
  const outputs: LocalCommandOutput[] = [];
  for (const [tag, level] of [["local-command-stdout", "info"], ["bash-stdout", "info"], ["local-command-stderr", "error"], ["bash-stderr", "error"]] as const) {
    const out = (found.get(tag) ?? []).join("\n").replace(ANSI, "").trim();
    if (out) outputs.push({ level, text: out });
  }
  return { typed, outputs };
}
