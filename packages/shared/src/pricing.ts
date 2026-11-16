// Token cost. Prices are USD per million tokens, from ~/.odin/pricing.json (editable; seeded from DEFAULT_PRICING).
import type { ModelPrice, TokenUsage } from "./api.ts";

/**
 * Keyed by model id without provider (`claude-opus-5-5`), matched by normaliseModel. Anthropic first-party rates as of
 * 2026-10; cache writes are the 5-minute rate (1.25x input). Haiku 5.5 is the ≤100K-prompt rate. pricing.json wins.
 */
export const DEFAULT_PRICING: Record<string, ModelPrice> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "gemini-3.8-flash": { input: 0.15, output: 0.6, cacheRead: 0.0375, cacheWrite: 0.15 },
  "gemini-3.8-pro": { input: 1.25, output: 5.0, cacheRead: 0.3125, cacheWrite: 1.25 },
  "gemini-3.8-flash-lite": { input: 0.075, output: 0.3, cacheRead: 0.01875, cacheWrite: 0.075 },
};

/** `anthropic/claude-opus-5-5` → `claude-opus-5-5`; also strips Claude Code context suffixes like `[1m]`. */
export function normaliseModel(model: string): string {
  const id = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  return id.replace(/\[[^\]]*\]$/, "").trim().toLowerCase();
}

/** Cost in USD, or null when the model has no price. */
export function costOf(usage: TokenUsage, model: string, pricing: Record<string, ModelPrice>): number | null {
  const p = pricing[normaliseModel(model)];
  if (!p) return null;
  return (usage.input * p.input + usage.output * p.output + usage.cacheRead * p.cacheRead + usage.cacheWrite * p.cacheWrite) / 1e6;
}
