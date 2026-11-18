# Architecture

```
apps/desktop (Electron) ──▶ packages/core (node:http, node:sqlite, SSE) ──▶ harness drivers ──▶ native runtimes
        │                          ▲   ▲
        └── window ──▶ packages/web (Vue 3) ── REST + SSE
                                       └── adapters/claude-code (hooks from terminal sessions → ingest API)
```

| Package | What it holds |
|---|---|
| `packages/shared` | Types and small helpers shared by core and web: sessions, harness events and the transcript reducer, library rules, labels, pricing, agent files. The source of truth for data shapes. |
| `packages/core` | The server. One folder per module (`projects`, `sessions`, `launch`, `library`, `artifacts`, `notebooks`, `coordination`, `sync`, `ingest`, `metrics`, `settings`, `tracking`), each with a `service.ts` implementing an interface from `services.ts` and a `routes.ts`. |
| `packages/core/src/harness` | The `Harness` interface (`types.ts`), the scriptable fake driver, and one folder per runtime. Only a driver may import its runtime's SDK or protocol types. |
| `packages/web` | The Vue 3.5 app. `src/components`, `src/styles`, `src/composables` are the Instrument UI design system; `src/screens` and `src/app` are Odin's; `src/api` is the client (`types.ts` the contract, `http.ts` real, `mock.ts` fixtures). |
| `apps/desktop` | The Electron shell. See [desktop.md](desktop.md). |
| `adapters/claude-code` | Hooks that report terminal Claude Code sessions to the ingest API. |
| `templates/library` | Seed content copied into an empty `~/.odin/library/` on first start. |

## How it works

- **Sessions.** Core owns session metadata, live handles and a durable follow-up outbox. The harness's native
  history is the durable conversation; Odin keeps no transcript of its own. Live tails and streaming entry ids
  restore an in-progress view, and delta offsets reconcile REST snapshots with concurrent SSE events.
- **Launch.** One native default agent per session, with runtime, model, permissions, workspace and optional
  library MCP servers. Library agents become subagents; reusable workflows are skills. Selected MCP ids survive
  restart and fork, and are resolved from the library when needed, so resolved secrets are never stored in session
  metadata.
- **Harnesses.** Claude Agent SDK, Codex app-server (including WSL on Windows), Grok ACP, OpenCode, Antigravity and
  the scripted fake implement `harness/types.ts`. Capability declarations say what each supports (additional
  directories, supplemental instructions, attachments); unsupported input is reported, never silently dropped. See
  the capability table in [contracts.md](contracts.md).
- **Library.** Plain files under `~/.odin/library/`, versioned by content hash in SQLite, copied into projects with
  drift detection, and projected into each runtime's native format at launch.
- **GitHub.** Optional and per project: read-only pull request lookups that link sessions to the PRs whose head
  branch they worked on.
- **Web.** Screens are built from the Instrument UI library on one API interface, backed by HTTP/SSE or the mock.
  Artifacts run only in sandboxed frames.
- **Desktop.** The shell attaches to an existing core or supervises its own child, and subscribes to SSE for tray
  counts and notifications. Packaged builds carry core, web, library seed, theme and adapters; no system Node is
  needed.
- **Trust.** Loopback Host/Origin policy, an authenticated ingest endpoint, confined filesystem operations, argv-only
  subprocesses, sandboxed artifacts and top-frame IPC checks. Model credentials belong to the native runtimes.

`docs/contracts.md` defines behaviour and `packages/shared/src/` defines data shapes; where this page and those
disagree, they win.
