# Running Odin against a self-hosted Claude endpoint

This fork runs Claude only (OpenCode is removed; Codex, Grok and Antigravity are off unless `ODIN_HARNESSES` lists
them). Odin never reads model credentials: the Claude driver hands its environment to Claude Code, so configuration is
Claude Code's own.

## Configure

Set these where Odin (or the desktop app) starts, or under `env` in `~/.claude/settings.json`:

| Variable | Purpose |
|---|---|
| `ANTHROPIC_BASE_URL` | Your gateway, e.g. `https://claude-gateway.example.internal`. |
| `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY` | Credential the gateway expects. Or use an `apiKeyHelper` in Claude settings. |
| `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` | Instead of the above, if the gateway is Bedrock or Vertex (with their own base-URL variables). |
| `NODE_EXTRA_CA_CERTS` | Path to the corporate CA bundle if the gateway uses an internal certificate. |
| `HTTPS_PROXY` | If outbound traffic must go through a proxy. |

With only an `apiKeyHelper` (no variable or credentials file) the Settings readiness check may say Claude is not logged
in; sessions still work.

## Taking upstream updates

```sh
git remote add upstream <upstream repo url>   # once
git fetch upstream
git merge upstream/main
yarn install && yarn typecheck && yarn test
```

Expect conflicts only in the files this fork touches: `packages/core/src/server.ts`, `packages/core/src/config.ts`,
`packages/core/package.json`, `yarn.lock` (resolve by re-running `yarn install`), `apps/desktop/build/bundle.ts`, and
any upstream change under `packages/core/src/harness/opencode/` (keep it deleted: `git rm -r` that folder). If upstream
adds a new harness, add it to the `enabledHarnesses` call in `server.ts`; it stays off unless listed in `ODIN_HARNESSES`.
