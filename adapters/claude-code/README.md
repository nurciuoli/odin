# Claude Code adapter

`src/odin-hook.ts` reports terminal Claude Code sessions to Odin's ingest API (`POST /api/ingest`). Claude Code
hooks run it as `node <abs path>/odin-hook.ts <Event>`. It never blocks or fails the agent: a 2s timeout, every
error swallowed (logged to `~/.odin/hook.log`), exit 0. Grok Build runs the same project hooks; a process with
`GROK_SESSION_ID` set is ignored, so it does not open an empty Claude session.

Install it per project from Odin (`POST /api/projects/:name/tracking/claude-code`), which merges the hooks into
`.claude/settings.local.json` and removes them cleanly. See `docs/contracts.md#claude-code-adapter`.
