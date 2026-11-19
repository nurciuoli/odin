# Plan: UX sweep (Library management and file management)

Status: **designs approved by Nick (Nov 18 2026). Phase 1 (#51), phase 2 (#54) and the Files core API are in review; the Files screen is next.** Mockups: branch
`claude/project-thread-g7q1zg` (`packages/web/src/screens/ux/UxSweep.vue`, route `/ux/<view>`, not for merging).

## Why

Library items and project files can be created and viewed, but not managed. MCP servers live on their own screen
away from the rest of the Library, there is no way to switch an item off without deleting it, and Files can only
create and save, not rename, move or delete.

## Phases (each its own PR)

0. **This plan.**
1. **`enabled` contract** (`feat(shared)`, label `contract`). `LibraryAsset.enabled: boolean` (default true). Stored in
   the database, not in library files, so the library folder stays portable: migration `0019_library_enabled.sql`
   adds `library_disabled (kind, asset_id, disabled_at)`. `PATCH /api/library/:kind/:id` with `{ enabled }` emits
   `library.updated`. A disabled asset:
   - cannot be installed or updated into a project (409; forget and push still work, installed copies are untouched);
   - cannot be picked at launch (400); resume and fork skip it silently so old sessions keep working;
   - for `instruction/global`, is left out of the prompt.
   Plugins: disabling a plugin blocks its install and update; its members are unaffected.
2. **Library half** (`feat(web)`). MCP servers become a Library tab (status, Sign in / Set secret, Secrets panel);
   the sidebar entry goes and `/mcp` redirects to `/library?kind=mcp`. Every tab gets: row checkbox, Enabled switch,
   a ⋯ menu (Edit, Install, Disable, Duplicate, Export for plugins, Delete), a bulk bar (Enable, Disable, Install,
   Delete), a "Used in" column, and a delete dialog that shows install count and offers "Disable instead".
   Duplicate is a client-side save under a new id. No new contract beyond phase 1.
3. **Files half** (`feat(core)` then `feat(web)`). Core: rename, move, duplicate, trash (soft delete into
   `<home>/trash/<project>/`, outside the repo so it never shows in git status, kept 7 days), list trash, restore, empty trash. All paths checked inside the project; 409
   on name clash or when a running notebook kernel uses the path (`notebooks.usesPath`). Web: row ⋯ menu, selection
   bar, drag a row onto a folder to move, Move dialog (folder picker), Rename dialog, Undo toast, a Trash view,
   shortcuts F2 (rename), ⌘M (move), ⌫ (trash).

## Decisions made

- Disable is a soft switch, not an uninstall: nothing is removed from projects or disk.
- Delete in the Library stays a hard delete (it already exists); the dialog is where "disable instead" is offered.
- Files deletes always go to trash first; nothing is unlinked until the trash expires or is emptied.
- Orange stays off text; the accent is for primary buttons and switches only.

## Out of scope

Per-project enable/disable, undo for Library deletes, renaming Library ids (ids are slugs other things refer to).
