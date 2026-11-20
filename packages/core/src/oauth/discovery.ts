// OAuth discovery for remote MCP servers (MCP authorization spec: RFC 9728 protected-resource metadata, RFC 8414
// authorization-server metadata, RFC 7591 dynamic client registration). Network access goes through the injected fetch.
import { HttpError } from "../http/util.ts";

export interface AuthServer {
  /** The resource the token is for (RFC 8707): the protected-resource metadata's `resource`, else the MCP url. */
  resource: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  /** Scopes the protected resource says it supports. Empty when it lists none. */
  scopes: string[];
}

const MAX_BODY = 256 * 1024;
const TIMEOUT_MS = 10_000;

const isLoopback = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "[::1]";

/** https, or http to loopback (local dev servers). Anything else is refused: tokens never travel in clear text. */
export function safeUrl(value: unknown, what: string): URL {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw new HttpError(502, `${what} is not a URL`);
  }
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname)))) {
    throw new HttpError(502, `${what} must be https (or http on localhost)`);
  }
  return url;
}

export interface Fetcher {
  (url: string, init?: RequestInit): Promise<Response>;
}

/** fetch with a timeout, no redirects (a redirect could leave the vetted host), and a body cap. */
export function limited(fetchFn: typeof fetch): Fetcher {
  return (url, init) => fetchFn(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
}

async function jsonBody(res: Response, what: string): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (text.length > MAX_BODY) throw new HttpError(502, `${what} response is too large`);
  try {
    const doc = JSON.parse(text);
    if (doc && typeof doc === "object" && !Array.isArray(doc)) return doc as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new HttpError(502, `${what} response is not a JSON object`);
}

async function tryJson(fetcher: Fetcher, url: string, what: string): Promise<Record<string, unknown> | null> {
  let res: Response;
  try {
    res = await fetcher(url, { headers: { accept: "application/json" } });
  } catch {
    return null;
  }
  return res.ok ? jsonBody(res, what) : null;
}

/** `resource_metadata="…"` from a WWW-Authenticate header. */
export function resourceMetadataUrl(header: string | null): string | null {
  return header ? /resource_metadata="([^"]+)"/.exec(header)?.[1] ?? null : null;
}

const withPath = (origin: string, wellKnown: string, path: string) => `${origin}/.well-known/${wellKnown}${path === "/" ? "" : path}`;

export async function discover(fetcher: Fetcher, mcpUrl: string): Promise<AuthServer> {
  const mcp = safeUrl(mcpUrl, "the MCP server url");
  let prmUrl: string | null = null;
  try {
    const probe = await fetcher(mcp.href, { method: "GET", headers: { accept: "text/event-stream, application/json" } });
    if (probe.status === 401) prmUrl = resourceMetadataUrl(probe.headers.get("www-authenticate"));
    await probe.body?.cancel().catch(() => {});
  } catch {
    // an unreachable probe falls back to the well-known paths
  }
  const prm =
    (prmUrl ? await tryJson(fetcher, safeUrl(prmUrl, "the resource metadata url").href, "resource metadata") : null) ??
    (await tryJson(fetcher, withPath(mcp.origin, "oauth-protected-resource", mcp.pathname), "resource metadata")) ??
    (await tryJson(fetcher, withPath(mcp.origin, "oauth-protected-resource", "/"), "resource metadata"));
  const servers = Array.isArray(prm?.authorization_servers) ? prm.authorization_servers.filter((x): x is string => typeof x === "string") : [];
  const issuerUrl = safeUrl(servers[0] ?? mcp.origin, "the authorization server");
  const issuerOrigin = issuerUrl.origin;
  const issuerPath = issuerUrl.pathname === "/" ? "/" : issuerUrl.pathname.replace(/\/$/, "");
  const meta =
    (await tryJson(fetcher, withPath(issuerOrigin, "oauth-authorization-server", issuerPath), "authorization server metadata")) ??
    (await tryJson(fetcher, withPath(issuerOrigin, "openid-configuration", issuerPath), "authorization server metadata")) ??
    (await tryJson(fetcher, `${issuerUrl.href.replace(/\/$/, "")}/.well-known/openid-configuration`, "authorization server metadata"));
  if (!meta) throw new HttpError(502, "the server does not publish OAuth metadata");
  const methods = meta.code_challenge_methods_supported;
  if (Array.isArray(methods) && !methods.includes("S256")) throw new HttpError(502, "the authorization server does not support PKCE (S256)");
  const endpoint = (key: string, required: boolean): string | null => {
    const v = meta[key];
    if (v === undefined && !required) return null;
    return safeUrl(v, `the ${key.replace(/_/g, " ")}`).href;
  };
  const scopes = Array.isArray(prm?.scopes_supported)
    ? prm.scopes_supported.filter((s): s is string => typeof s === "string" && !!s.trim() && !/\s/.test(s))
    : [];
  return {
    resource: typeof prm?.resource === "string" && prm.resource ? prm.resource : mcp.href,
    issuer: typeof meta.issuer === "string" ? meta.issuer : issuerUrl.origin,
    authorizationEndpoint: endpoint("authorization_endpoint", true)!,
    tokenEndpoint: endpoint("token_endpoint", true)!,
    registrationEndpoint: endpoint("registration_endpoint", false),
    scopes,
  };
}

export interface RegisteredClient {
  clientId: string;
  clientSecret: string | null;
}

/** RFC 7591: a public PKCE client named Odin for this redirect URI. */
export async function registerClient(fetcher: Fetcher, endpoint: string, redirectUri: string): Promise<RegisteredClient> {
  const res = await fetcher(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "Odin",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!res.ok) throw new HttpError(502, `client registration was refused (${res.status})`);
  const doc = await jsonBody(res, "client registration");
  if (typeof doc.client_id !== "string" || !doc.client_id) throw new HttpError(502, "client registration returned no client_id");
  return { clientId: doc.client_id, clientSecret: typeof doc.client_secret === "string" && doc.client_secret ? doc.client_secret : null };
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms, or null when the server gave no lifetime. */
  expiresAt: number | null;
  scope: string | null;
}

/** POST to the token endpoint. An OAuth error becomes `{ error }` with the code only: descriptions can echo input. */
export async function tokenRequest(fetcher: Fetcher, endpoint: string, form: Record<string, string>, now: number): Promise<TokenSet | { error: string }> {
  const res = await fetcher(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
  let doc: Record<string, unknown>;
  try {
    doc = await jsonBody(res, "token");
  } catch (err) {
    if (res.ok) throw err;
    return { error: `http_${res.status}` };
  }
  if (!res.ok || typeof doc.error === "string") return { error: typeof doc.error === "string" && /^[a-z_]{1,40}$/.test(doc.error) ? doc.error : `http_${res.status}` };
  if (typeof doc.access_token !== "string" || !doc.access_token) throw new HttpError(502, "the token response has no access_token");
  if (typeof doc.token_type === "string" && doc.token_type.toLowerCase() !== "bearer") throw new HttpError(502, "the server issued a token type Odin cannot send");
  const lifetime = typeof doc.expires_in === "number" && Number.isFinite(doc.expires_in) && doc.expires_in > 0 ? doc.expires_in : null;
  return {
    accessToken: doc.access_token,
    refreshToken: typeof doc.refresh_token === "string" && doc.refresh_token ? doc.refresh_token : null,
    expiresAt: lifetime === null ? null : now + lifetime * 1000,
    scope: typeof doc.scope === "string" && doc.scope ? doc.scope : null,
  };
}
