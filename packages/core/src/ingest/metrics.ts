// SessionMetrics derived from a session's measurement facts (rows of session_events). Pure: no DB, no clock. Used for
// hook facts (external sessions) and harness facts (Odin sessions) alike. docs/contracts.md#ingest.
//
// Only what facts can know is returned. diff, commits, prOutcome and reviewRounds belong to metrics.refreshOutput and
// sync and are never touched here.
import type { ModelPrice, SessionMetrics, TokenUsage } from "@odin/shared/api";
import { costOf } from "@odin/shared/pricing";

export type FactMetrics = Pick<SessionMetrics, "wallMs" | "activeMs" | "turns" | "toolCalls" | "tokens" | "tokensByModel" | "costUsd" | "contextTokens" | "contextWindow">;

/** One stored fact. `data` is the parsed JSON. */
export interface FactRow {
  kind: string;
  ts: string;
  data: Record<string, any>;
}

/** What a fork inherits per model: usage (and the harness's cost for it) already counted in the parent. */
export type Baseline = Record<string, { usage: TokenUsage; costUsd: number | null }>;

export interface Derived {
  metrics: FactMetrics;
  /** The model with the most output tokens, or null when no usage was reported. */
  topModel: string | null;
}

export const BASELINE_KIND = "baseline";

const zero = (): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
const add = (a: TokenUsage, b: TokenUsage): void => {
  a.input += b.input;
  a.output += b.output;
  a.cacheRead += b.cacheRead;
  a.cacheWrite += b.cacheWrite;
};
const sub = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  input: Math.max(0, a.input - b.input),
  output: Math.max(0, a.output - b.output),
  cacheRead: Math.max(0, a.cacheRead - b.cacheRead),
  cacheWrite: Math.max(0, a.cacheWrite - b.cacheWrite),
});

interface ModelState {
  usage: TokenUsage;
  /** The harness's own cost for that usage; null while unknown. */
  costUsd: number | null;
  /** A cumulative report was seen: the harness counts the whole history, so a fork's baseline applies. */
  cumulative: boolean;
}

/** Per-model totals as reported (before any baseline). */
export function modelTotals(rows: FactRow[]): Map<string, ModelState> {
  const byModel = new Map<string, ModelState>();
  for (const r of rows) {
    if (r.kind !== "usage" || typeof r.data.model !== "string") continue;
    const d = r.data;
    const incoming: TokenUsage = { input: num(d.input), output: num(d.output), cacheRead: num(d.cacheRead), cacheWrite: num(d.cacheWrite) };
    const cost = typeof d.costUsd === "number" && Number.isFinite(d.costUsd) && d.costUsd >= 0 ? d.costUsd : null;
    const prev = byModel.get(d.model);
    if (d.cumulative === true || !prev) {
      byModel.set(d.model, { usage: incoming, costUsd: cost, cumulative: d.cumulative === true || (prev?.cumulative ?? false) });
    } else {
      add(prev.usage, incoming);
      if (cost !== null) prev.costUsd = (prev.costUsd ?? 0) + cost;
    }
  }
  return byModel;
}

/** The baseline a fork records: the parent's gross per-model totals. */
export function baselineFrom(rows: FactRow[]): Baseline {
  const out: Baseline = {};
  for (const [model, s] of modelTotals(rows)) out[model] = { usage: s.usage, costUsd: s.costUsd };
  return out;
}

export function computeMetrics(rows: FactRow[], pricing: Record<string, ModelPrice>, baseline: Baseline = {}): Derived {
  const facts = rows.filter((r) => r.kind !== BASELINE_KIND);
  let turns = 0, toolCalls = 0, activeMs = 0, contextTokens: number | null = null;
  let durationsKnown = true;
  let contextWindow: number | null = null;
  let first = Infinity, last = -Infinity;
  for (const r of facts) {
    const t = Date.parse(r.ts);
    if (Number.isFinite(t)) {
      first = Math.min(first, t);
      last = Math.max(last, t);
    }
    if (r.kind === "turn") {
      turns++;
      if (r.data.durationMs === null) durationsKnown = false;
      activeMs += num(r.data.durationMs);
    } else if (r.kind === "tool") {
      toolCalls++;
    } else if (r.kind === "usage" && typeof r.data.contextTokens === "number") {
      contextTokens = r.data.contextTokens;
    }
    if (r.kind === "usage" && num(r.data.contextWindow) > 0) contextWindow = r.data.contextWindow;
  }

  const tokensByModel: Record<string, TokenUsage> = {};
  const tokens = zero();
  let priced: number | null = 0, harnessCost: number | null = 0, any = false;
  let topModel: string | null = null, topOut = -1;
  for (const [model, s] of modelTotals(facts)) {
    const base = s.cumulative ? baseline[model] : undefined;
    const usage = base ? sub(s.usage, base.usage) : s.usage;
    const own = s.costUsd === null ? null : Math.max(0, s.costUsd - (base?.costUsd ?? 0));
    any = true;
    tokensByModel[model] = usage;
    add(tokens, usage);
    if (usage.output > topOut) {
      topOut = usage.output;
      topModel = model;
    }
    const c = costOf(usage, model, pricing);
    priced = c === null || priced === null ? null : priced + c;
    harnessCost = own === null || harnessCost === null ? null : harnessCost + own;
  }

  return {
    topModel,
    metrics: {
      wallMs: Number.isFinite(first) ? Math.max(0, last - first) : null,
      activeMs: turns && durationsKnown ? activeMs : null,
      turns,
      toolCalls,
      tokens,
      tokensByModel,
      costUsd: any ? (priced ?? harnessCost) : null,
      contextTokens,
      ...(contextWindow === null ? {} : { contextWindow }),
    },
  };
}
