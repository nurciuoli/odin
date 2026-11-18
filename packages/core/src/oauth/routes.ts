// /api/mcp/:id/oauth and the sign-in callback (docs/contracts.md#mcp-oauth).
import { ASSET_ID_PATTERN } from "@odin/shared/library";
import { HttpError, readJson } from "../http/util.ts";
import type { RegisterRoutes } from "../services.ts";

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, message: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>` +
    `<body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1 style="font-size:1.25rem">${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
}

export const registerOAuthRoutes: RegisterRoutes = (router, _deps, services) => {
  const idOf = (id: string | undefined) => {
    if (!id || !ASSET_ID_PATTERN.test(id)) throw new HttpError(400, "invalid MCP server id");
    return id;
  };

  router.get("/api/mcp/:id/oauth", ({ params }) => services.mcpOAuth.status(idOf(params.id)));

  router.post("/api/mcp/:id/oauth/start", async ({ req, params }) => {
    const body = await readJson(req);
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.origin !== "string") throw new HttpError(400, "expected { origin: string }");
    return services.mcpOAuth.start(idOf(params.id), body.origin);
  });

  router.delete("/api/mcp/:id/oauth", ({ params }) => {
    services.mcpOAuth.disconnect(idOf(params.id));
  });

  // The browser lands here from the authorization server. It carries a one-time code in the URL, so the page
  // says nothing but the outcome, is never cached, and sends no Referer anywhere.
  router.get("/api/oauth/callback", async ({ res, url }) => {
    const headers = {
      "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'", "x-content-type-options": "nosniff",
    };
    const q = url.searchParams;
    try {
      const { id } = await services.mcpOAuth.complete({ state: q.get("state") ?? undefined, code: q.get("code") ?? undefined, error: q.get("error") ?? undefined });
      res.writeHead(200, headers).end(page("Connected", `MCP server ${id} is signed in. You can close this tab and return to Odin.`));
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      res.writeHead(status, headers).end(page("Sign-in did not finish", err instanceof HttpError ? err.message : "Something went wrong. Try again from Odin."));
    }
  });
};
