import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { McpOAuthDetect, McpOAuthStatus, StartMcpOAuthResponse } from "@odin/shared/api";
import { startApp } from "../test-helpers.ts";

const homes: string[] = [];
after(() => homes.forEach((h) => rmSync(dirname(h), { recursive: true, force: true })));

const MCP = "https://mcp.example.test/mcp";
const AS = "https://auth.example.test";

/** A scripted MCP server + authorization server behind a fake fetch. */
function fakeServers(opts: { dcr?: boolean; expiresIn?: number; refreshError?: string } = {}) {
  const log: { url: string; body: string }[] = [];
  const state = { clients: 0, tokens: 0, challenge: "", redirect: "" };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = String(init?.body ?? "");
    log.push({ url, body });
    if (url === MCP) return new Response("", { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"` } });
    if (url === "https://mcp.example.test/.well-known/oauth-protected-resource/mcp") return json({ resource: MCP, authorization_servers: [AS], scopes_supported: ["design:read", "design:write"] });
    if (url === `${AS}/.well-known/oauth-authorization-server`) {
      return json({ issuer: AS, authorization_endpoint: `${AS}/authorize`, token_endpoint: `${AS}/token`, code_challenge_methods_supported: ["S256"], ...(opts.dcr === false ? {} : { registration_endpoint: `${AS}/register` }) });
    }
    if (url === `${AS}/register`) {
      state.clients++;
      return json({ client_id: `client-${state.clients}` }, 201);
    }
    if (url === `${AS}/token`) {
      const form = new URLSearchParams(body);
      state.tokens++;
      if (form.get("grant_type") === "authorization_code") {
        assert.equal(form.get("code"), "the-code");
        assert.equal(createHash("sha256").update(form.get("code_verifier")!).digest("base64url"), state.challenge);
        assert.equal(form.get("redirect_uri"), state.redirect);
        assert.equal(form.get("resource"), MCP);
        return json({ access_token: "at-1", token_type: "Bearer", refresh_token: "rt-1", expires_in: opts.expiresIn ?? 3600, scope: "read" });
      }
      if (opts.refreshError) return json({ error: opts.refreshError, error_description: "echoes rt-1" }, 400);
      assert.equal(form.get("refresh_token"), "rt-1");
      return json({ access_token: "at-2", token_type: "bearer", expires_in: 3600 });
    }
    return new Response("nope", { status: 404 });
  };
  return { fetchFn, log, state };
}

async function app(servers: ReturnType<typeof fakeServers>, extra: Record<string, unknown> = {}) {
  const t = await startApp({ mcpFetch: servers.fetchFn });
  homes.push(t.config.home);
  const spec = { type: "http", url: MCP, oauth: { scope: "read" }, ...extra };
  const saved = await t.api("/api/library/mcp/docs", { method: "PUT", body: JSON.stringify({ files: { "docs.json": JSON.stringify(spec) } }) });
  assert.equal(saved.status, 201);
  return t;
}

async function signIn(t: Awaited<ReturnType<typeof app>>, servers: ReturnType<typeof fakeServers>) {
  const origin = t.base;
  const started = await t.json<StartMcpOAuthResponse>("/api/mcp/docs/oauth/start", { method: "POST", body: JSON.stringify({ origin }) });
  const auth = new URL(started.authorizationUrl);
  servers.state.challenge = auth.searchParams.get("code_challenge")!;
  servers.state.redirect = `${origin}/api/oauth/callback`;
  return { auth, callback: await t.api(`/api/oauth/callback?code=the-code&state=${auth.searchParams.get("state")}`) };
}

test("oauth: discovery, registration, PKCE sign-in, status, tokens stored mode 600", async () => {
  const servers = fakeServers();
  const t = await app(servers);
  try {
    assert.equal((await t.json<McpOAuthStatus>("/api/mcp/docs/oauth")).state, "needs-sign-in");
    const { auth, callback } = await signIn(t, servers);
    assert.equal(auth.origin + auth.pathname, `${AS}/authorize`);
    assert.deepEqual(
      ["response_type", "client_id", "code_challenge_method", "resource", "scope", "redirect_uri"].map((k) => auth.searchParams.get(k)),
      ["code", "client-1", "S256", MCP, "read", `${t.base}/api/oauth/callback`],
    );
    assert.equal(callback.status, 200);
    assert.match(callback.headers.get("cache-control")!, /no-store/);
    assert.match(await callback.text(), /Connected/);

    const status = await t.json<McpOAuthStatus>("/api/mcp/docs/oauth");
    assert.deepEqual([status.state, status.issuer, status.scope], ["connected", AS, "read"]);
    assert.equal(JSON.stringify(status).includes("at-1"), false);
    const file = join(t.config.home, "oauth.json");
    assert.equal(JSON.parse(readFileSync(file, "utf8")).servers.docs.tokens.accessToken, "at-1");
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);

    assert.equal((await t.api("/api/mcp/docs/oauth", { method: "DELETE" })).status, 204);
    assert.equal((await t.json<McpOAuthStatus>("/api/mcp/docs/oauth")).state, "needs-sign-in");
  } finally {
    await t.close();
  }
});

