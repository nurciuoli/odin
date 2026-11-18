// OAuth grants for library MCP servers: <home>/oauth.json, mode 600. One entry per library MCP id. docs/contracts.md#mcp-oauth.
import { existsSync, readFileSync } from "node:fs";
import { writeJson600 } from "../secrets/store.ts";
import type { TokenSet } from "./discovery.ts";

export interface OAuthEntry {
  /** The spec url this grant belongs to. A changed url voids it, so a token never goes to a different server. */
  url: string;
  issuer: string;
  resource: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string | null;
  redirectUri: string;
  tokens: TokenSet | null;
}

export interface OAuthStore {
  read(): Record<string, OAuthEntry>;
  write(entries: Record<string, OAuthEntry>): void;
}

const str = (v: unknown) => typeof v === "string" && v !== "";

export function createFileOAuthStore(file: string): OAuthStore {
  return {
    read() {
      if (!existsSync(file)) return Object.create(null);
      let servers: unknown;
      try {
        servers = (JSON.parse(readFileSync(file, "utf8")) as { servers?: unknown }).servers;
      } catch {
        throw new Error(`${file} is not valid JSON`);
      }
      if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error(`${file} has no servers map`);
      const out: Record<string, OAuthEntry> = Object.create(null);
      for (const [id, raw] of Object.entries(servers)) {
        const e = raw as Partial<OAuthEntry> | null;
        const t = e?.tokens;
        if (!e || ![e.url, e.issuer, e.resource, e.authorizationEndpoint, e.tokenEndpoint, e.clientId, e.redirectUri].every(str)) throw new Error(`${file} entry ${JSON.stringify(id.slice(0, 64))} is malformed`);
        if (t !== null && t !== undefined && (typeof t !== "object" || !str(t.accessToken))) throw new Error(`${file} entry ${JSON.stringify(id.slice(0, 64))} has bad tokens`);
        out[id] = {
          url: e.url!, issuer: e.issuer!, resource: e.resource!, authorizationEndpoint: e.authorizationEndpoint!, tokenEndpoint: e.tokenEndpoint!,
          clientId: e.clientId!, clientSecret: typeof e.clientSecret === "string" ? e.clientSecret : null, redirectUri: e.redirectUri!,
          tokens: t ? { accessToken: t.accessToken, refreshToken: typeof t.refreshToken === "string" ? t.refreshToken : null, expiresAt: typeof t.expiresAt === "number" ? t.expiresAt : null, scope: typeof t.scope === "string" ? t.scope : null } : null,
        };
      }
      return out;
    },
    write(entries) {
      writeJson600(file, { version: 1, servers: entries });
    },
  };
}
