# Changelog

Notable changes to Odin. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