test("oauth detect: a server with metadata is oauth, one without is not, a cleartext url is 400", async () => {
  const servers = fakeServers();
  const t = await startApp({ mcpFetch: servers.fetchFn });
  homes.push(t.config.home);
  try {
    assert.deepEqual(await t.json<McpOAuthDetect>("/api/mcp/oauth/detect", { method: "POST", body: JSON.stringify({ url: MCP }) }), {
      oauth: true, scopes: ["design:read", "design:write"],
    });
    assert.deepEqual(await t.json<McpOAuthDetect>("/api/mcp/oauth/detect", { method: "POST", body: JSON.stringify({ url: "https://plain.example/mcp" }) }), {
      oauth: false, scopes: [],
    });
    assert.equal((await t.api("/api/mcp/oauth/detect", { method: "POST", body: JSON.stringify({ url: "http://plain.example/mcp" }) })).status, 400);
  } finally {
    await t.close();
  }
});

test("oauth: a spec with no scope asks for the scopes the server publishes", async () => {
  const servers = fakeServers();
  const t = await app(servers, { oauth: {} });
  try {
    const started = await t.json<StartMcpOAuthResponse>("/api/mcp/docs/oauth/start", { method: "POST", body: JSON.stringify({ origin: t.base }) });
    assert.equal(new URL(started.authorizationUrl).searchParams.get("scope"), "design:read design:write");
  } finally {
    await t.close();
  }
});

test("oauth: the state is single use and unknown states are refused without calling the token endpoint", async () => {
  const servers = fakeServers();
  const t = await app(servers);
  try {
    const { auth } = await signIn(t, servers);
    const state = auth.searchParams.get("state")!;
    assert.equal(servers.state.tokens, 1);
    const replay = await t.api(`/api/oauth/callback?code=the-code&state=${state}`);
    assert.equal(replay.status, 400);
    assert.equal((await t.api("/api/oauth/callback?code=x&state=forged")).status, 400);
    assert.equal((await t.api("/api/oauth/callback?code=x")).status, 400);
    assert.equal(servers.state.tokens, 1);
  } finally {
    await t.close();
  }
});

test("oauth: an error from the server and hostile text are reported without echoing HTML", async () => {
  const servers = fakeServers();
  const t = await app(servers);
  try {
    const started = await t.json<StartMcpOAuthResponse>("/api/mcp/docs/oauth/start", { method: "POST", body: JSON.stringify({ origin: t.base }) });
    const state = new URL(started.authorizationUrl).searchParams.get("state");
    const res = await t.api(`/api/oauth/callback?error=%3Cscript%3E&state=${state}`);
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.equal(html.includes("<script>"), false);
    assert.match(res.headers.get("content-security-policy")!, /default-src 'none'/);
  } finally {
    await t.close();
  }
});

test("oauth: start refuses a foreign origin, a non-oauth server, and a server with no registration and no clientId", async () => {
  const servers = fakeServers({ dcr: false });
  const t = await app(servers);
  try {
    const start = (id: string, origin: string) => t.api(`/api/mcp/${id}/oauth/start`, { method: "POST", body: JSON.stringify({ origin }) });
    assert.equal((await start("docs", "https://evil.example")).status, 400);
    assert.equal((await start("docs", `${t.base}/x`)).status, 400);
    assert.equal((await start("docs", t.base)).status, 400); // no registration endpoint, no clientId
    await t.api("/api/library/mcp/plain", { method: "PUT", body: JSON.stringify({ files: { "plain.json": JSON.stringify({ type: "http", url: MCP }) } }) });
    assert.equal((await start("plain", t.base)).status, 400);
    assert.equal((await start("missing", t.base)).status, 404);
    assert.equal((await start("Bad_Id", t.base)).status, 400);
  } finally {
    await t.close();
  }
});

