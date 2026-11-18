# Plan: plugins as a library kind

Status: **proposal, nothing built.** Owner: open. Part of the MCP and plugin work (the secrets vault, MCP OAuth and the
MCP servers screen are separate PRs; their plan is `docs/plans/mcp-integration.md` once those land).

## Why

A "plugin" in the Claude Code world is a bundle: skills, subagents, slash commands, hooks and MCP servers that are
installed and updated together. Odin's library already holds each of those parts (`skill`, `agent`, `mcp`, `settings`,
`instruction`) with install, drift and push-back, but only one part at a time. Today the only plugin support is
read-only: `NativeCatalog.plugins` lists names for OpenCode and `updatePlugins` updates them, and each harness has its
own incompatible plugin system. Odin's pitch is that you set things up once and every harness gets them, so the plugin
unit should live in Odin's library rather than be a thin wrapper over several native systems.

## Proposal

**A library asset kind `plugin`: a manifest that names other library assets.**

```
~/.odin/library/plugins/<id>/plugin.json
{
  "name": "Release helper",
  "description": "Changelog, release notes and the publish MCP server.",
  "version": "1.2.0",
  "includes": [
    { "kind": "skill", "id": "release-notes" },
    { "kind": "agent", "id": "release-reviewer" },
    { "kind": "mcp", "id": "publish" },
    { "kind": "settings", "id": "release-permissions" }
  ]
}
```

- A plugin owns no content of its own. Its members are ordinary library assets, so they stay editable, versioned and
  usable alone. Pinning a member to a version is optional (`"version"` per member); the default follows the current one.
- **Install** installs each member through the existing install path (copy for skills and agents, merge for MCP and
  settings, a fragment for instructions), then records one plugin `Installation` row that remembers which members it
  wrote. Files are written and nothing is committed, as today.
- **Drift** is computed per member with the existing machinery and rolled up: current, update available, modified,
  conflict, missing. Update and forget act on the members the plugin installed and nothing else, so a member another
  plugin or the person installed by hand is never removed by accident (reference-counted by installation rows).
- **Secrets and sign-in** need no new mechanism: a member MCP spec already says `${secret:NAME}` or `oauth`; the
  plugin's page lists what is missing across its members.
- **Harness fit.** Members project to each harness the way they do now (Claude `.claude/…`, Codex and OpenCode
  projections, `.mcp.json`). A member a harness cannot use (a hook for Codex, an SSE server for Codex) is reported as a
  warning on the install result, not an error.

## Import and sharing

Writing a manifest by hand is fine for personal bundles, but most plugins will come from elsewhere.

- **Import from a Claude Code plugin** (a directory with `.claude-plugin/plugin.json`, `skills/`, `agents/`,
  `commands/`, `hooks/`, `.mcp.json`): a one-way conversion that creates library assets (skills, agents, MCP specs,
  settings fragments for hooks; commands become skills, as the legacy-command migration already does) plus the
  manifest. Collisions follow the library's existing rule (existing assets win, new ones are prefixed). The manifest
  names the source (`"source": { "type": "git", "url": "…", "rev": "…" }`) so a later "check for updates" can re-import.
- **Sources are git URLs or local paths only.** No registry, no marketplace service, no auto-update. Odin clones with
  `git` via argv (never a shell) into a temp directory under `<home>`, reads files, and deletes it.
- **Trust**: a plugin can ship hooks and stdio MCP commands, which run code. Import shows every command, hook and MCP
  server it would add before anything is written, and nothing runs at import time. Fetched content is untrusted data:
  path checks (no `..`, no symlink escapes), the library's file and size limits, no executable bit preserved.

## Contract changes (expected, in this order)

1. `packages/shared`: `AssetKind` gains `plugin`; `LIBRARY_LAYOUT` and `INSTALL_TARGETS` entries (a `bundle` install
   mode); `PluginSpec`; a rolled-up state on `Installation`. `docs/contracts.md` Library section.
2. Core: manifest parser and validator in `library/parse.ts` (members must exist and be installable kinds; no plugin
   inside a plugin; unique members); install, update, forget and drift for bundles in `library/service.ts`; a
   migration for membership (a table is likelier than new columns).
3. Import: `POST /api/library/import` takes a source and returns a preview (assets, commands, hooks, MCP servers,
   warnings); a second call with the confirmed preview id writes it.
4. Web: a Plugins tab in the Library, a plugin page (members, per-harness warnings, missing secrets and sign-ins,
   install into a project), and an import dialog with the preview.

Each step is its own PR; step 1 lands first as a contract PR.

## Alternatives considered

- **Wrap each harness's native plugin system.** Least work for Claude Code, but the formats differ, the native catalog
  cannot install or enable anything, and nothing carries across harnesses. Keep the native catalog as a read-only view.
- **A plugin as a copied folder with its own files.** Simple to share as a zip, but it forks content out of the library,
  so edits, versions and drift stop working for those files. A manifest of references keeps one source of truth.
- **A marketplace.** Out of scope: discovery, signing and update policy are a product of their own. Git sources cover
  sharing between a few people and teams.

## Open questions for Nick

1. Is "a bundle of existing library assets" the right unit, or should a plugin be able to carry private files too?
2. Should import be one-way only (as proposed), or should Odin also export a library plugin as a Claude Code plugin so
   it can be shared with people who don't use Odin?
3. Is git-URL-only sourcing enough for v1?
4. Hooks are the risky member. Allow them in plugins from day one behind the preview, or leave hooks out of v1?
