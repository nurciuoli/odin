// /api/secrets (docs/contracts.md#secrets). Values go in, never out.
import { HttpError, readJson } from "../http/util.ts";
import type { RegisterRoutes } from "../services.ts";

export const registerSecretsRoutes: RegisterRoutes = (router, _deps, services) => {
  router.get("/api/secrets", () => services.secrets.list());

  router.put("/api/secrets/:name", async ({ req, params }) => {
    const body = await readJson(req);
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.value !== "string") throw new HttpError(400, "expected { value: string }");
    return services.secrets.put(params.name!, body.value);
  });

  router.delete("/api/secrets/:name", ({ params }) => {
    services.secrets.remove(params.name!);
  });
};
