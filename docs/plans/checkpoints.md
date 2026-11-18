# Plan: session checkpoints and rewind

Status: **proposed, nothing built.** Phase 0 (this plan) is in review. Owner: open. Related: the harness handoff plan
(both features read and write session state; see "Handoff" below).

## Why

Agents go wrong in the middle of a long session: a bad refactor at step 6, a wrong turn at step 9. Today the choices are
to keep arguing with the agent, or to fork the conversation (`POST /api/sessions/:id/fork`) and clean up the files by
hand. Odin should let you pick any earlier step in a session and either **branch from it** (a new session whose
conversation and files are exactly as they were) or **rewind the session itself** to it, with files restored, and be
able to undo that.

## What a checkpoint is

One checkpoint per **turn**, anchored on the user message that started it.

```
Checkpoint {
  id            string        // stable, `<sessionId>:<n>`
  sessionId     string
  messageId     string        // transcript entry id of the user message (the rewind anchor)
  turn          number        // 1-based
  at            string        // ISO time of the snapshot
  files         { changed: number; added: number; removed: number } | null  // vs the previous checkpoint
  snapshot      "ok" | "skipped" | "failed"   // files could not be captured (too big, not a repo dir, error)
}
```

A checkpoint means "the world just before the agent acted on this message": conversation up to but not including that
message, and the working tree as it was then. Rewinding to a checkpoint of turn N means "turn N never happened".

## Two ways to get there

### A. Harness-native rewind

- **OpenCode** already has revert/unrevert/commitRevert (`NativeSessionAction`), which stages a revert by message id with
  optional file restore.
- **Claude Code** has file checkpointing (`enableFileCheckpointing` and `rewindFiles(userMessageId)` in the Agent SDK)
  and `forkSession` can cut history at a message. These need a spike against the pinned SDK version to confirm the exact
  option names and what is tracked (it records edits made by the file tools, not by `Bash`).
- **Codex** app-server has thread rollback and fork; **Grok ACP** and **Antigravity** are unknown.

Native rewind is good where it exists, but it is five different semantics, covers different tools (Claude's checkpoints
miss shell-made changes), and cannot restore files for a session that moves between harnesses.

### B. Odin shadow snapshots (harness-agnostic)

Core snapshots the working tree itself at every turn boundary, in a **shadow git repository that Odin owns**, never in
the user's repo. Files are restored from there, whatever harness made the change.

- Store: `~/.odin/checkpoints/<project>/<hash of cwd>.git`, a bare repo. Commands run as
  `git --git-dir=<store> --work-tree=<cwd> …` with `execFile` argv (AGENTS.md: no shell strings). The user's `.git`,
  index, refs, stash and hooks are never touched, which keeps the contract line "Odin never commits, resets, pushes".
- Capture: `add -A` then `write-tree` and `commit-tree` with a fixed identity and `gc.auto=0`. The user's `.gitignore`
  files apply naturally because the work tree is the repo; `node_modules`-style bulk is therefore ignored in normal
  projects. Extra guards: skip files over 5 MB, skip nested repos and submodules, give up and mark the checkpoint
  `skipped` above 20,000 files or a 10 s budget, so a huge directory never stalls a turn.
