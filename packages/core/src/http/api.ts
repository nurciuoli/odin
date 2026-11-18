// Every /api route. Modules register their own here, in a fixed order; this file only adds the ones that span modules.
import { Router } from "./router.ts";
import type { Deps, Services } from "../services.ts";
import { registerProjectsRoutes } from "../projects/routes.ts";
import { registerSessionsRoutes } from "../sessions/routes.ts";
import { registerArtifactsRoutes } from "../artifacts/routes.ts";
import { registerArtifactPrintRoutes } from "../artifacts/print.ts";
import { registerLibraryRoutes } from "../library/routes.ts";
import { registerSyncRoutes } from "../sync/routes.ts";
import { registerIngestRoutes } from "../ingest/routes.ts";
import { registerTrackingRoutes } from "../tracking/routes.ts";
import { registerMetricsRoutes } from "../metrics/routes.ts";
import { registerSettingsRoutes } from "../settings/routes.ts";
import { registerFilesRoutes } from "../files/routes.ts";
import { registerNotebookRoutes } from "../notebooks/routes.ts";
import { registerNotebookOutputRoutes } from "../notebooks/output.ts";
import { registerNotebookEnvironmentRoutes } from "../notebooks/environment-routes.ts";
import { registerNotebookWidgetRoutes } from "../notebooks/widgets.ts";
import { registerCoordinationRoutes } from "../coordination/routes.ts";

export const VERSION = "2.0.0-dev";

export function apiRouter(deps: Deps, services: Services): Router {
  const router = new Router();
  router.get("/api/health", () => ({
    ok: true,
    app: "odin",
    version: VERSION,
    instance: deps.config.instance,
    now: deps.now().toISOString(),
  }));
  for (const register of [
    registerProjectsRoutes,
    registerSessionsRoutes,
    registerCoordinationRoutes,
    registerFilesRoutes,
    registerNotebookRoutes,
    registerNotebookOutputRoutes,
    registerNotebookEnvironmentRoutes,
    registerNotebookWidgetRoutes,
    registerArtifactsRoutes,
    registerArtifactPrintRoutes,
    registerLibraryRoutes,
    registerSyncRoutes,
    registerIngestRoutes,
    registerTrackingRoutes,
    registerMetricsRoutes,
    registerSettingsRoutes,
  ]) {
    register(router, deps, services);
  }
  return router;
}
