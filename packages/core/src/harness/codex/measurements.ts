// Recover usage from Codex's local rollout. Never retain message text, tool input or credentials.
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { HarnessMeasurement } from "../types.ts";
import type { Wire } from "./transport.ts";

const number = (v: unknown): number => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
const keys = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens"] as const;

export async function rolloutMeasurements(file: string, threadId: string): Promise<HarnessMeasurement[] | null> {
  const facts: HarnessMeasurement[] = [];
  let model = "codex-default";
  let previous: Wire = {};
  let verified = false;
  let index = 0;
  let nativeRecords = false;
  const responses = new Set<string>();
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let row: Wire;
      try { row = JSON.parse(line); } catch { continue; } // an actively written trailing line may be incomplete
      const p = row?.payload;
      if (!p || !Number.isFinite(Date.parse(row.timestamp))) continue;
      if (row.type === "session_meta") {
        if (p.id !== threadId) return null;
        verified = true;
      }
      if (!verified) continue;
      if (row.type === "turn_context" && typeof p.model === "string") model = p.model;
      const record = row.type === "token_usage_record";
      const info = row.type === "event_msg" && p.type === "token_count" ? p.info : null;
      if (record) {
        if (p.thread_id && p.thread_id !== threadId) continue;
        if (typeof p.response_id === "string") {
          if (responses.has(p.response_id)) continue;
          responses.add(p.response_id);
        }
        nativeRecords = true;
      }
      if (info) {
        const latest = facts.at(-1);
        if (latest?.kind === "usage") {
          if (number(info.model_context_window) > 0) latest.data.contextWindow = info.model_context_window;
          if (typeof info.last_token_usage?.total_tokens === "number") latest.data.contextTokens = number(info.last_token_usage.total_tokens);
        }
        // Modern records include compaction calls absent from legacy totals. Mixing the two cumulative
        // counters overcounts every subsequent call; after the first native record use it exclusively.
        if (nativeRecords) continue;
      }
      const total = record ? p.thread_token_usage : info?.total_token_usage;
      if (!total || (record && p.thread_id && p.thread_id !== threadId)) continue;
      const last = record ? p.usage : info?.last_token_usage;
      const span: Wire = {};
      for (const key of keys) {
        const current = number(total[key]);
        // Some old rollouts reset counters. In that case count only the reported latest call.
        span[key] = current >= number(previous[key]) ? current - number(previous[key]) : number(last?.[key]);
      }
      previous = { ...total };
      if (!keys.some(k => span[k] > 0)) continue;
      facts.push({
        id: `usage:${index++}`, at: row.timestamp, kind: "usage",
        data: {
          model, cumulative: false, costUsd: null,
          input: Math.max(0, span.input_tokens - span.cached_input_tokens - span.cache_write_input_tokens),
          output: span.output_tokens, cacheRead: span.cached_input_tokens, cacheWrite: span.cache_write_input_tokens,
          contextTokens: typeof last?.total_tokens === "number" ? number(last.total_tokens) : null,
          contextWindow: number(info?.model_context_window) || null,
        },
      });
    }
    return verified ? facts : null;
  } catch {
    return null;
  } finally {
    lines.close();
    stream.destroy();
  }
}
