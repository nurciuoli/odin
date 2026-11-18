# Changelog

Notable changes to Odin. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

- The session Details panel is tidier: repository, branch, pull request, quick links (copy path or branch, open the PR, and in the desktop app open in editor, terminal or files) and tags sit together at the top; Context shows cost, cache hit rate and a token-mix bar; Changes and Plan get quiet proportion bars; the redundant Thread section is gone.

- Project coordinator and threads: a project's new **Threads** tab starts a coordinator, a session that can start, list, read, message and stop parallel *threads* (ordinary sessions, in worktrees by default) through host tools, and hears back when they finish a turn or fail. The tab lists each coordinator's threads (those that need you first) and edits the project brief and project memory files that every coordinator and thread starts with (stored in Odin under `~/.odin/memory/<project>/`, never in the repo). API: `POST /api/projects/:name/coordinators`, `GET /api/projects/:name/threads`, `/api/projects/:name/brief`, `/api/projects/:name/memory`. See `docs/plans/project-coordinator.md`.
- Claude sessions no longer offer the SDK's `Projects` tool, which only works inside a hosted claude.ai project.
- Breaking: notebooks no longer record who wrote a cell or share kernels across sessions. `NotebookCell.author`, `NotebookNotice`, `sessionId` on executions and execute requests, `GET /api/sessions/:id/notebooks` and `POST /api/sessions/:id/notebooks/:kernelId/attach` are removed, sessions no longer receive notebook-change notices, and migration 0015 drops the session-link and notice tables. Existing `.ipynb` files with author metadata still open.
- Notebooks: the Python environment is detected silently when a notebook opens, and a compact kernel chip in the header (interpreter, state, "Select kernel" when none) replaces the environment callout; its menu holds Interrupt, Restart, Stop, Variables and a link to the new Environment tab. Run errors show on the failing cell, the cwd-mismatch notice is gone, and the cell view is a quiet document (gutter with execution count, status rail, run time). The toolbar (Run all, Restart, Clear outputs, Interrupt, Variables) folds into a menu when the pane is narrow, and a wide pane shows an outline of headings and cells.
- The session's Files panel has an Environment tab: the detected Python environment (detect again, set up, Native/WSL on Windows) and the project's notebook kernels with Stop.
- The session model selector no longer switches to another model after a turn.
- Hand edits to `pricing.json` are picked up even when written within the same timestamp tick (Windows).
- Notebooks open from the Files tab as project files.
- `yarn dev:desktop` launches the Odin Dev desktop app from a terminal, including one inside Odin.
- Sessions started in a terminal take the harness's generated name instead of staying "Untitled session".
- The session's Files panel has a New menu for notebooks, Markdown, text, JSON, HTML and other files (created in the folder being browsed; new files can be created through `POST /api/sessions/:id/files`), shows the browser full height until a file is open, and uses the thin branded scrollbar. The workbench header drops its label, and the chat header's actions sit flush against the chat column in the desktop app.
- The desktop app draws one divider under the window's title bar, across the window and over the Details and preview panels, and the Details header is as tall as the Files header so their dividers line up.
- Claude's model picker shows the real catalog (Haiku 5.5, Fable and every supported effort level) from the start, and a session's concrete model id matches its alias instead of showing as an extra entry.

## [0.1.0]

First public release.

- Sessions on Claude Agent SDK, Codex app-server (native and WSL), Grok, OpenCode and Antigravity, with streaming
  transcripts, tool calls, diffs, permission prompts, plan approval, queued follow-ups and attachments.
- Discovery and resume of sessions started in a terminal; Claude Code hooks for metrics.
- Shared library of instructions, skills, subagents, commands, MCP servers and settings profiles, with per-runtime
  projection and drift detection.
- Per-session workspaces: checkout or git worktree, across one or more repositories.
- Metrics: time, tokens, cost, diff and pull request outcome; read-only GitHub integration.
- Sandboxed artifacts and Python notebooks.
- Electron desktop app with tray, notifications and global launcher shortcut (build from source; Windows).
