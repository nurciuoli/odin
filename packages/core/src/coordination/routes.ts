// Coordination routes (docs/plans/project-coordinator.md, docs/contracts.md#coordination).
import type { IncomingMessage } from "node:http";
import type { StartCoordinatorRequest } from "@odin/shared/api";
import { HttpError, readJson } from "../http/util.ts";
import type { RegisterRoutes } from "../services.ts";

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const b = await readJson(req);
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "expected a JSON object");
  return b as Record<string, unknown>;
}

function pathParam(url: URL): string {
  const path = url.searchParams.get("path");
  if (!path) throw new HttpError(400, "path is required");
  return path;
}

export const registerCoordinationRoutes: RegisterRoutes = (router, _deps, services) => {
  router.post("/api/projects/:name/coordinators", async ({ req, params }) =>
    services.coordination.startCoordinator(params.name, (await body(req)) as StartCoordinatorRequest));

  router.get("/api/projects/:name/threads", ({ params }) => services.coordination.threads(params.name));

  router.get("/api/projects/:name/brief", ({ params }) => services.coordination.brief(params.name));

  router.put("/api/projects/:name/brief", async ({ req, params }) =>
    services.coordination.updateBrief(params.name, (await body(req)).instructions as string));

  router.get("/api/projects/:name/memory", ({ url, params }) => services.coordination.readMemory(params.name, pathParam(url)));

  router.put("/api/projects/:name/memory", async ({ req, params }) => {
    const b = await body(req);
    if (typeof b.path !== "string") throw new HttpError(400, "path is required");
    return services.coordination.writeMemory(params.name, b.path, b.content as string);
  });

  router.delete("/api/projects/:name/memory", ({ url, params }) => {
    services.coordination.deleteMemory(params.name, pathParam(url));
  });
};
