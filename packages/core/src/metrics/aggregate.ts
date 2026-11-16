// Pure grouping for GET /api/metrics (docs/contracts.md#metrics). No DB, no git.
import type { MetricsDimension, MetricsRow, Session } from "@odin/shared/api";
import { normaliseModel } from "@odin/shared/pricing";
import { LOW_CONFIDENCE_N } from "@odin/shared/session";

export const UNKNOWN_KEY = "∅";
export const METRICS_DIMENSIONS: MetricsDimension[] = ["model", "agent", "agentVersion", "template", "harness", "project", "origin"];

export function keyOf(s: Session, dim: MetricsDimension): string {
  switch (dim) {
    case "model": return s.model ? normaliseModel(s.model) || UNKNOWN_KEY : UNKNOWN_KEY;
    case "agent": return s.agent || UNKNOWN_KEY;
    case "agentVersion": return s.agent && s.agentVersion ? `${s.agent}@${s.agentVersion.slice(0, 8)}` : UNKNOWN_KEY;
    case "template": return s.templateId || UNKNOWN_KEY;
    case "harness": return s.harness || UNKNOWN_KEY;
    case "project": return s.project || UNKNOWN_KEY;
    case "origin": return s.origin || UNKNOWN_KEY;
  }
}

/** Median of the known values (mean of the middle two when even); null when there are none. */
export function median(values: (number | null | undefined)[]): number | null {
  const xs = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2;
}

const rate = (num: number, den: number): number | null => (den === 0 ? null : num / den);

/** Sessions with at least one turn and not archived are the population; the caller filters project and since. */
export function inPopulation(s: Session): boolean {
  return !s.archived && s.metrics.turns >= 1;
}

/** Token sums per field; cost sums the known costs, null when none is known. */
export function totalOf(members: Session[]): MetricsRow["total"] {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let costUsd: number | null = null;
  for (const s of members) {
    const t = s.metrics.tokens;
    tokens.input += t.input; tokens.output += t.output; tokens.cacheRead += t.cacheRead; tokens.cacheWrite += t.cacheWrite;
    if (typeof s.metrics.costUsd === "number" && Number.isFinite(s.metrics.costUsd)) costUsd = (costUsd ?? 0) + s.metrics.costUsd;
  }
  return { tokens, costUsd };
}

export function aggregate(sessions: Session[], groupBy: MetricsDimension[]): MetricsRow[] {
  const groups = new Map<string, { key: MetricsRow["key"]; members: Session[] }>();
  for (const s of sessions) {
    if (!inPopulation(s)) continue;
    const key: MetricsRow["key"] = {};
    for (const dim of groupBy) key[dim] = keyOf(s, dim);
    const id = JSON.stringify(groupBy.map((d) => key[d]));
    const g = groups.get(id) ?? { key, members: [] };
    g.members.push(s);
    groups.set(id, g);
  }
  // No grouping: exactly one row over the whole population, even an empty one.
  if (!groupBy.length && !groups.size) groups.set("[]", { key: {}, members: [] });
  const rows: { id: string; row: MetricsRow }[] = [];
  for (const [id, { key, members }] of groups) {
    const decided = members.filter((s) => s.metrics.prOutcome === "merged" || s.metrics.prOutcome === "merged-after-changes" || s.metrics.prOutcome === "closed");
    const merged = decided.filter((s) => s.metrics.prOutcome !== "closed");
    const clean = decided.filter((s) => s.metrics.prOutcome === "merged");
    rows.push({
      id,
      row: {
        key,
        n: members.length,
        lowConfidence: members.length < LOW_CONFIDENCE_N,
        median: {
          wallMs: median(members.map((s) => s.metrics.wallMs)),
          activeMs: median(members.map((s) => s.metrics.activeMs)),
          turns: median(members.map((s) => s.metrics.turns)),
          toolCalls: median(members.map((s) => s.metrics.toolCalls)),
          tokensOut: median(members.map((s) => s.metrics.tokens.output)),
          costUsd: median(members.map((s) => s.metrics.costUsd)),
          diffLines: median(members.map((s) => (s.metrics.diff ? s.metrics.diff.added + s.metrics.diff.removed : null))),
        },
        rates: {
          merged: rate(merged.length, decided.length),
          mergedClean: rate(clean.length, decided.length),
          failed: rate(members.filter((s) => s.state === "failed").length, members.length),
        },
        total: totalOf(members),
        sessionIds: members.map((s) => s.id),
      },
    });
  }
  return rows.sort((a, b) => b.row.n - a.row.n || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((r) => r.row);
}
