// A tiny path router: "/api/threads/:id/messages" style patterns, exact segment counts.
import type { IncomingMessage, ServerResponse } from "node:http";

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
}

export type Handler = (ctx: RequestContext) => unknown | Promise<unknown>;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

export type Match =
  | { kind: "found"; handler: Handler; params: Record<string, string> }
  | { kind: "method_not_allowed"; allow: string[] }
  | { kind: "not_found" };

function split(path: string): string[] {
  return path.split("/").filter(Boolean);
}

export class Router {
  #routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    this.#routes.push({ method: method.toUpperCase(), segments: split(pattern), handler });
    return this;
  }

  get(pattern: string, handler: Handler) { return this.add("GET", pattern, handler); }
  post(pattern: string, handler: Handler) { return this.add("POST", pattern, handler); }
  patch(pattern: string, handler: Handler) { return this.add("PATCH", pattern, handler); }
  put(pattern: string, handler: Handler) { return this.add("PUT", pattern, handler); }
  delete(pattern: string, handler: Handler) { return this.add("DELETE", pattern, handler); }

  match(method: string, pathname: string): Match {
    const parts = split(pathname);
    const allow: string[] = [];
    for (const route of this.#routes) {
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const seg = route.segments[i];
        if (seg.startsWith(":")) {
          try {
            params[seg.slice(1)] = decodeURIComponent(parts[i]);
          } catch {
            ok = false;
            break;
          }
        } else if (seg !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (route.method === method || (method === "HEAD" && route.method === "GET")) return { kind: "found", handler: route.handler, params };
      allow.push(route.method);
    }
    return allow.length ? { kind: "method_not_allowed", allow } : { kind: "not_found" };
  }
}
