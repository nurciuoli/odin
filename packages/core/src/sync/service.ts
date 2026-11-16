// Optional GitHub add-on: PR reads only. No issue/milestone reads, mirror or remote writes.
import type { PrOutcome, SyncStatus } from "@odin/shared/api";
import type { Deps, PullInfo, Services, SyncService } from "../services.ts";
import { GitHubClient } from "./github.ts";

export function closesFromBody(body: string | null | undefined): number[] {
  return [...new Set([...(body ?? "").matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)\b/gi)].map((m) => Number(m[1])))].sort((a, b) => a - b);
}
export function prOutcome(pull: Pick<PullInfo, "state" | "merged" | "reviewRounds">): PrOutcome {
  return pull.merged ? (pull.reviewRounds ? "merged-after-changes" : "merged") : pull.state === "open" ? "open" : "closed";
}

export function createSyncService(deps: Deps, services: Pick<Services, "projects" | "sessions">): SyncService {
  const { db, config, bus } = deps;
  const gh = new GitHubClient({ token: config.githubToken, baseUrl: config.githubApiUrl, fetch: deps.githubFetch, now: () => deps.now().getTime() });
  const listeners = new Set<(project: string, pull: PullInfo) => void>();
  const runs = new Map<string, Promise<void>>();
  let closed = false;
  db.prepare("UPDATE sync_state SET state = 'idle' WHERE state = 'syncing'").run();
  function repo(project: string): string | null {
    const ref = services.projects.get(project);
    return ref?.settings.githubEnabled === true && gh.hasToken ? ref.settings.repo : null;
  }
  function status(project: string): SyncStatus {
    if (!repo(project)) return { state: "off", lastSyncAt: null, error: null };
    const row = db.prepare("SELECT state, last_sync_at, error FROM sync_state WHERE project = ?").get(project);
    return row ? { state: row.state as SyncStatus["state"], lastSyncAt: row.last_sync_at as string | null, error: row.error as string | null } : { state: "idle", lastSyncAt: null, error: null };
  }
  function setStatus(project: string, state: SyncStatus["state"], error: string | null = null) {
    const last = state === "idle" ? deps.now().toISOString() : status(project).lastSyncAt;
    db.prepare("INSERT INTO sync_state (project, state, last_sync_at, error) VALUES (?, ?, ?, ?) ON CONFLICT(project) DO UPDATE SET state = excluded.state, last_sync_at = excluded.last_sync_at, error = excluded.error").run(project, state, last, error);
    bus.emit({ type: "sync.status", project, sync: status(project) });
  }
  function fromRow(row: Record<string, unknown>): PullInfo {
    return { number: row.number as number, headBranch: row.head_branch as string, state: row.state as PullInfo["state"], merged: !!row.merged, reviewRounds: row.review_rounds as number, files: JSON.parse(row.files as string), closes: JSON.parse(row.closes as string), url: row.url as string };
  }
  function link(project: string, pull: PullInfo) {
    const rows = db.prepare("SELECT id FROM sessions WHERE project = ? AND branch = ?").all(project, pull.headBranch);
    for (const row of rows) {
      const session = services.sessions.get(row.id as string);
      const ref = { number: pull.number, url: pull.url, state: pull.state, merged: pull.merged };
      if (JSON.stringify(session?.pull) === JSON.stringify(ref) && session?.metrics.prOutcome === prOutcome(pull) && session.metrics.reviewRounds === pull.reviewRounds) continue;
      services.sessions.patch(row.id as string, { pull: ref, metrics: { prOutcome: prOutcome(pull), reviewRounds: pull.reviewRounds } });
    }
    for (const listener of listeners) listener(project, pull);
  }
  async function run(project: string): Promise<void> {
    const repository = repo(project);
    if (!repository || closed) return;
    setStatus(project, "syncing");
    try {
      for await (const page of gh.pullPages(repository)) {
        for (const raw of page.items) {
          if (closed || repo(project) !== repository) return;
          const previous = db.prepare("SELECT * FROM pulls WHERE project = ? AND number = ?").get(project, raw.number);
          if (previous && previous.updated_at === raw.updated_at && previous.head_branch === raw.head.ref && previous.state === raw.state && !!previous.merged === (!!raw.merged_at || raw.merged === true)) {
            link(project, fromRow(previous));
            continue;
          }
          const [files, reviews] = await Promise.all([gh.pullFiles(repository, raw.number), gh.pullReviews(repository, raw.number)]);
          const pull: PullInfo = { number: raw.number, headBranch: raw.head.ref, state: raw.state, merged: !!raw.merged_at || raw.merged === true, url: raw.html_url, files, closes: closesFromBody(raw.body), reviewRounds: reviews.filter((r) => r.state === "CHANGES_REQUESTED").length };
          db.prepare(`INSERT INTO pulls (project, number, head_branch, state, merged, review_rounds, files, closes, url, updated_at, merged_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project, number) DO UPDATE SET
            head_branch=excluded.head_branch, state=excluded.state, merged=excluded.merged, review_rounds=excluded.review_rounds,
            files=excluded.files, closes=excluded.closes, url=excluded.url, updated_at=excluded.updated_at, merged_at=excluded.merged_at`)
            .run(project, pull.number, pull.headBranch, pull.state, Number(pull.merged), pull.reviewRounds, JSON.stringify(files), JSON.stringify(pull.closes), pull.url, raw.updated_at, raw.merged_at ?? null);
          link(project, pull);
        }
      }
      setStatus(project, "idle");
    } catch (error) {
      if (!closed) setStatus(project, "error", gh.scrub(error instanceof Error ? error.message : "GitHub read failed"));
    }
  }
  function syncNow(project: string): Promise<void> {
    const active = runs.get(project);
    if (active) return active;
    const promise = run(project).finally(() => runs.delete(project));
    runs.set(project, promise);
    return promise;
  }
  const timer = config.githubSyncMs > 0 ? setInterval(() => { if (!closed) for (const ref of services.projects.list()) void syncNow(ref.name); }, config.githubSyncMs) : null;
  timer?.unref();
  return {
    status, syncNow,
    pullForBranch(project, branch) {
      const row = db.prepare("SELECT * FROM pulls WHERE project = ? AND head_branch = ? ORDER BY updated_at DESC, number DESC LIMIT 1").get(project, branch);
      return row ? fromRow(row) : null;
    },
    onPull(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async close() { closed = true; if (timer) clearInterval(timer); await Promise.allSettled([...runs.values()]); listeners.clear(); },
  };
}
