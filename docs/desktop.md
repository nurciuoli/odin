# Desktop shell

`apps/desktop` is the Electron app. It is a client like a browser: it holds no application state, and the web app
never requires it. The contract side (health identity, IPC surface, desktop settings) is in
[contracts.md](contracts.md#desktop-shell).

```
Electron main ──spawn──▶ core (node:http, SQLite, harness drivers) ──▶ claude / codex / grok / …
     │                        ▲
     ├── BrowserWindow ───────┘  http://127.0.0.1:<port>/  (the same web app a browser gets)
     ├── SSE client ──────────┘  /api/events → tray counts, notifications
     └── preload → window.odinDesktop
```

## Behaviour

| Point | Behaviour |
|---|---|
| Closing the window | Hides to the tray. Core and live sessions keep running. |
| Quit | Stops core. Asks first when sessions are running or waiting. |
| Start at login | Off by default; a toggle in Settings (starts hidden in the tray). |
| Existing server | If an Odin core already answers on the port, the app attaches to it and does not stop it on quit. |
| Port | Prefers 8790 (8791 for the dev channel) and moves to a free port when another program holds it. `ODIN_PORT` pins it. Hooks find the port in `<home>/runtime.json`. |

### Core lifecycle

- On launch the shell probes `GET /api/health`. An Odin core: attach. Nothing: spawn core with argv, wait for health,
  then load the window. Something else: an error window naming the port and `ODIN_PORT`.
- Health identifies Odin, so the shell cannot attach to an unrelated service.
- An owned core that exits unexpectedly restarts with backoff (1 s, 2 s, 5 s; it gives up after 5 tries in 2 minutes
  and shows an error window with Restart and Open log).
- Quit asks an owned core to stop gracefully, waits up to 10 s, then kills it.
- Core's output goes to `<home>/desktop.log` (rotated at 5 MB). Core runs with the shell's environment plus the
  resolved `PATH`; the shell never reads or forwards model credentials beyond passing its environment through.

### Window

- One window with a single-instance lock: a second launch focuses the first.
- Size, position and maximised state persist in `<home>/desktop.json`.
- `contextIsolation`, `sandbox`, no `nodeIntegration`. Navigation is confined to the core origin; other links open
  in the system browser. Page permission requests (camera, microphone, geolocation, notifications) are denied.
- Artifacts render only in the sandboxed `/a/…` iframe and get nothing extra from the shell.
- On Windows and Linux there is no native menu bar: window controls overlay the app's own header.

### Tray and notifications

- The tray tooltip reads like "Odin: 2 running, 1 needs you", and the icon has a distinct "needs you" variant
  (shape, not only colour). The menu has Open, New session, up to five waiting sessions, and Quit.
- Counts come from the shell's own SSE subscription, re-seeded from the sessions list after every reconnect.
- A session that becomes waiting raises one native notification per waiting episode (optional: also when a session
  finishes while the window is hidden). No notification for the session you're looking at. Notification text
  carries titles only, never tool input or file contents.

### Global shortcut

Opens the launcher. Default `Ctrl+Shift+Space`; configurable, can be turned off. If another app holds it, Settings
says so and the app still starts.

### Open in editor / terminal / files

`window.odinDesktop.openPath(path, target)` accepts only real paths under a registered project or an Odin
worktree, rejecting symlink and junction escapes. IPC handlers check that the sender is the core origin's top
frame, so artifact frames cannot reach them.

### Finding the tools

A GUI-launched app does not get your shell's `PATH`, so the shell builds one for core: the process `PATH`, the
user and machine `PATH` from the registry on Windows, and the usual install locations (npm global bin,
`%LOCALAPPDATA%\Programs`, `~/.local/bin`). Settings shows what each harness found and accepts an explicit path per
tool. A missing tool is reported, never a startup failure.

## Packaging

- `electron-builder`; today the target is a Windows x64 NSIS installer (per-user, no admin). macOS and Linux targets
  are not configured yet; nothing in the shell itself assumes Windows.
- Core is bundled to plain JavaScript at build time (esbuild), because Node will not strip types from files under
  `node_modules`. It runs without a system Node.
- The built web app, the library seed, the artifact theme and the Claude Code hook scripts ship as resources and are
  passed to core by path (`ODIN_WEB_DIST`, `ODIN_LIBRARY_SEED`, `ODIN_ARTIFACT_THEME`, `ODIN_ADAPTER_DIR`).
- `yarn build:desktop` builds the web app and the installer under `apps/desktop/dist/`.

## Testing

- Everything that is not Electron is tested with `node:test` beside the code: the port probe and attach decision,
  restart backoff, tray counts, notification de-duplication, path checks, `PATH` assembly and window-state
  validation. Main-process modules take Electron APIs as injected dependencies.
- `yarn workspace @odin/desktop smoke` is a manual scripted smoke run against the fake harness: launch, load,
  start a session, tray count changes, quit stops core.
