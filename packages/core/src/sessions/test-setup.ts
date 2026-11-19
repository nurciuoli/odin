// Test scaffolding for sessions and launch: testDeps() + the real sessions, launch, library (seeded into the temp
// home; no rescan timer) services, a fake projects service (with createWorktree/agents/detail),
// recording ingest/metrics/artifacts fakes, and a tiny HTTP server with the sessions routes and the SSE hub. No
// network, temp dirs only.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { HarnessEvent } from "@odin/shared/harness";
import type { ProjectAgent, ProjectSettings } from "@odin/shared/api";
import { fakeHarness, type FakeHarness, type FakeHarnessOptions } from "../harness/fake.ts";
import type { Harnesses } from "../harness/types.ts";
import { Router } from "../http/router.ts";
import { SseHub } from "../http/sse.ts";
import { HttpError, send, sendError } from "../http/util.ts";
import { createAgentContextService } from "../context/agent-context.ts";
import { createLaunchService } from "../launch/service.ts";
import { createLibraryService } from "../library/service.ts";
import { DEFAULT_APP_SETTINGS } from "../settings/service.ts";
import type { ProjectRef, ProjectsService, Services } from "../services.ts";
import { stubServices, testDeps } from "../test-helpers.ts";
import { registerSessionsRoutes } from "./routes.ts";
import { createSessionsService, type SessionsOptions } from "./service.ts";
import { createNotebooksService } from "../notebooks/service.ts";
import { createCheckpointsService } from "../checkpoints/service.ts";
import type { CheckpointsService } from "../services.ts";

const noopCheckpoints: CheckpointsService = {
  list: () => [], diff: async () => { throw new Error("no checkpoints"); }, restore: async () => { throw new Error("no checkpoints"); },
  capture: async () => {}, materialize: async () => {}, inherit: () => {}, forget: async () => {}, close: () => {},
};

export const PROJECT = "demo";

export interface SetupOptions extends SessionsOptions {
  harness?: FakeHarnessOptions;
  agents?: ProjectAgent[];
  gitBranch?: string | null;
  /** Statements to run before the service is created (e.g. rows for boot recovery). */
  before?: (deps: ReturnType<typeof testDeps>) => void;
  harnesses?: Harnesses;
  projectsRescanMs?: number;
  /** Use the real checkpoints service (a shadow git store under the temp home). Default: a no-op. */
  checkpoints?: boolean;
}

export function setup(o: SetupOptions = {}) {
  const harness: FakeHarness = fakeHarness(o.harness);
  const deps = testDeps({ harnesses: o.harnesses ?? { claude: harness } });
  if (o.projectsRescanMs !== undefined) deps.config.projectsRescanMs = o.projectsRescanMs;
  const projectPath = join(deps.config.home, "..", "repo");
  mkdirSync(projectPath, { recursive: true });
  const at = "2026-10-01T00:00:00Z";
  deps.db.prepare("INSERT INTO projects (name, path, created_at, updated_at) VALUES (?, ?, ?, ?)").run(PROJECT, projectPath, at, at);
  o.before?.(deps);

  const settings: ProjectSettings = { title: PROJECT, description: "", repo: null, defaultBranch: "main", commands: {} };
  const ref: ProjectRef = { name: PROJECT, path: projectPath, settings, manifestError: null, missing: false };
  const worktrees: { name: string; branch: string }[] = [];
  const projects = {
    list: () => [ref],
    get: (name: string) => (name === PROJECT ? ref : null),
    detail: (name: string) => (name === PROJECT ? ({ git: { branch: o.gitBranch === undefined ? "main" : o.gitBranch, headSha: null, dirty: false, ahead: 0, behind: 0 } } as never) : null),
    agents: (name: string) => (name === PROJECT ? (o.agents ?? []) : []),
    resolveCwd: () => null,
    noteWritten: () => {},
    async createWorktree(name: string, branch: string) {
      worktrees.push({ name, branch });
      const path = join(deps.config.worktreesDir, name, branch.replace(/\//g, "-"));
      mkdirSync(path, { recursive: true });
      return { path, branch };
    },
    close: () => {},
  } as unknown as ProjectsService;

  const harnessEvents: { id: string; event: HarnessEvent }[] = [];
  const baselines: { id: string; parent: string }[] = [];
  const refreshed: string[] = [];
  const services = stubServices({});
  services.projects = projects;
  services.settings = { get: () => ({ ...DEFAULT_APP_SETTINGS }), update: () => ({ ...DEFAULT_APP_SETTINGS }), pricing: () => ({}), savePricing: () => {} };
  services.ingest = {
    ingest: () => ({ accepted: 0, duplicates: 0, rejected: [] }) as never,
    recordHarnessEvent: (id, event) => void harnessEvents.push({ id, event }),
    recordBaseline: (id, parent) => void baselines.push({ id, parent }),
    replaceHistory: () => {},
  };
  services.metrics = { query: () => [], activity: async () => ({ days: [] }), sessionsPerDay: () => [], refreshOutput: async (id) => void refreshed.push(id), close: () => {} };
  services.artifacts = { forSession: () => [], hostTools: () => [], get: () => null, html: () => null } as unknown as Services["artifacts"];
  services.library = createLibraryService(deps, services);
  services.launch = createLaunchService(deps, services);
  services.agentContext = createAgentContextService(deps, services);
  services.notebooks = createNotebooksService(deps, services);
  services.checkpoints = o.checkpoints ? createCheckpointsService(deps, services) : noopCheckpoints;
  services.sessions = createSessionsService(deps, services, o);
  return { deps, harness, services, sessions: services.sessions, projectPath, worktrees, harnessEvents, baselines, refreshed };
}

/** The sessions routes and /api/events on a random port, over a setup(). */
export async function serve(s: ReturnType<typeof setup>) {
  const router = new Router();
  registerSessionsRoutes(router, s.deps, s.services);
  const hub = new SseHub(s.deps.bus, 60_000);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/api/events") return hub.handle(req, res);
      const m = router.match(req.method ?? "GET", url.pathname);
      if (m.kind !== "found") return sendError(res, 404, "not found");
      const result = await m.handler({ req, res, url, params: m.params });
      if (!res.headersSent) send(res, result === undefined ? 204 : 200, result ?? undefined);
    } catch (err) {
      if (err instanceof HttpError) return sendError(res, err.status, err.message);
      console.error(err);
      sendError(res, 500, "internal error");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  return {
    base,
    api,
    post: (path: string, body?: unknown) => api(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
    async close() {
      hub.close();
      await s.sessions.close();
      await new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      });
    },
  };
}

export { waitFor } from "../test-helpers.ts";
