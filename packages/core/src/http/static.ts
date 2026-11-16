// Serves packages/web/dist with an SPA fallback. Hashed assets are immutable; index.html is never cached.
import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const NOT_BUILT = `<!doctype html><meta charset="utf-8"><title>Odin</title>
<body style="font-family:system-ui;padding:2rem;background:#111;color:#ddd">
<h1>Odin</h1><p>The web app is not built yet. Run <code>npm run build:web</code>, or use <code>npm run dev:web</code>.</p></body>`;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function cacheControl(distDir: string, file: string, pathname: string): string {
  if (file === join(distDir, "index.html")) return "no-cache";
  // Vite puts content-hashed files under /assets/.
  if (pathname.startsWith("/assets/")) return "public, max-age=31536000, immutable";
  if (pathname === "/sw.js" || pathname.endsWith(".webmanifest")) return "no-cache";
  return "public, max-age=3600";
}

function sendFile(req: IncomingMessage, res: ServerResponse, file: string, cache: string): void {
  const st = statSync(file);
  res.writeHead(200, {
    "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    "content-length": st.size,
    "cache-control": cache,
    "x-content-type-options": "nosniff",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
}

export function serveStatic(req: IncomingMessage, res: ServerResponse, distDir: string, pathname: string): void {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" }).end();
    return;
  }
  const index = join(distDir, "index.html");
  if (!existsSync(index)) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" }).end(NOT_BUILT);
    return;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  const root = resolve(distDir);
  const file = resolve(root, "." + decoded);
  if (file !== root && !file.startsWith(root + sep)) {
    res.writeHead(404).end();
    return;
  }
  if (isFile(file)) return sendFile(req, res, file, cacheControl(root, file, decoded));
  // Missing asset files are real 404s; anything else is a client-side route.
  if (decoded.startsWith("/assets/") || (extname(decoded) && extname(decoded) !== ".html")) {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    return;
  }
  sendFile(req, res, index, "no-cache");
}
