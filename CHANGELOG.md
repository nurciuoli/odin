# Changelog

Notable changes to Odin. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

- The session side panel is one document surface: files and notebooks open in the same viewer under one header, switch with one row of tabs, and go back to the file browser with one button.
- The session side panel's browser opens on the files the session read or changed, each linked to its step in the conversation (and back from the step), with the whole working directory, outputs, notebooks and a filter one click away. Artifacts show in a collapsible subpanel under the browser instead of as tabs.

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
