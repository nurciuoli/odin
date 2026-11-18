// Odin binds 127.0.0.1 and has one user, so the web API needs no login. Two guards remain:
// - Host check on every request: a page on another origin can't reach us through DNS rebinding.
//   ODIN_EXTRA_HOSTS adds named hosts (the tailnet name Tailscale Serve forwards) and nothing else.
// - ODIN_ALLOWED_LOGIN (hosted behind Tailscale Serve): requests must carry that login in Tailscale-User-Login.
//   Serve sets the header and strips a client's own. A process on the host can still forge it over loopback,
//   so this keeps other tailnet users and devices out, not other local users.
// - The ingest token on POST /api/ingest: other local processes can't forge agent activity by accident.
import type { IncomingMessage } from "node:http";
import { tokenOk } from "./util.ts";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function allowed(name: string, extraHosts: readonly string[]): boolean {
  const host = name.toLowerCase();
  return LOCAL_HOSTS.has(host) || extraHosts.includes(host);
}

export function hostOk(req: IncomingMessage, extraHosts: readonly string[] = []): boolean {
  const host = req.headers.host;
  if (!host) return false;
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0]!;
  return allowed(name, extraHosts);
}

/** Mutating /api requests from a browser must be same-origin (Origin, when present, must be local or an extra host). */
export function originOk(req: IncomingMessage, extraHosts: readonly string[] = []): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const hostname = new URL(origin).hostname;
    return allowed(hostname, extraHosts) || hostname === "::1";
  } catch {
    return false;
  }
}

/** True when no login is required, or the request carries the allowed Tailscale login (case-insensitive). */
export function loginOk(req: IncomingMessage, allowedLogin: string): boolean {
  if (!allowedLogin) return true;
  const value = req.headers["tailscale-user-login"];
  const login = (Array.isArray(value) ? value[0] : value)?.trim().toLowerCase();
  return login === allowedLogin.toLowerCase();
}

export function ingestAuthorized(req: IncomingMessage, token: string): boolean {
  const h = req.headers.authorization ?? "";
  return h.startsWith("Bearer ") && tokenOk(h.slice(7).trim(), token);
}
