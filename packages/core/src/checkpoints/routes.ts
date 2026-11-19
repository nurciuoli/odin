// checkpoints routes: /api/sessions/:id/checkpoints… docs/contracts.md#checkpoints.
import { HttpError, readJson } from "../http/util.ts";
import type { RegisterRoutes } from "../services.ts";

export const registerCheckpointsRoutes: RegisterRoutes = (router, _deps, services) => {
  const { checkpoints } = services;
  router.get("/api/sessions/:id/checkpoints", ({ params }) => checkpoints.list(params.id!));
  router.get("/api/sessions/:id/checkpoints/:cid/diff", ({ params, url }) => {
    const against = url.searchParams.get("against") ?? "turn";
    if (against !== "turn" && against !== "current") throw new HttpError(400, "against must be turn or current");
    return checkpoints.diff(params.id!, params.cid!, against);
  });
  router.post("/api/sessions/:id/checkpoints/:cid/restore", async ({ req, params }) => checkpoints.restore(params.id!, params.cid!, await readJson(req)));
};
