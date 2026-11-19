// odin-core: HTTP API + SSE, static web app, SQLite, sessions on the harness drivers, library, GitHub sync.
// createApp() wires it; index.ts boots it for real.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type Config } from "./config.ts";
import { openDb } from "./db/db.ts";
import { EventBus } from "./events.ts";
import { apiRouter } from "./http/api.ts";
import { hostOk, loginOk, originOk } from "./http/auth.ts";
import { SseHub } from "./http/sse.ts";
import { serveStatic } from "./http/static.ts";
import { HttpError, send, sendError } from "./http/util.ts";
import type { Deps, Services } from "./services.ts";
import type { Harnesses } from "./harness/types.ts";
import { createClaudeHarness } from "./harness/claude/driver.ts";
import { createCodexHarness } from "./harness/codex/driver.ts";
import { createGrokHarness } from "./harness/grok/driver.ts";
import { createOpenCodeHarness } from "./harness/opencode/driver.ts";
import { createOpenCodeRuntime } from "./harness/opencode/runtime.ts";
import { adaptOpenCodeLibrary } from "./harness/opencode/library.ts";
import { createAntigravityHarness } from "./harness/antigravity/driver.ts";
import { createAgentContextService } from "./context/agent-context.ts";
import { adaptLibrary } from "./harness/codex/library.ts";
import { demoScript, fakeHarness } from "./harness/fake.ts";
import { createProjectsService } from "./projects/service.ts";
import { createSessionsService } from "./sessions/service.ts";
import { createLaunchService } from "./launch/service.ts";
import { createArtifactsService } from "./artifacts/service.ts";
import { createLibraryService } from "./library/service.ts";
import { createSyncService } from "./sync/service.ts";
import { createIngestService } from "./ingest/service.ts";
import { createMetricsService } from "./metrics/service.ts";
import { createMcpOAuthService } from "./oauth/service.ts";
import { createSecretsService } from "./secrets/service.ts";
import { createSettingsService } from "./settings/service.ts";
import { getToolPathSource, setToolPathSource } from "./tools/resolve.ts";
import { createFilesService } from "./files/service.ts";
import { createCheckpointsService } from "./checkpoints/service.ts";
import { createNotebooksService } from "./notebooks/service.ts";

export interface AppOptions {
  config: Config;
  githubFetch?: typeof fetch;
  mcpFetch?: typeof fetch;
  now?: () => Date;
  heartbeatMs?: number;
  /** Harness drivers; tests pass { claude: fakeHarness() }. Default: the Claude driver (or the fake one with ODIN_FAKE_HARNESS=1). */
  harnesses?: Harnesses;
}

export interface App {
  deps: Deps;
  services: Services;
  server: Server;
  hub: SseHub;
  listen(): Promise<AddressInfo>;
  close(): Promise<void>;
}

