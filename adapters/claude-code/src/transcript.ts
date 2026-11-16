// Parses a Claude Code transcript (JSONL) into token usage per model and a list of turns.
// Streaming writes several lines per assistant message, so everything is de-duplicated by `message.id`.
// Transcript formats vary by Claude Code version: every field is read defensively and junk lines are skipped.
import type { TokenUsage } from "@odin/shared/api";

export interface TranscriptTurn {
  /** 1-based, in transcript order. */
  index: number;
  /** From the preceding user line's timestamp to the end of the assistant message. 0 when unknown. */
  durationMs: number;
  model?: string;
  /** Timestamp of the message's last line. */
  ts?: string;
}

export interface TranscriptSummary {
  usage: Record<string, TokenUsage>;
  turns: TranscriptTurn[];
}

interface Seen {
  model: string;
  usage: TokenUsage;
}

const emptyUsage = (): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

function isRecord(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseTs(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/** A shared de-duplication scope, so a main transcript and its subagents' transcripts never count a message twice. */
export class TranscriptScan {
  #messages = new Map<string, Seen>();
  #anonymous: Seen[] = [];

  /** Adds one transcript's usage. With `withTurns`, also returns its turns (main transcript only). */
  add(text: string, withTurns = false): TranscriptTurn[] {
    const turns: TranscriptTurn[] = [];
    const turnByMessage = new Map<string, { turn: TranscriptTurn; lastTs: number | null; userTs: number | null }>();
    let lastUserTs: number | null = null;

    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(row)) continue;
      const ts = parseTs(row.timestamp);

      if (row.type === "user") {
        if (ts !== null) lastUserTs = ts;
        continue;
      }
      const message = row.message;
      if (row.type !== "assistant" || !isRecord(message)) continue;

      const model = typeof message.model === "string" ? message.model : "";
      const id = typeof message.id === "string" && message.id ? message.id : null;
      const u = message.usage;
      if (isRecord(u) && model && model !== "<synthetic>") {
        const usage: TokenUsage = {
          input: num(u.input_tokens),
          output: num(u.output_tokens),
          cacheRead: num(u.cache_read_input_tokens),
          cacheWrite: num(u.cache_creation_input_tokens),
        };
        if (id) {
          const prev = this.#messages.get(id);
          // Later lines of one message carry the final counts; a per-field max is right whichever order they arrive.
          if (prev) {
            prev.usage = {
              input: Math.max(prev.usage.input, usage.input),
              output: Math.max(prev.usage.output, usage.output),
              cacheRead: Math.max(prev.usage.cacheRead, usage.cacheRead),
              cacheWrite: Math.max(prev.usage.cacheWrite, usage.cacheWrite),
            };
          } else this.#messages.set(id, { model, usage });
        } else this.#anonymous.push({ model, usage });
      }

      if (withTurns && row.isSidechain !== true && model !== "<synthetic>") {
        const key = id ?? (typeof row.uuid === "string" ? row.uuid : `line:${turns.length}`);
        const existing = turnByMessage.get(key);
        if (existing) {
          if (ts !== null) existing.lastTs = ts;
          existing.turn.durationMs = existing.userTs !== null && existing.lastTs !== null ? Math.max(0, existing.lastTs - existing.userTs) : 0;
          if (typeof row.timestamp === "string" && ts !== null) existing.turn.ts = row.timestamp;
        } else {
          const turn: TranscriptTurn = {
            index: turns.length + 1,
            durationMs: lastUserTs !== null && ts !== null ? Math.max(0, ts - lastUserTs) : 0,
          };
          if (model) turn.model = model;
          if (ts !== null && typeof row.timestamp === "string") turn.ts = row.timestamp;
          turns.push(turn);
          turnByMessage.set(key, { turn, lastTs: ts, userTs: lastUserTs });
        }
      }
    }
    return turns;
  }

  usage(): Record<string, TokenUsage> {
    const out: Record<string, TokenUsage> = {};
    for (const { model, usage } of [...this.#messages.values(), ...this.#anonymous]) {
      const sum = (out[model] ??= emptyUsage());
      sum.input += usage.input;
      sum.output += usage.output;
      sum.cacheRead += usage.cacheRead;
      sum.cacheWrite += usage.cacheWrite;
    }
    return out;
  }
}

/** One transcript's text → usage per model and turns. */
export function parseTranscript(text: string): TranscriptSummary {
  const scan = new TranscriptScan();
  const turns = scan.add(text, true);
  return { usage: scan.usage(), turns };
}
