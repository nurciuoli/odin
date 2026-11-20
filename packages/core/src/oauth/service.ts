// McpOAuthService: Odin signs in to remote MCP servers (authorization code + PKCE) and keeps the tokens.
// docs/contracts.md#mcp-oauth.
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import type { McpOAuthConfig, McpOAuthDetect, McpOAuthStatus, StartMcpOAuthResponse } from "@odin/shared/api";
import { allowed } from "../http/auth.ts";
import { HttpError } from "../http/util.ts";
import type { Deps, McpOAuthService, Services } from "../services.ts";
import { discover, limited, registerClient, safeUrl, tokenRequest, type TokenSet } from "./discovery.ts";
import { createFileOAuthStore, type OAuthEntry, type OAuthStore } from "./store.ts";

export const OAUTH_CALLBACK_PATH = "/api/oauth/callback";
const PENDING_TTL_MS = 10 * 60_000;
/** A token this close to its end is refreshed before it is handed to a harness. */
const REFRESH_MARGIN_MS = 60_000;

interface Pending {
  id: string;
  verifier: string;
  entry: OAuthEntry;
  expires: number;
}

const b64url = (b: Buffer) => b.toString("base64url");

export function createMcpOAuthService(deps: Deps, services: Services, store: OAuthStore = createFileOAuthStore(join(deps.config.home, "oauth.json"))): McpOAuthService {
  const fetcher = limited(deps.mcpFetch);
  const pending = new Map<string, Pending>();
  const refreshing = new Map<string, Promise<string>>();
  const now = () => deps.now().getTime();

  const load = () => {
    try {
      return store.read();
    } catch (err) {
      throw new HttpError(500, `oauth store unreadable: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  };
  const save = (entries: Record<string, OAuthEntry>) => {
    try {
      store.write(entries);
    } catch (err) {
      throw new HttpError(500, `oauth store not writable: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  };

  /** The library spec for `id`, which must be a valid remote server with `oauth`. */
  function spec(id: string): { url: string; oauth: McpOAuthConfig } {
    const asset = services.library.get("mcp", id);
    if (!asset) throw new HttpError(404, `no library MCP server ${id}`);
    const meta = asset.meta as { type?: string; url?: unknown; oauth?: McpOAuthConfig };
    if (asset.error || (meta.type !== "http" && meta.type !== "sse") || typeof meta.url !== "string") throw new HttpError(400, `MCP server ${id} is not a valid remote server`);
    if (!meta.oauth) throw new HttpError(400, `MCP server ${id} has no oauth setting`);
    return { url: meta.url, oauth: meta.oauth };
  }

  /** The grant for `id`, or null when none exists or it was made for another url. */
  function grant(id: string, url: string): OAuthEntry | null {
    const entry = load()[id];
    return entry && entry.url === url ? entry : null;
  }

  function redirectFor(origin: string): string {
    let u: URL;
    try {
      u = new URL(origin);
    } catch {
      throw new HttpError(400, "origin must be a URL");
    }
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.origin !== origin || !allowed(u.hostname.includes(":") ? `[${u.hostname.replace(/^\[|\]$/g, "")}]` : u.hostname, deps.config.extraHosts)) {
      throw new HttpError(400, "origin must be this Odin's own address");
    }
    if (u.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) throw new HttpError(400, "origin must be https unless it is localhost");
    return `${origin}${OAUTH_CALLBACK_PATH}`;
  }

  async function refresh(id: string, entry: OAuthEntry): Promise<string> {
    const tokens = entry.tokens!;
    if (!tokens.refreshToken) throw new HttpError(400, `MCP server ${id} needs sign-in again`);
    const result = await tokenRequest(fetcher, entry.tokenEndpoint, {
      grant_type: "refresh_token", refresh_token: tokens.refreshToken, client_id: entry.clientId, resource: entry.resource,
      ...(entry.clientSecret ? { client_secret: entry.clientSecret } : {}),
    }, now());
    const entries = load();
    if ("error" in result) {
      // The grant is dead (revoked, expired). A transient server error leaves it alone.
      if (result.error === "invalid_grant" || result.error === "invalid_client") {
        if (entries[id]) { entries[id] = { ...entries[id]!, tokens: null }; save(entries); }
        throw new HttpError(400, `MCP server ${id} needs sign-in again`);
      }
      throw new HttpError(502, `could not refresh the sign-in for MCP server ${id} (${result.error})`);
    }
    const next: TokenSet = { ...result, refreshToken: result.refreshToken ?? tokens.refreshToken, scope: result.scope ?? tokens.scope };
    if (entries[id]) { entries[id] = { ...entries[id]!, tokens: next }; save(entries); }
    return next.accessToken;
  }

  return {
    async detect(url): Promise<McpOAuthDetect> {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new HttpError(400, "url must be a URL");
      }
      if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))) {
        throw new HttpError(400, "url must be https (or http on localhost)");
      }
      try {
        const found = await discover(fetcher, parsed.href);
        return { oauth: true, scopes: found.scopes };
      } catch (err) {
        if (err instanceof HttpError && err.status === 502 && /does not publish OAuth metadata/.test(err.message)) return { oauth: false, scopes: [] };
        throw err;
      }
    },

    status(id): McpOAuthStatus {
      const { url } = spec(id);
      const entry = grant(id, url);
      const t = entry?.tokens;
      const live = !!t && ((t.expiresAt === null || t.expiresAt > now()) || !!t.refreshToken);
      return { id, state: live ? "connected" : "needs-sign-in", issuer: entry?.issuer ?? null, scope: t?.scope ?? null, expiresAt: t?.expiresAt ? new Date(t.expiresAt).toISOString() : null };
    },

    async start(id, origin): Promise<StartMcpOAuthResponse> {
      const { url, oauth } = spec(id);
      const redirectUri = redirectFor(origin);
      for (const [k, p] of pending) if (p.expires <= now()) pending.delete(k);
      const found = await discover(fetcher, url);
      let clientId = oauth.clientId ?? null;
      let clientSecret: string | null = null;
      const prior = grant(id, url);
      if (!clientId && prior && prior.redirectUri === redirectUri && prior.issuer === found.issuer) {
        clientId = prior.clientId;
        clientSecret = prior.clientSecret;
      }
      if (!clientId) {
        if (!found.registrationEndpoint) throw new HttpError(400, `MCP server ${id} does not allow automatic registration: set oauth.clientId`);
        const client = await registerClient(fetcher, found.registrationEndpoint, redirectUri);
        clientId = client.clientId;
        clientSecret = client.clientSecret;
      }
      const verifier = b64url(randomBytes(48));
      const state = b64url(randomBytes(24));
      const entry: OAuthEntry = {
        url, issuer: found.issuer, resource: found.resource, authorizationEndpoint: found.authorizationEndpoint, tokenEndpoint: found.tokenEndpoint,
        clientId, clientSecret, redirectUri, tokens: null,
      };
      pending.set(state, { id, verifier, entry, expires: now() + PENDING_TTL_MS });
      const auth = new URL(found.authorizationEndpoint);
      auth.searchParams.set("response_type", "code");
      auth.searchParams.set("client_id", clientId);
      auth.searchParams.set("redirect_uri", redirectUri);
      auth.searchParams.set("state", state);
      auth.searchParams.set("code_challenge", b64url(createHash("sha256").update(verifier).digest()));
      auth.searchParams.set("code_challenge_method", "S256");
      auth.searchParams.set("resource", found.resource);
      const scope = oauth.scope ?? (found.scopes.length ? found.scopes.join(" ") : undefined);
      if (scope) auth.searchParams.set("scope", scope);
      return { authorizationUrl: auth.href };
    },

    async complete(params): Promise<{ id: string }> {
      const state = params.state ?? "";
      const flow = pending.get(state);
      pending.delete(state); // single use, whatever happens next
      if (!flow || flow.expires <= now()) throw new HttpError(400, "this sign-in link is unknown or expired; start again from Odin");
      if (params.error) throw new HttpError(400, `the server declined the sign-in (${/^[a-z_]{1,40}$/.test(params.error) ? params.error : "error"})`);
      if (!params.code) throw new HttpError(400, "the sign-in returned no code");
      const { entry } = flow;
      const result = await tokenRequest(fetcher, entry.tokenEndpoint, {
        grant_type: "authorization_code", code: params.code, redirect_uri: entry.redirectUri, client_id: entry.clientId,
        code_verifier: flow.verifier, resource: entry.resource, ...(entry.clientSecret ? { client_secret: entry.clientSecret } : {}),
      }, now());
      if ("error" in result) throw new HttpError(502, `the server refused the sign-in (${result.error})`);
      const entries = load();
      entries[flow.id] = { ...entry, tokens: result };
      save(entries);
      return { id: flow.id };
    },

    disconnect(id) {
      spec(id);
      const entries = load();
      if (!(id in entries)) return;
      delete entries[id];
      save(entries);
    },

    async accessToken(id) {
      const { url } = spec(id);
      const entry = grant(id, url);
      const t = entry?.tokens;
      if (!entry || !t) throw new HttpError(400, `MCP server ${id} needs sign-in: connect it first`);
      if (t.expiresAt === null || t.expiresAt - REFRESH_MARGIN_MS > now()) return t.accessToken;
      const inflight = refreshing.get(id) ?? refresh(id, entry).finally(() => refreshing.delete(id));
      refreshing.set(id, inflight);
      return inflight;
    },
  };
}
