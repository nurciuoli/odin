// Library routes (docs/contracts.md#rest, owner 2f): the library itself and its installs into projects.
import type { AssetKind } from "@odin/shared/api";
import { ASSET_ID_PATTERN, LIBRARY_KINDS } from "@odin/shared/library";
import { HttpError, readBody, readJson, send } from "../http/util.ts";
import type { RegisterRoutes } from "../services.ts";
import { MAX_ASSET_FILE_BYTES, MAX_ASSET_FILES } from "./parse.ts";

/** A save may carry up to 64 files of 1 MB each (JSON-escaped text can grow; this bounds memory, not content). */
const MAX_SAVE_BYTES = MAX_ASSET_FILES * MAX_ASSET_FILE_BYTES + 1024 * 1024;

function kindOf(raw: string | undefined | null): AssetKind {
  if (!raw || !(LIBRARY_KINDS as string[]).includes(raw)) throw new HttpError(400, `unknown asset kind ${JSON.stringify(raw)}`);
  return raw as AssetKind;
}

function idOf(raw: string | undefined): string {
  if (!raw || !ASSET_ID_PATTERN.test(raw)) throw new HttpError(400, `invalid asset id ${JSON.stringify(raw)}`);
  return raw;
}

export const registerLibraryRoutes: RegisterRoutes = (router, _deps, services) => {
  router.get("/api/library", ({ url }) => {
    const kind = url.searchParams.get("kind");
    return services.library.list(kind ? kindOf(kind) : undefined);
  });

  router.post("/api/library/rescan", () => {
    services.library.rescan();
  });

  router.get("/api/library/:kind/:id", ({ params }) => {
    const kind = kindOf(params.kind), id = idOf(params.id);
    const detail = services.library.detail(kind, id);
    if (!detail) throw new HttpError(404, `no ${kind} "${id}" in the library`);
    return detail;
  });

  router.get("/api/library/:kind/:id/versions/:version", ({ params }) => {
    const kind = kindOf(params.kind), id = idOf(params.id);
    const files = services.library.files(kind, id, params.version!);
    if (!files) throw new HttpError(404, `no version ${params.version} of ${kind} "${id}"`);
    return files;
  });

  router.put("/api/library/:kind/:id", async ({ req, res, params }) => {
    const kind = kindOf(params.kind), id = idOf(params.id);
    const raw = (await readBody(req, MAX_SAVE_BYTES)).toString("utf8");
    let body: unknown;
    try {
      body = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      throw new HttpError(400, "invalid JSON body");
    }
    const files = (body as { files?: unknown } | null)?.files;
    if (!files || typeof files !== "object" || Array.isArray(files)) throw new HttpError(400, "expected { files: { <path>: <text> } }");
    const existed = services.library.get(kind, id) !== null;
    const asset = services.library.save(kind, id, files as Record<string, string>);
    send(res, existed ? 200 : 201, asset);
  });

  router.delete("/api/library/:kind/:id", ({ params }) => {
    const kind = kindOf(params.kind), id = idOf(params.id);
    services.library.remove(kind, id);
  });

  router.get("/api/projects/:name/library", ({ params }) => services.library.installations(params.name!));

  router.post("/api/projects/:name/library", async ({ req, params }) => {
    const body = await readJson(req);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "expected { kind, id, action }");
    kindOf(body.kind);
    idOf(body.id);
    if (body.force !== undefined && typeof body.force !== "boolean") throw new HttpError(400, "force must be true or false");
    return services.library.install(params.name!, { kind: body.kind, id: body.id, action: body.action, force: body.force, confirm: body.confirm });
  });

  router.get("/api/projects/:name/library/:kind/:id/files", ({ params }) => {
    const kind = kindOf(params.kind), id = idOf(params.id);
    const files = services.library.projectFiles(params.name!, kind, id);
    if (!files) throw new HttpError(404, `${kind} "${id}" isn't in project "${params.name}"`);
    return files;
  });
};
