// POST /api/projects/:name/sync: read PRs, then answer (docs/contracts.md#rest).
import { HttpError } from "../http/util.ts";
import type { RegisterRoutes } from "../services.ts";

export const registerSyncRoutes: RegisterRoutes = (router, _deps, services) => {
  router.post("/api/projects/:name/sync", async ({ params }) => {
    const name = params.name!;
    if (!services.projects.get(name)) throw new HttpError(404, `unknown project ${name}`);
    if (services.sync.status(name).state === "off") throw new HttpError(409, "GitHub sync is off for this project (no repo or no token)");
    await services.sync.syncNow(name);
    const after = services.sync.status(name);
    // The message is already scrubbed of the token (sync builds it that way).
    if (after.state === "error") throw new HttpError(502, after.error ?? "GitHub sync failed");
    return undefined;
  });
};
