// Artifact routes (docs/contracts.md#rest, #artifacts): detail and submit under /api, and the sandboxed pages under /a/.
import type { ArtifactSubmitRequest } from "@odin/shared/api";
import { HttpError, readJson } from "../http/util.ts";
import type { RegisterRoutes } from "../services.ts";
import { bridgeScript, injectBridge, loadTheme } from "./bridge.ts";

/**
 * The exact policy from docs/contracts.md#artifacts. No connect-src: an artifact can't fetch anything. The `sandbox`
 * directive keeps the page in an opaque origin even when it's opened in its own tab, outside the app's iframe.
 */
export const ARTIFACT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; " +
  "form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts allow-forms";

export const ARTIFACT_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": ARTIFACT_CSP,
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

/** Ids in paths: digits only, no sign, no leading zero, no exponent. Anything else is a 404. */
function pathId(raw: string | undefined): number | null {
  if (!raw || !/^[1-9][0-9]{0,15}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

export const registerArtifactsRoutes: RegisterRoutes = (router, deps, services) => {
  router.get("/api/artifacts/:id", ({ params }) => {
    const id = pathId(params.id);
    const detail = id === null ? null : services.artifacts.get(id);
    if (!detail) throw new HttpError(404, `unknown artifact ${params.id}`);
    return detail;
  });

  router.get("/api/projects/:name/artifacts", ({ url, params }) => {
    const raw = url.searchParams.get("limit");
    let limit: number | undefined;
    if (raw !== null && raw !== "") {
      limit = pathId(raw) ?? undefined;
      if (limit === undefined) throw new HttpError(400, "limit must be a positive integer");
    }
    if (!services.projects.get(params.name)) throw new HttpError(404, `unknown project ${params.name}`);
    return services.artifacts.forProject(params.name, limit);
  });

  router.post("/api/artifacts/:id/submit", async ({ req, params }) => {
    const id = pathId(params.id);
    if (id === null) throw new HttpError(404, `unknown artifact ${params.id}`);
    const body = (await readJson(req)) as ArtifactSubmitRequest;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "expected a JSON object");
    return services.artifacts.submit(id, body);
  });

  // Untrusted, agent-written HTML. It only ever renders inside <iframe sandbox="allow-scripts allow-forms"> (an
  // opaque origin), and the CSP blocks every fetch, form post and external load.
  router.get("/a/:id/:version", ({ res, params }) => {
    const id = pathId(params.id), version = pathId(params.version);
    const html = id !== null && version !== null ? services.artifacts.html(id, version) : null;
    if (html === null) throw new HttpError(404, "unknown artifact version");
    const page = injectBridge(html, bridgeScript(id!, version!, loadTheme(deps.config.artifactThemePath)));
    res.writeHead(200, { ...ARTIFACT_HEADERS, "content-length": Buffer.byteLength(page) }).end(page);
  });
};
