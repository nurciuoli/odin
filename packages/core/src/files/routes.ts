import { HttpError, readBody, send } from "../http/util.ts";
import type { RegisterRoutes } from "../services.ts";
import { MAX_FILE_BYTES } from "./service.ts";

export const registerFilesRoutes: RegisterRoutes = (router, _deps, services) => {
  router.get("/api/sessions/:id/files", ({ params, url }) => services.files.list(params.id!, url.searchParams.get("path") ?? ""));
  router.get("/api/sessions/:id/files/search", ({ params, url }) => services.files.search(params.id!, url.searchParams.get("q") ?? ""));
  router.get("/api/projects/:name/files/search", ({ params, url }) => services.files.searchProject(params.name!, url.searchParams.get("q") ?? ""));
  router.get("/api/projects/:name/files/map", ({ params }) => services.files.projectMap(params.name!));
  router.get("/api/projects/:name/file", ({ params, url }) => services.files.readProject(params.name!, url.searchParams.get("path") ?? ""));
  // Managing project files: all paths are relative to the project folder (docs/contracts.md#project-file-management).
  const body = async (req: Parameters<typeof readBody>[0]) => {
    let value: unknown;
    try { value = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8")); } catch { throw new HttpError(400, "Invalid JSON body"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "A JSON object is required");
    return value as Record<string, unknown>;
  };
  const list = (v: unknown) => { if (!Array.isArray(v) || v.some((p) => typeof p !== "string")) throw new HttpError(400, "paths must be a list of text"); return v as string[]; };
  router.post("/api/projects/:name/files/rename", async ({ params, req }) => {
    const b = await body(req);
    return services.files.renameProject(params.name!, String(b.path ?? ""), String(b.name ?? ""));
  });
  router.post("/api/projects/:name/files/move", async ({ params, req }) => {
    const b = await body(req);
    return services.files.moveProject(params.name!, list(b.paths), typeof b.to === "string" ? b.to : "");
  });
  router.post("/api/projects/:name/files/duplicate", async ({ params, req, res }) => {
    const b = await body(req);
    send(res, 201, services.files.duplicateProject(params.name!, String(b.path ?? "")));
  });
  router.post("/api/projects/:name/files/trash", async ({ params, req }) => services.files.trashProject(params.name!, list((await body(req)).paths)));
  router.get("/api/projects/:name/files/trash", ({ params }) => services.files.listTrash(params.name!));
  router.post("/api/projects/:name/files/trash/:id/restore", ({ params }) => services.files.restoreTrash(params.name!, params.id!));
  router.delete("/api/projects/:name/files/trash/:id", ({ params }) => { services.files.purgeTrash(params.name!, params.id!); });
  router.delete("/api/projects/:name/files/trash", ({ params }) => { services.files.purgeTrash(params.name!); });
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
  router.post("/api/sessions/:id/files", async ({ params, req, res }) => {
    const raw = await readBody(req, MAX_FILE_BYTES * 6 + 4096);
    let body: unknown;
    try { body = JSON.parse(raw.toString("utf8")); } catch { throw new HttpError(400, "Invalid JSON body"); }
    if (!body || typeof body !== "object") throw new HttpError(400, "A file creation request is required");
    const value = body as Record<string, unknown>;
    if (typeof value.path !== "string") throw new HttpError(400, "Path is required");
    if (value.content !== undefined && typeof value.content !== "string") throw new HttpError(400, "Content must be text");
    send(res, 201, services.files.create(params.id!, value.path, value.content ?? ""));
  });
};
