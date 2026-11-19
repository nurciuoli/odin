import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../http/util.ts";
import { discover, registerClient, resourceMetadataUrl, safeUrl, tokenRequest, type Fetcher } from "./discovery.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fetcher answering from a url → Response table; anything else is a 404. Records the urls asked. */
function routes(table: Record<string, () => Response>) {
  const asked: string[] = [];
  const fetcher: Fetcher = async (url) => {
    asked.push(url);
    return table[url]?.() ?? new Response("nope", { status: 404 });
  };
  return { fetcher, asked };
}

const AS = { issuer: "https://auth.example", authorization_endpoint: "https://auth.example/authorize", token_endpoint: "https://auth.example/token", registration_endpoint: "https://auth.example/register", code_challenge_methods_supported: ["S256"] };

test("safeUrl accepts https and loopback http, and refuses everything else", () => {
  assert.equal(safeUrl("https://a.example/x", "u").href, "https://a.example/x");
  assert.equal(safeUrl("http://localhost:3000/mcp", "u").hostname, "localhost");
  for (const bad of ["http://a.example", "ftp://a.example", "https://user:pw@a.example", "not a url", undefined]) {
    assert.throws(() => safeUrl(bad, "the url"), (e: unknown) => e instanceof HttpError && e.status === 502, String(bad));
  }
});

test("resourceMetadataUrl reads the quoted url from WWW-Authenticate", () => {
  assert.equal(resourceMetadataUrl('Bearer realm="x", resource_metadata="https://m.example/prm"'), "https://m.example/prm");
  assert.equal(resourceMetadataUrl('Bearer realm="x"'), null);
  assert.equal(resourceMetadataUrl(null), null);
});

test("discover follows the 401 challenge to the resource metadata, then the authorization server", async () => {
  const { fetcher } = routes({
    "https://mcp.example/mcp": () => new Response("", { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.example/prm"' } }),
    "https://mcp.example/prm": () => json({ resource: "https://mcp.example/mcp", authorization_servers: ["https://auth.example"] }),
    "https://auth.example/.well-known/oauth-authorization-server": () => json(AS),
  });
  assert.deepEqual(await discover(fetcher, "https://mcp.example/mcp"), {
    resource: "https://mcp.example/mcp",
    issuer: "https://auth.example",
    authorizationEndpoint: "https://auth.example/authorize",
    tokenEndpoint: "https://auth.example/token",
    registrationEndpoint: "https://auth.example/register",
  });
});

test("discover falls back to the well-known paths and the MCP origin as the issuer", async () => {
  const { fetcher, asked } = routes({
    "https://mcp.example/.well-known/oauth-authorization-server": () => json({ ...AS, issuer: undefined, registration_endpoint: undefined, authorization_endpoint: "https://mcp.example/a", token_endpoint: "https://mcp.example/t" }),
  });
  const found = await discover(fetcher, "https://mcp.example/");
  assert.equal(found.resource, "https://mcp.example/");
  assert.equal(found.issuer, "https://mcp.example");
  assert.equal(found.registrationEndpoint, null);
  assert.ok(asked.includes("https://mcp.example/.well-known/oauth-protected-resource"));
});

test("discover rejects a server without metadata, without S256, or with an insecure endpoint", async () => {
  await assert.rejects(discover(routes({}).fetcher, "https://mcp.example/mcp"), /does not publish OAuth metadata/);
  const meta = (extra: object) => routes({ "https://mcp.example/.well-known/oauth-authorization-server": () => json({ ...AS, ...extra }) }).fetcher;
  await assert.rejects(discover(meta({ code_challenge_methods_supported: ["plain"] }), "https://mcp.example/mcp"), /PKCE/);
  await assert.rejects(discover(meta({ token_endpoint: "http://evil.example/t" }), "https://mcp.example/mcp"), /must be https/);
  await assert.rejects(discover(meta({}), "http://mcp.example/mcp"), /must be https/);
});

test("registerClient posts a public PKCE client and returns the id", async () => {
  let sent: any;
  const fetcher: Fetcher = async (_url, init) => {
    sent = JSON.parse(String(init!.body));
    return json({ client_id: "abc", client_secret: "" });
  };
  assert.deepEqual(await registerClient(fetcher, "https://auth.example/register", "http://localhost/cb"), { clientId: "abc", clientSecret: null });
  assert.deepEqual([sent.redirect_uris, sent.token_endpoint_auth_method], [["http://localhost/cb"], "none"]);
  await assert.rejects(registerClient(async () => json({}, 400), "https://a/r", "u"), /refused \(400\)/);
  await assert.rejects(registerClient(async () => json({ nope: 1 }), "https://a/r", "u"), /no client_id/);
});

test("tokenRequest turns a good response into a token set with an absolute expiry", async () => {
  const fetcher: Fetcher = async () => json({ access_token: "at", refresh_token: "rt", expires_in: 60, scope: "read", token_type: "Bearer" });
  assert.deepEqual(await tokenRequest(fetcher, "https://a/t", { grant_type: "x" }, 1000), { accessToken: "at", refreshToken: "rt", expiresAt: 61_000, scope: "read" });
  const bare = await tokenRequest(async () => json({ access_token: "at" }), "https://a/t", {}, 1000);
  assert.deepEqual(bare, { accessToken: "at", refreshToken: null, expiresAt: null, scope: null });
});

test("tokenRequest reports only the OAuth error code, never a description", async () => {
  assert.deepEqual(await tokenRequest(async () => json({ error: "invalid_grant", error_description: "secret detail" }, 400), "https://a/t", {}, 0), { error: "invalid_grant" });
  assert.deepEqual(await tokenRequest(async () => json({ error: "Bad Thing!" }, 400), "https://a/t", {}, 0), { error: "http_400" });
  assert.deepEqual(await tokenRequest(async () => new Response("<html>", { status: 502 }), "https://a/t", {}, 0), { error: "http_502" });
});

test("tokenRequest refuses a response it cannot use", async () => {
  await assert.rejects(tokenRequest(async () => json({}), "https://a/t", {}, 0), /no access_token/);
  await assert.rejects(tokenRequest(async () => json({ access_token: "a", token_type: "mac" }), "https://a/t", {}, 0), /token type/);
});
