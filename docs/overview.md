# Odin: overview

Odin is where you run your coding agents. Instead of a terminal per agent per project, you get one view of
everything: what is running, what needs you, what is done, and what it cost.

It does not replace your agents. Each session runs on the agent's own runtime (Claude Agent SDK, Codex app-server,
Grok, OpenCode, Antigravity) with its own installation, login, settings and history, so it behaves exactly as it does
in a terminal, and sessions you start there show up in Odin too. What Odin adds is the layer around them: one place to
work, a library you maintain once, git tools that know which session changed what, and a record of how each session
went.

For a task-by-task tour see the [guide](guide.md). The rest of this page defines the terms (project, session,
harness, library, artifact, notebook), lists what you can do, and explains the design decisions behind them.

## Concepts

**Project**: a directory on disk, usually a git repository, registered by path. Nothing is required inside it. If
the project has a `PROJECT.md` with YAML frontmatter (`title`, `description`, `repo`, `default_branch`, `commands`),
Odin reads it; it never writes it. `README.md`, `docs/STATUS.md` and `docs/plans/` are picked up for the project
overview when they exist.

**Session**: one conversation with a harness. Odin's record points at the harness's own session id and adds what
the harness doesn't hold: projects, title, tags, pinned/archived, origin (started in Odin or discovered from a
terminal), workspace (the checkout, or a git worktree on its own branch) and metrics. A session is
`idle | running | waiting | ended | failed`; *waiting* means it needs you (a permission prompt, a question, a plan
to approve).

**Harness**: a driver that can start, resume, fork, send to, interrupt and list sessions, and that turns the
runtime's native protocol into one common event stream. Everything above the driver (routes, SSE, the web app)
sees only those events, never a runtime's own types.

**Library**: reusable assets in `~/.odin/library/`, a plain directory you can keep in git. Assets are versioned by
content hash. Installing one into a project copies it, and Odin shows when the copy has drifted from the library
(update, keep, or push back). Odin never commits for you. The library is shared across harnesses: each asset is
adapted to the selected runtime at launch (for example, commands become Codex skills, subagents become native
roles), and settings a runtime cannot express are reported, not silently dropped.

**Artifact**: a self-contained HTML document an agent posts in a session, versioned, rendered in a sandboxed frame,
and able to send structured input back into the session.

**Notebook**: an ordinary `.ipynb` file in the project with a lazily started Python kernel, which agents drive
through host tools and you can edit and run in the session workbench.

## What you can do

- **Start a session.** Pick a project (or several), a harness, model, permission mode and workspace, and type.
  Forking a session is the same flow, prefilled. `Mod+K` searches everything and can start one from what you typed.
- **Work in it.** Streamed replies and thinking, tool calls with inputs and results, diffs, nested subagent
  activity, todos, plan approval, permission prompts (allow once / always / deny), interrupt, queued follow-ups,
  attachments, context usage and cost so far.
- **Come back later.** Sessions keep running with the window closed. A session that needs you raises a desktop
  notification and a tray badge. History is one searchable list across projects and harnesses, including sessions
  started in a terminal.
- **Review and commit.** Per-hunk and per-line staging, changes grouped by the turn that made them, blame that names
  the session behind each line, a branch switcher with stash handling, and repo-defined checks before commits and
  pushes.
- **Undo and branch.** Rewind from any of your messages: branch into a new worktree, restore the files, move the
  session back, or fork the conversation. The project Overview shows branches as a git tree.
- **Change agents.** `/handoff` continues a session on another harness in the same folder and branch.
- **Reuse.** Edit library assets in the app, see versions and diffs, install them into projects, and keep MCP secrets
  in the vault.
- **Measure.** Per session: tokens, cost, wall and active time, turns, tool calls, diff stats, and the linked pull
  request and its outcome (optional, read-only GitHub integration).

## Questions people ask

**Is Odin another agent?** No. It starts and watches the agents you already have. Each keeps its own model access,
login and transcripts, and Odin never reads or stores model credentials.

**Will it change my agent configuration?** No. Library assets are copied into a project only when you install them,
Odin never commits for you, and settings a runtime cannot express are reported rather than silently dropped.

**Does it keep my conversations?** No. The harness's own history is the record; Odin keeps session metadata, such as
title, tags, workspace and metrics, and points at the harness's session.

**Can I use it without the desktop app?** Yes. The desktop app is a client of the same local web app a browser
opens. Nothing leaves your machine except what your agents send to their own providers.

## Design decisions

| Question | Decision | Why |
|---|---|---|
| Runtime | Native harnesses, in-process drivers | A session is a real Claude Code / Codex / … session: its own instruction files, skills, MCP, hooks, permissions and on-disk transcripts. Odin stores no transcript of its own. |
| Credentials | The environment's | Odin never reads or stores model credentials; each runtime uses its own login or API key. |
| Form factor | Desktop app over a local web server | Electron for window, tray and notifications; the same web app works in a plain browser. |
| Server | `node:http`, `node:sqlite`, SSE | No web framework, few dependencies, one process. |
| Workspace | Per session | The project checkout by default, or a fresh git worktree on its own branch. |
| Library installs | Copy, with drift detection | Projects stay self-contained and work without Odin. |
| GitHub | Optional, read-only | Links sessions to the pull requests whose head branch they worked on. No issue or remote writes. |
| Trust | Single user, local | Loopback only by default; see the security model in [contracts.md](contracts.md#security-model-single-user-local). |

## Where to go next

- [guide.md](guide.md): what you can do, task by task.
- [shortcuts.md](shortcuts.md): keyboard shortcuts.
- [architecture.md](architecture.md): how the pieces fit.
- [contracts.md](contracts.md): API, SSE, harness, library, ingest and security rules.
- [desktop.md](desktop.md): the Electron shell.
- [development.md](development.md): building, testing and contributing.
