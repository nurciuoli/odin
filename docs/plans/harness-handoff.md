# Plan: hand a session off to another harness

Status: **built: contract, core and web (the `/handoff` command and picker) are all in one PR; not yet released.** Approved by Nick (Nov 18 2026). Related: session
checkpoints and rewind (separate thread; both touch session state, see "Interaction with checkpoints").

## Why

Odin's pitch is that the harness is a choice, not a commitment. Today you can pick a harness when a session starts,
but you cannot change your mind halfway: the Claude session that has done two hours of work is stuck on Claude. Reasons
to move anyway: a usage limit or outage, wanting a second opinion from a different model, a cheaper model for the
mechanical tail, or a harness that has a tool the first one lacks.

Native histories are not portable (Claude's JSONL, Codex's rollout, OpenCode's store), and Odin will not try to
convert one into another. A handoff carries what a new agent needs to carry on, not the conversation itself.

## What a handoff is

**A new session on the target harness, in the same working directory and branch, that starts with a briefing written
from the old session, and is linked to it.** The old session is kept as it was (read-only history) and ended.

Same checkout on purpose: the files are the real shared state. The new agent sees exactly what the old one left,
including uncommitted edits, so there is no patch to move and nothing to merge. Because both sessions would otherwise
share a checkout, the source must not be running: `running` or `waiting` sources are refused with 409 (stop it first).

### The briefing

Built by Odin, deterministically, with no model call (so it is instant, free, testable and works when the source
harness is the thing that is down). Sections, each capped, in this order:

1. **Task**: the session's first prompt, verbatim (capped at 4 KiB).
2. **Where it stands**: the source's last assistant message (capped at 4 KiB), which is usually its own summary.
3. **Plan**: the source's todo list with states, when it has one.
4. **Recent conversation**: the last few user and assistant exchanges, tool calls reduced to one line each.
5. **Working tree**: branch, and `git status --short` plus `git diff --stat` for the cwd (bounded, never file
   contents).
6. **Source**: harness, model, session title and Odin session id, so the new agent can say where the context came from.

Total cap 24 KiB. Anything cut is marked `[… cut]`; the response says `truncated: true`. The text is plain Markdown.

The briefing is **previewed through the API** (`GET /api/sessions/:id/handoff?harness=` returns it with the target's
models and availability) and the web uses that for model choices. The web has no briefing editor: `/handoff` sends the
generated one. A client may still send its own `brief` on `POST`.

### What does not carry over

- Native thinking blocks, tool results, attachments and subagent history (the briefing may mention them).
- Native runtime controls (`runtimeOptions`) and effort: they are harness-specific, so the new session starts with the
  target's defaults, or the request's `model`/`permissionMode`.
- Live processes: a shell or kernel the old agent started. Notebook kernels shared through Odin stay attached
  (they belong to the project, not the harness).
- Usage: the new session's metrics count only its own work; the link lets the UI show the chain.

Library MCP selections, the project list and tags are copied. The `launch_config` MCP ids are re-resolved for the
target (a harness that cannot take a given server type fails explicitly, like resume).

## Contract

- `Session.handoff: SessionHandoff | null` with `{ from: string; harness: HarnessId; at: string }` (the source's id
  and harness, and when). New nullable column `sessions.handoff` (JSON), migration `0021_session_handoff.sql`.
  `parentId` is **also** set to the source so existing tree views (branch tree, hover cards, sidebar) show the link
  without learning a new relation; `handoff` is what says it was a harness change rather than a fork.
- `GET /api/sessions/:id/handoff?harness=<id>` returns `HandoffPreview`:
  `{ brief: string; truncated: boolean; source: { harness, model, title }; target: { harness, name, available,
  note, models: ModelInfo[] }; files: string[]; branch: string | null }`. `files` are the paths from `git status`
  (display only). 400 for an unknown harness or the same harness as the source, 404 unknown session.
- `POST /api/sessions/:id/handoff` with `HandoffRequest`:
  `{ harness: HarnessId; brief?: string; model?: string; permissionMode?: PermissionMode; title?: string;
  endSource?: boolean }` returns `Session` (201). Errors: 400 same/unknown harness, invalid `permissionMode` for the
  target, unsupported attachments or additional directories; 404 unknown session; 409 source running or waiting, or the
  target unavailable. `endSource` defaults to true.
- No harness interface change: the new session is an ordinary `harness.start({ cwd, prompt })` on the target.
  `harness/types.ts` and `services.ts` change only by the new `sessions.handoff` and `sessions.handoffPreview` methods.

## What was built

Contract, core and web landed together (they were developed as three stacked PRs):

1. **Contract**: types in `packages/shared/src/api.ts`, `docs/contracts.md` (Sessions section and the REST table), the
   migration, `Session.handoff` (optional, absent means null).
2. **Core**: `packages/core/src/sessions/handoff.ts` (briefing builder, pure and unit-tested on transcripts), the
   `handoffPreview` and `handoff` service methods and the two routes. Tests use `fakeHarness()` for source and target.
3. **Web**: the `/handoff [harness] [model]` slash command (also in the session menu and the palette). With a harness
   it runs at once. Bare `/handoff` shows a compact card with one line per harness: ↑↓ or 1–9 pick the harness, ←→ or
   Tab cycle its models, Enter hands off, Esc cancels. The new session's details show "Continued from <harness>
   session"; the old one shows "Continued on <harness>".

## Interaction with checkpoints

Checkpoints snapshot files and a point in one session's history; a handoff is a new session. They compose: a handoff
from a rewound session briefs from the history as it now stands. Both need `Session` columns and both touch
`sessions/service.ts`, so migration numbers and the `Session` type are the merge points: this plan takes migration
`0021` (checkpoints take `0020`); whichever lands second renumbers.

## Open questions

- Anchoring a handoff at a checkpoint (`checkpointId` on the request, the new session inheriting the checkpoint list up
  to it) is agreed in principle with the checkpoints thread. It waits for the checkpoint types to land, then is a
  small additive change to `HandoffRequest`.

- Should the briefing include the harness's `AGENTS.md` handling hints (Claude reads `CLAUDE.md`, Codex reads
  `AGENTS.md`)? Probably not: the repository already carries the right files.
- A "handoff and keep both running" mode (two agents, one checkout) is deliberately out of scope.
