// User-role messages the CLI injects that the user never typed: subagent hand-backs and reports, other sessions'
// messages, channel messages, system notifications, scheduled wakeups. The SDK's `origin` says so when present;
// otherwise the wrapper at the very start of the text (after any `<system-reminder>` blocks) does. A wrapper string
// further into the text doesn't count: that's the user's text quoting it.
import type { InjectedSource } from "@odin/shared/harness";

type Loose = Record<string, any>;

export interface Injected {
  source: InjectedSource;
  from: string | null;
  text: string;
}

const LEADING_REMINDERS = /^(?:\s*<system-reminder>[\s\S]*?<\/system-reminder>)*\s*/;
const SESSION_PREAMBLE = /^Another Claude session sent a message:\s*/;
const HAND_BACK = /^\[Subagent hand-back\]\s*/;

const unescapeXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

function attr(open: string, name: string): string | null {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(open);
  const v = m ? unescapeXml(m[1]!).trim() : "";
  return v || null;
}

/** `<tag attrs>body</tag>` at the start of `text`: its opening tag and body (the rest when unclosed). */
function envelope(text: string, tag: string): { open: string; body: string } | null {
  const m = new RegExp(`^<${tag}(\\s[^>]*)?>`).exec(text);
  if (!m) return null;
  let body = text.slice(m[0].length);
  const close = body.lastIndexOf(`</${tag}>`);
  if (close >= 0) body = body.slice(0, close);
  return { open: m[0], body: body.trim() };
}

const ENVELOPES: { tag: string; source: InjectedSource; from: string[] }[] = [
  { tag: "agent-message", source: "agent", from: ["from", "name"] },
  { tag: "teammate-message", source: "agent", from: ["teammate_id", "from", "name"] },
  { tag: "cross-session-message", source: "peer", from: ["from", "name"] },
  { tag: "channel", source: "channel", from: ["source", "server", "from"] },
  { tag: "scheduled-wakeup", source: "scheduled", from: [] },
  { tag: "scheduled-task", source: "scheduled", from: [] },
];

const NOTICES: { prefix: RegExp; source: InjectedSource }[] = [
  { prefix: /^\[SYSTEM NOTIFICATION[^\]]*\]\s*/, source: "system" },
  { prefix: /^\[Scheduled wakeup[^\]]*\]\s*/i, source: "scheduled" },
];

/** What injected a message, from its text alone; null when it reads as the user's own. */
export function detectInjected(raw: string): Injected | null {
  let text = raw.replace(LEADING_REMINDERS, "");
  const preamble = SESSION_PREAMBLE.test(text);
  text = text.replace(SESSION_PREAMBLE, "");
  for (const e of ENVELOPES) {
    const found = envelope(text, e.tag);
    if (!found) continue;
    const from = e.from.map((a) => attr(found.open, a)).find((v) => v) ?? null;
    return { source: e.source, from, text: found.body.replace(HAND_BACK, "") };
  }
  for (const n of NOTICES) if (n.prefix.test(text)) return { source: n.source, from: null, text: text.replace(n.prefix, "").trim() };
  if (preamble) return { source: "peer", from: null, text: text.trim() };
  return null;
}

/** What injected a user-role SDK message (its `origin` first, then its text); null when the user typed it. */
export function injectedMessage(m: Loose, text: string): Injected | null {
  const origin: Loose | undefined = m.origin;
  if (origin?.kind === "human") return null;
  const fromText = detectInjected(text);
  if (origin?.kind === "peer") {
    const source: InjectedSource = origin.senderTaskId || fromText?.source === "agent" ? "agent" : "peer";
    const body = typeof origin.body === "string" ? origin.body.replace(HAND_BACK, "").trim() : fromText?.text ?? text.trim();
    const from = (typeof origin.name === "string" && origin.name) || fromText?.from || (typeof origin.from === "string" && origin.from) || null;
    return { source, from, text: body };
  }
  if (origin?.kind === "channel") return { source: "channel", from: typeof origin.server === "string" ? origin.server : fromText?.from ?? null, text: fromText?.text ?? text.trim() };
  return fromText;
}
