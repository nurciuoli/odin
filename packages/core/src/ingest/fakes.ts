// Test-only: an in-memory SessionsService (just what ingest/metrics use) and a session builder.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import type { Session, SessionMetrics } from "@odin/shared/api";
import { HttpError, send, sendError } from "../http/util.ts";
import { Router } from "../http/router.ts";
import type { RegisterRoutes, ExternalSessionInput, ProjectRef, ProjectsService, SessionPatch, SessionsService } from "../services.ts";
import { stubServices } from "../test-helpers.ts";
import type { Deps, Services } from "../services.ts";
import { createSettingsService } from "../settings/service.ts";
import { createIngestService } from "./service.ts";

export const emptyMetrics = (): SessionMetrics => ({
  wallMs: null, activeMs: null, turns: 0, toolCalls: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  tokensByModel: {}, costUsd: null, contextTokens: null, diff: null, commits: null, prOutcome: null, reviewRounds: 0,
});

export function makeSession(over: Partial<Session> = {}): Session {
  return {
    id: "s1", harness: "claude", project: "demo", projects: [over.project ?? "demo"], title: "t", tags: [], pinned: false, archived: false, origin: "external", state: "idle",
    waitingFor: null, cwd: "/work/demo", workspace: { kind: "checkout" }, branch: null, model: null, permissionMode: null, agent: null,
    agentVersion: null, templateId: null, parentId: null, aside: false, pull: null, createdAt: "2026-10-17T11:00:00.000Z",
    updatedAt: "2026-10-17T11:00:00.000Z", endedAt: null, error: null, metrics: emptyMetrics(), ...over,
  };
}

export function fakeSessions(db: DatabaseSync, initial: Session[] = []): SessionsService & { records: Map<string, Session>; patches: SessionPatch[] } {
  const records = new Map<string, Session>();
  const patches: SessionPatch[] = [];
  /** session_events has a foreign key to sessions, so the rows must exist. */
  const persist = (s: Session): void => {
    db.prepare("INSERT OR IGNORE INTO projects (name, path, created_at, updated_at) VALUES (?, ?, ?, ?)").run(s.project, `/projects/${s.project}`, s.createdAt, s.createdAt);
    db.prepare("INSERT OR IGNORE INTO sessions (id, harness, project, title, origin, state, cwd, created_at, updated_at, metrics) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')")
      .run(s.id, s.harness, s.project, s.title, s.origin, s.state, s.cwd, s.createdAt, s.updatedAt);
    records.set(s.id, s);
  };
  for (const s of initial) persist(s);
  const fake = {
    records,
    patches,
    get: (id: string) => records.get(id) ?? null,
    list: (f: { project?: string; since?: string; archived?: boolean } = {}) =>
      [...records.values()].filter((x) => (!f.project || x.project === f.project) && (!f.since || x.updatedAt >= f.since) && (f.archived === undefined || x.archived === f.archived)),
    ensureExternal(input: ExternalSessionInput): Session {
      const have = records.get(input.id);
      if (have) return have;
      const s = makeSession({ id: input.id, harness: input.harness, project: input.project, cwd: input.cwd, title: input.title ?? input.id, branch: input.branch ?? null, model: input.model ?? null, agent: input.agent ?? null, createdAt: input.at, updatedAt: input.at });
      persist(s);
      return s;
    },
    patch(id: string, patch: SessionPatch): Session {
      const cur = records.get(id)!;
      patches.push(patch);
      const { metrics, ...rest } = patch;
      const next = { ...cur, ...rest, metrics: { ...cur.metrics, ...metrics } } as Session;
      records.set(id, next);
      return next;
    },
    close: () => {},
  };
  return fake as unknown as SessionsService & { records: Map<string, Session>; patches: SessionPatch[] };
}

export function fakeProjects(projects: Record<string, string>): ProjectsService {
  return {
    get: (name: string) => (projects[name] ? ({ name, path: projects[name] } as ProjectRef) : null),
    resolveCwd: (cwd: string) => Object.entries(projects).find(([, p]) => cwd === p || cwd.startsWith(`${p}/`))?.[0] ?? null,
  } as unknown as ProjectsService;
}

/** A Services object with real settings + ingest over the fake sessions and projects. */
export function ingestServices(deps: Deps, sessions: SessionsService, projects: Record<string, string> = { demo: "/work/demo" }): Services {
  const services = stubServices({ sessions, projects: fakeProjects(projects) });
  services.settings = createSettingsService(deps, services);
  services.ingest = createIngestService(deps, services);
  return services;
}

/** Just enough of server.ts to dispatch to one module's routes. */
export async function routeApp(register: RegisterRoutes, deps: Deps, services: Services) {
  const router = new Router();
  register(router, deps, services);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const m = router.match(req.method ?? "GET", url.pathname);
      if (m.kind !== "found") return sendError(res, 404, "not found");
      send(res, 200, await m.handler({ req, res, url, params: m.params }));
    } catch (err) {
      if (err instanceof HttpError) return sendError(res, err.status, err.message);
      sendError(res, 500, "internal error");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    fetch: (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } }),
    close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }),
  };
}
