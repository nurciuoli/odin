// POST /api/ingest (docs/contracts.md#ingest). Token-authenticated; the web app never calls it.
import { INGEST_MAX_BATCH } from "@odin/shared/ingest";
import { ingestAuthorized } from "../http/auth.ts";
import { HttpError, readJson } from "../http/util.ts";
import type { RegisterRoutes } from "../services.ts";

const MAX_BODY = 1024 * 1024;

export const registerIngestRoutes: RegisterRoutes = (router, deps, services) => {
  router.post("/api/ingest", async ({ req }) => {
    if (!ingestAuthorized(req, deps.config.ingestToken)) throw new HttpError(401, "missing or invalid ingest token");
    // Refuse an honest oversize body before reading it (readBody also caps chunked ones).
    if (Number(req.headers["content-length"]) > MAX_BODY) throw new HttpError(413, "request body too large");
    const body = await readJson(req);
    const events: unknown[] = Array.isArray(body) ? body : [body];
    if (events.length > INGEST_MAX_BATCH) throw new HttpError(400, `at most ${INGEST_MAX_BATCH} events per request`);
    return services.ingest.ingest(events);
  });
};
