# Plan: plugins as a library kind

Status: **design agreed with Nick (Nov 18 2026), nothing built.** Owner: open. Part of the MCP and plugin work (the secrets vault, MCP OAuth and the
MCP servers screen are separate PRs; their plan is `docs/plans/mcp-integration.md` once those land).

## Why

A "plugin" in the Claude Code world is a bundle: skills, subagents, slash commands, hooks and MCP servers that are
installed and updated together. Odin's library already holds each of those parts (`skill`, `agent`, `mcp`, `settings`,
`instruction`) with install, drift and push-back, but only one part at a time. Today the only plugin support is
read-only: `NativeCatalog.plugins` lists names for OpenCode and `updatePlugins` updates them, and each harness has its
own incompatible plugin system. Odin's pitch is that you set things up once and every harness gets them, so the plugin
unit should live in Odin's library rather than be a thin wrapper over several native systems.

## Proposal

**A library asset kind `plugin`: a folder with a manifest that names other library assets and can carry its own files.**

```
~/.odin/library/plugins/<id>/plugin.json
~/.odin/library/plugins/<id>/skills/release-notes/SKILL.md      (own members, optional)
~/.odin/library/plugins/<id>/agents/release-reviewer.md
~/.odin/library/plugins/<id>/mcp/publish.json
~/.odin/library/plugins/<id>/settings/release-permissions.json

{
  "name": "Release helper",
  "description": "Changelog, release notes and the publish MCP server.",
  "version": "1.2.0",
  "includes": [
    { "kind": "skill", "id": "changelog" }
  ]
}
```

- A plugin has two kinds of members. **Own members** are files in the plugin's folder, laid out like the library
  (`skills/`, `agents/`, `mcp/`, `settings/`, `instructions/`); they belong to the plugin, travel with it, and are
  versioned with it. **Included members** (`includes`) are references to ordinary library assets, which stay editable,
  versioned and usable alone. Pinning an included member to a version is optional (`"version"`); the default follows
  the current one. An own member and an included one may not share a kind and id.
- A plugin's version is the hash of its manifest and own files, plus the pinned versions of what it includes, so a
  change to either side shows as an update. The `"version"` field is a label for people.
- **Install** installs each member (own files and included assets) through the existing install path (copy for skills and agents, merge for MCP and
  settings, a fragment for instructions), then records one plugin `Installation` row that remembers which members it
  wrote. Files are written and nothing is committed, as today.
- **Drift** is computed per member with the existing machinery and rolled up: current, update available, modified,
  conflict, missing. Update and forget act on the members the plugin installed and nothing else, so a member another
  plugin or the person installed by hand is never removed by accident (reference-counted by installation rows).
  Own members install under the id they have in the plugin; a collision with something already in the project is a
  409 unless forced, as for any install.
- **Secrets and sign-in** need no new mechanism: a member MCP spec already says `${secret:NAME}` or `oauth`; the
  plugin's page lists what is missing across its members.
- **Harness fit.** Members project to each harness the way they do now (Claude `.claude/…`, Codex and OpenCode
  projections, `.mcp.json`). A member a harness cannot use (a hook for Codex, an SSE server for Codex) is reported as a
  warning on the install result, not an error.

## Import and sharing

Writing a manifest by hand is fine for personal bundles, but most plugins will come from elsewhere.

- **Import from a Claude Code plugin** (the result keeps the plugin's own files as own members, so nothing is
  split out into the shared library unless the person promotes it) (a directory with `.claude-plugin/plugin.json`, `skills/`, `agents/`,
  `commands/`, `hooks/`, `.mcp.json`): a one-way conversion that creates library assets (skills, agents, MCP specs,
  settings fragments for hooks; commands become skills, as the legacy-command migration already does) plus the
  manifest. Collisions follow the library's existing rule (existing assets win, new ones are prefixed). The manifest
  names the source (`"source": { "type": "git", "url": "…", "rev": "…" }`) so a later "check for updates" can re-import.
- **Export to a Claude Code plugin**: a plugin (own members and included assets resolved at their current or pinned
  version) is written as a directory with `.claude-plugin/plugin.json`, `skills/`, `agents/`, `hooks/` and
  `.mcp.json`, into a folder or a zip the person picks, so people who don't use Odin can install it. Secrets stay as
  `${secret:NAME}` placeholders (never values) and OAuth settings are dropped with a note, since neither is portable.
  Members a Claude Code plugin cannot express (library instructions fragments) are listed as skipped.
- **Sources are git URLs or local paths only** (decided for v1). No registry, no marketplace service, no auto-update. Odin clones with
  `git` via argv (never a shell) into a temp directory under `<home>`, reads files, and deletes it.
- **Trust**: a plugin can ship hooks and stdio MCP commands, which run code, and hooks are allowed from day one.
  Every install path, not only import, shows the preview first: every command, hook and MCP server the plugin would
  add, with the exact text, before anything is written, and nothing runs at install time. Updating a plugin shows only
  what changed in that list and asks again when a hook or command is new or different. An unreviewed plugin never
  installs from a non-interactive call: the API takes the confirmed preview id, as for import. Fetched content is untrusted data:
  path checks (no `..`, no symlink escapes), the library's file and size limits, no executable bit preserved.

## Contract changes (expected, in this order)

1. `packages/shared`: `AssetKind` gains `plugin`; `LIBRARY_LAYOUT` and `INSTALL_TARGETS` entries (a `bundle` install
   mode); `PluginSpec`; a rolled-up state on `Installation`. `docs/contracts.md` Library section.
2. Core: manifest parser and validator in `library/parse.ts` (members must exist and be installable kinds; no plugin
   inside a plugin; unique members); install, update, forget and drift for bundles in `library/service.ts`; a
   migration for membership (a table is likelier than new columns).
3. Import and export: `POST /api/library/import` takes a source and returns a preview (assets, commands, hooks, MCP
   servers, warnings); a second call with the confirmed preview id writes it. `POST /api/library/plugin/:id/export`
   writes the Claude Code layout. Installs of a plugin that carries hooks or commands take the same preview id.
4. Web: a Plugins tab in the Library, a plugin page (own and included members, per-harness warnings, missing secrets
   and sign-ins, install into a project, export), and one preview dialog used by import and install.

Each step is its own PR; step 1 lands first as a contract PR.

## Alternatives considered

- **Wrap each harness's native plugin system.** Least work for Claude Code, but the formats differ, the native catalog
  cannot install or enable anything, and nothing carries across harnesses. Keep the native catalog as a read-only view.
- **Only copied folders, or only references.** Copies alone fork content out of the library, so edits, versions and
  drift stop working for shared parts; references alone cannot carry a plugin's private files. Own plus included
  members cover both.
- **A marketplace.** Out of scope: discovery, signing and update policy are a product of their own. Git sources cover
  sharing between a few people and teams.

## Decisions (Nick, Nov 18 2026)

1. A plugin can carry its own files as well as reference library assets.
2. Odin imports and exports Claude Code plugins.
3. Git URLs and local paths are enough as sources for v1.
4. Hooks are allowed from day one, behind the install preview.

## Still open

- Whether promoting an own member into the shared library (and replacing it with an include) is a v1 action or later.
- How export treats a plugin whose included asset has no portable form (an instructions fragment, an OAuth server).
  The proposal skips and lists them; a stricter option is to refuse the export.
