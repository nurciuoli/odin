# Changelog

Notable changes to Odin. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

- Hand edits to `pricing.json` are picked up even when written within the same timestamp tick (Windows).
- Notebooks open from the Files tab as project files.
- `yarn dev:desktop` launches the Odin Dev desktop app from a terminal, including one inside Odin.
- Sessions started in a terminal take the harness's generated name instead of staying "Untitled session".

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