test("oauth: a configured clientId skips registration", async () => {
  const servers = fakeServers({ dcr: false });
  const t = await app(servers, { oauth: { clientId: "hand-made" } });
  try {
    const started = await t.json<StartMcpOAuthResponse>("/api/mcp/docs/oauth/start", { method: "POST", body: JSON.stringify({ origin: t.base }) });
    assert.equal(new URL(started.authorizationUrl).searchParams.get("client_id"), "hand-made");
    assert.equal(servers.log.some((l) => l.url.endsWith("/register")), false);
  } finally {
    await t.close();
  }
});

test("oauth: specs with oauth cannot set an Authorization header, and oauth needs a remote server", async () => {
  const servers = fakeServers();
  const t = await app(servers);
  try {
    const put = (id: string, spec: unknown) => t.api(`/api/library/mcp/${id}`, { method: "PUT", body: JSON.stringify({ files: { [`${id}.json`]: JSON.stringify(spec) } }) });
    assert.equal((await put("a", { type: "http", url: MCP, headers: { authorization: "x" }, oauth: {} })).status, 400);
    assert.equal((await put("b", { type: "stdio", command: "x", oauth: {} })).status, 400);
    assert.equal((await put("c", { type: "http", url: MCP, oauth: { scope: 5 } })).status, 400);
    assert.equal((await put("d", { type: "http", url: MCP, oauth: { token: "x" } })).status, 400);
  } finally {
    await t.close();
  }
});

test("oauth: discovery refuses plain http endpoints", async () => {
  const servers = fakeServers();
  const evil: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === `${AS}/.well-known/oauth-authorization-server`) return new Response(JSON.stringify({ issuer: AS, authorization_endpoint: `${AS}/authorize`, token_endpoint: "http://auth.example.test/token", registration_endpoint: `${AS}/register` }));
    return servers.fetchFn(input, init);
  };
  const t = await startApp({ mcpFetch: evil });
  homes.push(t.config.home);
  try {
    await t.api("/api/library/mcp/docs", { method: "PUT", body: JSON.stringify({ files: { "docs.json": JSON.stringify({ type: "http", url: MCP, oauth: {} }) } }) });
    const res = await t.api("/api/mcp/docs/oauth/start", { method: "POST", body: JSON.stringify({ origin: t.base }) });
    assert.equal(res.status, 502);
    assert.match(((await res.json()) as { error: string }).error, /https/);
  } finally {
    await t.close();
  }
});

test("oauth: accessToken returns a live token, refreshes a near-expired one, and a dead grant needs sign-in", async () => {
  const servers = fakeServers({ expiresIn: 30 }); // inside the refresh margin right away
  const t = await app(servers);
  try {
    await signIn(t, servers);
    assert.equal(await t.app.services.mcpOAuth.accessToken("docs"), "at-2");
    assert.equal(await t.app.services.mcpOAuth.accessToken("docs"), "at-2"); // new token lasts: no second refresh
    assert.equal(servers.state.tokens, 2);
    assert.equal(JSON.parse(readFileSync(join(t.config.home, "oauth.json"), "utf8")).servers.docs.tokens.refreshToken, "rt-1");
  } finally {
    await t.close();
  }

  const dead = fakeServers({ expiresIn: 30, refreshError: "invalid_grant" });
  const t2 = await app(dead);
  try {
    await signIn(t2, dead);
    await assert.rejects(t2.app.services.mcpOAuth.accessToken("docs"), /needs sign-in again/);
    assert.equal((await t2.json<McpOAuthStatus>("/api/mcp/docs/oauth")).state, "needs-sign-in");
    await assert.rejects(t2.app.services.mcpOAuth.accessToken("docs"), /needs sign-in/);
  } finally {
    await t2.close();
  }
});

test("oauth: changing the server url voids the grant", async () => {
  const servers = fakeServers();
  const t = await app(servers);
  try {
    await signIn(t, servers);
    assert.equal((await t.json<McpOAuthStatus>("/api/mcp/docs/oauth")).state, "connected");
    await t.api("/api/library/mcp/docs", { method: "PUT", body: JSON.stringify({ files: { "docs.json": JSON.stringify({ type: "http", url: "https://other.example.test/mcp", oauth: {} }) } }) });
    assert.equal((await t.json<McpOAuthStatus>("/api/mcp/docs/oauth")).state, "needs-sign-in");
    await assert.rejects(t.app.services.mcpOAuth.accessToken("docs"), /needs sign-in/);
  } finally {
    await t.close();
  }
});