- When: a `before` snapshot at `turn.start` of each user message (this is the checkpoint's tree) and a snapshot at
  `turn.end`, so manual edits between turns are not blamed on the next turn and a turn's diff is `before → end`.
  Snapshots run off the event loop and never block the turn.
- Restore: first take a `pre-restore` snapshot (so a rewind is undoable), then `read-tree` the target, `checkout-index
  -a -f`, and delete only files that exist in the latest snapshot but not in the target. Untracked, ignored files
  (build output, `.env`) are never deleted. Restore requires an idle session with an empty message queue, like native
  actions.
- Windows and CI: `core.autocrlf=false`, `core.longpaths=true`, `core.quotepath=off`; paths are always handled through
  `node:path` and compared case-sensitively only on POSIX.
- Retention: per-project cap (default 200 checkpoints and 500 MB), oldest pruned with `git gc --prune`; the store is
  removed when the session or project is deleted.

### Decision

**Files: shadow snapshots for every harness (B). Conversation: native, through a new optional `forkAt` capability on the
harness (A).** Reasons: one mental model and one file-restore code path across harnesses, snapshots cover `Bash`
edits, and they survive a handoff to another harness. Native file checkpointing stays out of v1 (the spike may revisit
it as a faster path for Claude). Conversation truncation cannot be faked harness-agnostically, because Odin keeps no
transcript of its own, so harnesses that cannot truncate get "branch files only" (a new session starting from the
restored files with a summary prompt) instead.

## Rewind modes (what the user sees)

1. **Branch from here** (default, non-destructive). A fork cut at the message, in its own worktree whose files are the
   checkpoint's tree. The parent is untouched. Needs `forkAt`.
2. **Rewind this session** (destructive, confirm). Conversation cut at the message, files restored in place, the
   message text put back in the composer. Needs `forkAt` truncation in place or, where the harness only offers fork,
   it forks and archives the original (keeps the old one as a branch, shown in the branch tree). Offers
   **Undo rewind** until the next turn starts.
3. **Restore files only.** Conversation continues as is; files return to the checkpoint. Works on every harness.
4. **Fork conversation only.** The existing fork, cut at the message, files left alone.

The dialog lists the files each mode would change (from the checkpoint diff) before anything is written.

## Contract changes (own PR, label `contract`)

- `packages/shared/src/api.ts`: `Checkpoint`, `CheckpointDiff`, `RestoreCheckpointRequest { files, conversation }`;
  `HarnessCapabilities.checkpoints?: { forkAt: boolean }`; `ForkSessionRequest.atMessageId?` and `restoreFiles?`.
- `packages/shared/src/events.ts`: `checkpoint.created` (and `checkpoint.restored`) session events.
- `packages/core/src/harness/types.ts`: `StartOptions.forkAtMessageId?`; `Harness.forkAt?(sessionId, messageId,
  projectPath?) → newId`.
- `packages/core/src/services.ts`: a `CheckpointService` (`list`, `diff`, `restore`, `capture` hooks used by the
  session turn lifecycle, `prune`).
- DB: migration `0020_checkpoints.sql`, table `checkpoints(session_id, id, message_id, turn, at, before_tree,
  end_tree, files_json, snapshot)` cascading on session delete.
- Routes: `GET /api/sessions/:id/checkpoints`, `GET …/checkpoints/:cid/diff`,
  `POST …/checkpoints/:cid/restore` (409 when the session is not idle or the queue is not empty), and the fork route
  accepting `atMessageId`.
- `docs/contracts.md`: the checkpoint section, capability table row, and the rule that the shadow store is Odin-owned.
- `web/src/api/types.ts` mirrors it, with mock fixtures.
- Project setting `checkpoints: { enabled, maxCount, maxBytes }`, default on.

## Phases (one concern per PR)

| # | PR | Notes |
|---|---|---|
| 0 | `docs: plan session checkpoints and rewind` | this file |
| 1 | `feat(shared): add checkpoint contracts` (types, harness interface, migration, `docs/contracts.md`, fake harness `forkAt`) | `contract`, no behaviour yet |
| 2 | `feat(core)`: shadow store, capture on turn boundaries, list/diff/restore routes, retention | tested with `testDeps()` and temp repos; includes a Windows path test |
| 3 | `feat(harness)`: `forkAt` for Claude first, then Codex and OpenCode; others report `forkAt: false` | spike for the SDK first |
| 4 | `feat(web)`: checkpoint markers, rewind dialog, undo, branch tree link; screenshots reviewed by Nick before it is final | mock data covers every mode |
| 5 | follow-ups: settings screen, native Claude file checkpoints as a fast path, extra repositories | only if wanted |

## Handoff

The handoff feature moves a session to another harness at some point in its history. A checkpoint is exactly that
point: keyed by Odin session id and message id, harness-independent, and carrying the file state. Proposal: handoff
takes an optional `checkpointId` instead of inventing its own anchor, and the new session inherits the parent's
checkpoint list up to that point. Whichever lands first owns the shared types; the other rebases on them.

## Open questions

- Snapshot cost on very large repos: is the 20,000 file / 10 s budget acceptable, or should it be a setting?
- Should `additionalDirectories` (extra repositories) be snapshotted? v1 says no: only the session's `cwd`.
- In-place rewind on harnesses that can only fork: archive the original (proposed) or delete it?
- Retention defaults (200 checkpoints, 500 MB) are guesses.
