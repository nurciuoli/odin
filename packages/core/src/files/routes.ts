import { HttpError, readBody } from "../http/util.ts";
import type { RegisterRoutes } from "../services.ts";
import { MAX_FILE_BYTES } from "./service.ts";

export const registerFilesRoutes: RegisterRoutes = (router, _deps, services) => {
  router.get("/api/sessions/:id/files", ({ params, url }) => services.files.list(params.id!, url.searchParams.get("path") ?? ""));
  router.get("/api/sessions/:id/files/search", ({ params, url }) => services.files.search(params.id!, url.searchParams.get("q") ?? ""));
  router.get("/api/projects/:name/files/search", ({ params, url }) => services.files.searchProject(params.name!, url.searchParams.get("q") ?? ""));
  router.get("/api/projects/:name/files/map", ({ params }) => services.files.projectMap(params.name!));
  router.get("/api/projects/:name/file", ({ params, url }) => services.files.readProject(params.name!, url.searchParams.get("path") ?? ""));
  router.get("/api/sessions/:id/file", ({ params, url }) => services.files.read(params.id!, url.searchParams.get("path") ?? ""));
  router.put("/api/sessions/:id/file", async ({ params, req }) => {
    // JSON escaping can expand text by up to six times; the decoded content has its own 2 MiB cap.
    const raw = await readBody(req, MAX_FILE_BYTES * 6 + 4096);
    let body: unknown;
    try { body = JSON.parse(raw.toString("utf8")); } catch { throw new HttpError(400, "Invalid JSON body"); }
    if (!body || typeof body !== "object") throw new HttpError(400, "A file save request is required");
    const value = body as Record<string, unknown>;
    if (typeof value.path !== "string" || typeof value.content !== "string" || typeof value.version !== "string") throw new HttpError(400, "Path, content and version are required");
    return services.files.save(params.id!, value.path, value.content, value.version);
  });
};
