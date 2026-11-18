# Plan: MCP servers with real auth, and plugins

Status: **phase 1 (vault) in review (#18), phase 2 (OAuth) done (#21), phase 3 (servers screen) in review, phase 4 not started.** Owner: open.

## Why

Odin can launch MCP servers from the library, but a spec's `env` and `headers` were plaintext, `.mcp.json` got a copy,
and there was no way to sign in to a remote server that uses OAuth or to see whether a server works. The aim is the
same experience in every harness: set a server up once in Odin, sign in once, and every session gets it.

## Phases

1. **Secrets vault** (done): `${secret:NAME}` in MCP specs, `<home>/secrets.json` mode 600, `/api/secrets`, filled at
   launch. See `docs/contracts.md#secrets`.
2. **OAuth for remote servers** (done): discovery, PKCE sign-in through `/api/oauth/callback`, token storage and
   refresh, `Authorization` header at launch. See `docs/contracts.md#mcp-oauth`.
3. **MCP servers screen** (done, except the native catalog and test-connection parts): a page listing library servers with connection state (connected, needs sign-in, missing
   secret), a Connect button that opens `authorizationUrl` and polls status, Disconnect, secret entry, and the
   native catalog's per-harness status and tool counts. Needs `api.ts`/`mock.ts` methods and fixtures. A "test
   connection" action (initialize + list tools through core) probably needs its own small contract.
4. **Plugins as a library kind**: a bundle of skills, agents, MCP specs and settings installed and tracked with the
   existing drift machinery, instead of wrapping each harness's own plugin system (the native catalog only lists
   plugin names and can update them). Needs a bundle format, an install target per harness, and a decision on
   marketplace sources. Write the design here before building it.

## Known gaps

- `.mcp.json` keeps `${secret:…}` placeholders, so a terminal Claude Code session in the project does not get values.
- A token that ends in the middle of a running session is only replaced on the next resume.
- Codex rejects SSE servers and Grok rejects legacy SSE; OAuth needs `http`.
- The vault and `oauth.json` are plain files at mode 600. An OS keychain backend (Electron `safeStorage`) can replace
  the stores without an API change.
- Disconnect forgets the grant but does not revoke it at the server.
