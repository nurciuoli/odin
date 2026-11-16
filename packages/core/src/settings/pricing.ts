// pricing.json loader. Re-reads when the file's mtime changes; a missing or broken file falls back to DEFAULT_PRICING.
import { statSync, readFileSync } from "node:fs";
import type { ModelPrice } from "@odin/shared/api";
import { DEFAULT_PRICING, normaliseModel } from "@odin/shared/pricing";

export function validPrice(p: unknown): p is ModelPrice {
  if (typeof p !== "object" || p === null) return false;
  return (["input", "output", "cacheRead", "cacheWrite"] as const).every((k) => {
    const v = (p as Record<string, unknown>)[k];
    return typeof v === "number" && Number.isFinite(v) && v >= 0;
  });
}

export type PricingLoader = (() => Record<string, ModelPrice>) & { /** Forget the cache (after writing the file ourselves). */ reset(): void };

export function createPricingLoader(path: string): PricingLoader {
  let mtimeMs = -1;
  let cached: Record<string, ModelPrice> = { ...DEFAULT_PRICING };
  const load = (): Record<string, ModelPrice> => {
    let m: number;
    try {
      m = statSync(path).mtimeMs;
    } catch {
      mtimeMs = -1;
      cached = { ...DEFAULT_PRICING };
      return cached;
    }
    if (m === mtimeMs) return cached;
    mtimeMs = m;
    const next: Record<string, ModelPrice> = { ...DEFAULT_PRICING };
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        for (const [model, price] of Object.entries(parsed)) if (validPrice(price)) next[normaliseModel(model)] = price;
      }
    } catch {
      // Unreadable or invalid JSON: keep the defaults. The cost shows as unknown rather than wrong.
    }
    cached = next;
    return cached;
  };
  return Object.assign(load, { reset: () => { mtimeMs = -1; } });
}
