# Development

## Prerequisites

- **Node 24** (22.18+ works).
- **Yarn 4** through Corepack. The version is pinned in `package.json`; never use npm in this repo.
- **git**.
- To run real sessions: at least one harness CLI installed and logged in (`claude`, `codex`, `grok`, `opencode`,
  …). Not needed for development: the fake harness runs scripted sessions with no model calls.

### Corepack setup

```sh
corepack enable yarn
yarn --version   # must print 4.x
```

`corepack yarn <command>` works without enabling anything.

On Windows, when Node lives in `C:\Program Files\nodejs`, `corepack enable` needs an **administrator** terminal
(otherwise it fails with `EPERM`). If `yarn --version` prints 1.x, an old Yarn is earlier on `PATH`
(`Get-Command yarn -All` lists them): uninstall the Yarn MSI and `npm uninstall -g yarn`, then open a new terminal.

## Run

```sh
yarn install
ODIN_FAKE_HARNESS=1 yarn dev:core   # core with the scripted fake harness: no model calls, no credentials
yarn dev:web                        # Vite on :5190, proxies /api to core; add ?mock to run on fixtures only
yarn start                          # core alone, serving the built web app (yarn build:web first)
yarn build:web && yarn dev          # the desktop shell from source
yarn dev:desktop                    # same, but strips ODIN_* and ELECTRON_RUN_AS_NODE, so it works from a terminal inside the installed Odin
```

PowerShell sets the variable with `$env:ODIN_FAKE_HARNESS=1; yarn dev:core`.

### Stable and dev channels

An installed app is the *stable* channel: `~/.odin`, port 8790. Anything run from the repo is the *dev* channel:
`~/.odin-dev`, port 8791, its own app name ("Odin Dev") and window state, so both can run at once.
`ODIN_HOME` and `ODIN_PORT` override the folder and port.

Odin snapshots `state.db` to `<home>/backups/` before any schema upgrade.

Set `NODE_DEBUG=odin-discovery` to log session discovery time and listed and imported counts by project and harness.

### Environment variables

| Variable | Meaning |
|---|---|
| `ODIN_HOME` | Data folder (database, library, logs). |
| `ODIN_PORT` | Port to bind on `127.0.0.1`. |
| `ODIN_FAKE_HARNESS=1` | Use the scripted fake harness instead of real runtimes. |
| `ODIN_EXTRA_HOSTS` | Extra Host/Origin names allowed in (for example a Tailscale Serve hostname). |
| `ODIN_ALLOWED_LOGIN` | With Tailscale Serve: the one Tailscale login allowed in. |
| `GITHUB_TOKEN` | Optional, for reading pull requests. Falls back to `gh auth token`. |

To run core on an always-on computer behind Tailscale Serve, see [hosting.md](hosting.md).

## Check

`yarn typecheck` and `yarn test` must pass for every change; `yarn verify:web` too if you touched `packages/web`
(format check, type-check, ESLint, the design-system guard, vitest and a strict build). Format web code with
`yarn workspace @odin/web format`.

To smoke-test real Jupyter kernels, run `node --test packages/core/src/notebooks/runtime.integration.test.ts`.
Set `ODIN_TEST_JUPYTER_HOST_PYTHON` to a native Python with Jupyter Server and
`ODIN_TEST_JUPYTER_KERNEL_PYTHON` to a Python with ipykernel if it lives elsewhere. For WSL, use
`ODIN_TEST_WSL_DISTRO`, `ODIN_TEST_WSL_JUPYTER_HOST_PYTHON`, and optionally
`ODIN_TEST_WSL_JUPYTER_KERNEL_PYTHON`. The smoke test uses temporary notebooks and synthetic data.

Tests sit next to the code (`*.test.ts`): `node:test` in core, shared, adapters and desktop; vitest in web. Tests
never touch the network, a real `~/.odin` or `~/.claude`, real GitHub or a real model: use `testDeps()` /
`startApp()` from `packages/core/src/test-helpers.ts` and `fakeHarness()` from `packages/core/src/harness/fake.ts`.

## Build the desktop app

```sh
yarn build:desktop
```

This builds the web app and the installer under `apps/desktop/dist/`. On Windows, quit a running Odin from its tray
menu, then run `apps/desktop/dist/win-unpacked/Odin.exe` or the installer. See [desktop.md](desktop.md).

## Harness notes

- Harness authentication stays with each CLI. Claude also accepts `ANTHROPIC_API_KEY`. Odin never reads or stores
  any of these credentials.
- Codex needs a real CLI installation and login on `PATH` in its selected environment. For Codex (WSL), the Windows
  npm shim is not a Linux installation. WSL UNC project paths select their distribution; drive paths use the
  default distribution.
- Settings holds the default harness and its model and permission defaults.

## Terminal Claude Code sessions

`adapters/claude-code` contains hooks that report sessions you run with `claude` in a terminal to Odin's ingest
API, so they show up with metrics. Install them per project from the project's Settings tab. Without hooks, terminal sessions still appear
in history; usage is read from the transcript when opened.