export function createApp(options: AppOptions): App {
  const { config } = options;
  const db = openDb(config.dbPath);
  const bus = new EventBus();
  const services = {} as Services;
  const prepareCodex: NonNullable<Parameters<typeof createCodexHarness>[0]['prepare']> = (opts, nativePath) => {
    const session = db.prepare("SELECT project FROM sessions WHERE id = ?").get(opts.sessionId ?? opts.resume ?? "") as { project: string } | undefined;
    if (!session) throw new Error("Codex session record is missing");
    return adaptLibrary(services, config.home, session.project, opts, nativePath);
  };
  const deps: Deps = {
    config,
    db,
    bus,
    githubFetch: options.githubFetch ?? fetch,
    mcpFetch: options.mcpFetch ?? fetch,
    now: options.now ?? (() => new Date()),
    harnesses: options.harnesses ?? (config.fakeHarness ? {
      claude: fakeHarness({ script: demoScript }),
      codex: { ...fakeHarness({ script: demoScript }), id: "codex", name: "Codex (fake)" },
      grok: { ...fakeHarness({ script: demoScript }), id: "grok", name: "Grok (fake)" },
      opencode: { ...fakeHarness({ script: demoScript }), id: "opencode", name: "OpenCode (fake)" },
      antigravity: { ...fakeHarness({ script: demoScript }), id: "antigravity", name: "Antigravity (fake)" },
    } : {
      claude: createClaudeHarness(),
      codex: createCodexHarness({ db, prepare: prepareCodex }),
      grok: createGrokHarness({ db }),
      antigravity: createAntigravityHarness({ db }),
      opencode: createOpenCodeHarness({ db, runtime: () => createOpenCodeRuntime({ home: config.home, projectLibrary: (opts) => {
        const session = db.prepare("SELECT project FROM sessions WHERE id = ?").get(opts.sessionId ?? opts.resume ?? "") as { project: string } | undefined;
        if (!session) throw new Error("OpenCode session record is missing");
        return adaptOpenCodeLibrary(services, config.home, session.project, opts);
      } }) }),
    }),
  };
  // Every factory gets the same `services` object; it's complete before any request or timer runs (see services.ts).
  services.settings = createSettingsService(deps, services);
  // Tool paths are read on every lookup, so a Settings change applies on the next start or check.
  const toolPaths = () => services.settings.get().toolPaths;
  setToolPathSource(toolPaths);
  services.projects = createProjectsService(deps, services);
  services.sync = createSyncService(deps, services);
  services.library = createLibraryService(deps, services);
  services.artifacts = createArtifactsService(deps, services);
  services.secrets = createSecretsService(deps, services);
  services.mcpOAuth = createMcpOAuthService(deps, services);
  services.launch = createLaunchService(deps, services);
  services.agentContext = createAgentContextService(deps, services);
  services.ingest = createIngestService(deps, services);
  services.metrics = createMetricsService(deps, services);
  services.checkpoints = createCheckpointsService(deps, services);
  services.sessions = createSessionsService(deps, services);
  services.files = createFilesService(deps, services);
  services.notebooks = createNotebooksService(deps, services);

  const router = apiRouter(deps, services);
  const hub = new SseHub(bus, options.heartbeatMs);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (!hostOk(req, config.extraHosts)) return sendError(res, 421, "unexpected host");
      // Ingest has its own token and health carries nothing private; both are called over loopback with no login.
      const open = (req.method === "POST" && url.pathname === "/api/ingest") || (req.method === "GET" && url.pathname === "/api/health");
      if (!open && !loginOk(req, config.allowedLogin)) return sendError(res, 401, "unauthorized");
      if (url.pathname === "/api/events") return hub.handle(req, res);
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/a/")) {
        if (req.method !== "GET" && req.method !== "HEAD" && !originOk(req, config.extraHosts)) return sendError(res, 403, "cross-origin request");
        const m = router.match(req.method ?? "GET", url.pathname);
        if (m.kind === "not_found") return sendError(res, 404, "not found");
        if (m.kind === "method_not_allowed") {
          res.setHeader("allow", m.allow.join(", "));
          return sendError(res, 405, "method not allowed");
        }
        const result = await m.handler({ req, res, url, params: m.params });
        if (!res.headersSent && !res.writableEnded) send(res, result === undefined ? 204 : 200, result ?? undefined);
        return;
      }
      serveStatic(req, res, config.webDist, url.pathname);
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) return sendError(res, err.status, err.message);
      console.error(`${req.method} ${url.pathname} failed:`, err);
      sendError(res, 500, "internal error");
    }
  });

  return {
    deps,
    services,
    server,
    hub,
    listen: () =>
      new Promise((resolve) => server.listen(config.port, config.host, () => resolve(server.address() as AddressInfo))),
    async close() {
      hub.close();
      for (const s of [services.sessions, services.notebooks, services.metrics, services.library, services.sync, services.projects]) await s.close();
      for (const harness of Object.values(deps.harnesses)) await harness.close?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      // Only clear the source if a later app has not replaced it.
      if (getToolPathSource() === toolPaths) setToolPathSource(null);
      db.close();
    },
  };
}
