// Session states and metrics helpers. Core enforces the state rules; web uses them to decide which actions to offer.
import type { SessionMetrics, SessionState } from "./api.ts";

/** States in which the harness may still produce events. */
export const LIVE_SESSION_STATES: SessionState[] = ["running", "waiting"];
export const FINAL_SESSION_STATES: SessionState[] = ["ended", "failed"];

/**
 * Allowed moves. idle ⇄ running ⇄ waiting while a handle is live; any state → ended/failed when the handle closes;
 * ended/failed → running again on resume.
 */
export const SESSION_TRANSITIONS: Record<SessionState, SessionState[]> = {
  idle: ["running", "ended", "failed"],
  running: ["idle", "waiting", "ended", "failed"],
  waiting: ["running", "idle", "ended", "failed"],
  ended: ["running", "idle"],
  failed: ["running", "idle"],
};

export function canTransition(from: SessionState, to: SessionState): boolean {
  return from === to || SESSION_TRANSITIONS[from].includes(to);
}

export function isFinal(state: SessionState): boolean {
  return FINAL_SESSION_STATES.includes(state);
}

export function emptyMetrics(): SessionMetrics {
  return {
    wallMs: null,
    activeMs: null,
    turns: 0,
    toolCalls: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    tokensByModel: {},
    costUsd: null,
    contextTokens: null,
    diff: null,
    commits: null,
    prOutcome: null,
    reviewRounds: 0,
  };
}

/** Metrics groups with fewer sessions are flagged low-confidence. */
export const LOW_CONFIDENCE_N = 3;

/** Default branch name for a session worktree: `odin/<slug>-<first 8 of id>`. */
export function sessionBranch(title: string, sessionId: string): string {
  const slug = slugify(title);
  return `odin/${slug}-${sessionId.replace(/-/g, "").slice(0, 8)}`;
}

/** Lowercase, ascii, dash-separated, ≤ 40 chars. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}
