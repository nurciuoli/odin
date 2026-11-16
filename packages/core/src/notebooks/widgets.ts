import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RegisterRoutes } from "../services.ts";
import { HttpError } from "../http/util.ts";

/** A single locally bundled widget manager. No remote scripts or arbitrary model modules are loaded. */
export const registerNotebookWidgetRoutes: RegisterRoutes = (router, deps, services) => {
  router.get("/a/widget-runtime.js", ({ res }) => {
    let script: Buffer;
    try { script = readFileSync(join(deps.config.webDist, "widget-runtime.js")); }
    catch { throw new HttpError(503, "Widget runtime is unavailable; build the web app first"); }
    res.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "x-content-type-options": "nosniff", "cross-origin-resource-policy": "cross-origin", "cache-control": "no-cache" }).end(script);
  });
  router.get("/a/notebook-widgets/:id/:modelId", ({ params, res }) => {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(params.id) || !/^[A-Za-z0-9_-]{1,100}$/.test(params.modelId)) throw new HttpError(404, "unknown widget");
    services.notebooks.snapshot(params.id);
    const nonce = randomBytes(18).toString("base64");
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Notebook widget</title></head><body><div id="odin-widget-root" role="status">Loading widget…</div><script nonce="${nonce}" src="/a/widget-runtime.js"></script></body></html>`;
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts allow-forms`,
      "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin", "referrer-policy": "no-referrer", "cache-control": "no-store",
    }).end(html);
  });
};
