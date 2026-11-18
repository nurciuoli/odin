# Plan: project coordinator and threads

Status: **prototype in core** (no web UI yet). Owner: open.

## Why

Claude Code shipped **Projects** (public beta, autumn 2026): one long-running conversation where Claude acts as a
*coordinator*, turns what you send into parallel *threads* (each a full cloud session), gives every thread the
project's instructions and memory, and shows which threads need you
([docs](https://code.claude.com/docs/en/claude-projects)).

Odin can't adopt that product directly:

- It is hosted only: claude.ai/code, the desktop and mobile apps. Not the CLI, not the Agent SDK.
- The Agent SDK (0.3.32x) has no option to create a project, bind a session to one, or start threads. It only ships a
  built-in `Projects` *tool* (`project_info`, `project_read`, `project_search`, `project_write`, `project_delete`,
  `project_memory_list`, `project_memory_read`), which reads the claude.ai project a hosted thread belongs to. It
  has nothing to read in a local session.
- It needs claude.ai accounts, cloud environments and the Claude GitHub App, and it is Claude-only. Odin is local,
  harness-agnostic and never touches credentials.

But the *idea* fits Odin well, and most parts already exist: projects, sessions on any harness, worktrees,
`waiting` state, the library, artifacts and host tools. This plan adds the missing layer.

## Concepts

| Claude Code Projects | Odin |
|---|---|
| Project | An Odin project (a directory). Unchanged. |
| Project conversation (coordinator) | A **coordinator session**: an ordinary Odin session in the project, started with a role, that gets coordinator host tools. A project may have several coordinators (one per stream of work). |
| Thread | A **thread**: an ordinary Odin session started by a coordinator's `start_thread`, by default in its own worktree. Shows up everywhere sessions do. |
| Project instructions (16k chars) | **Project brief**: text stored in Odin (not in the repo), sent to every coordinator and thread at start. Same 16,000 character cap. |
| Project memory (`MEMORY.md` + files) | **Project memory**: Markdown files in `<ODIN_HOME>/memory/<project>/`, plain files like the library. `MEMORY.md` is the index and goes into every coordinator's and thread's instructions; other files are read on demand through a tool. |
| Overview pane / Library | Project tab: coordinators, their threads with state (`waiting` first), and the artifacts and branches threads produced. Phase 2. |
| Threads report back | When a thread finishes a turn or fails, Odin sends the coordinator a short update message (through the durable outbox, so it queues behind a running turn). |
| Thread on your computer (Remote Control) | Not needed: every Odin session already runs on your computer. |

Repo files (`CLAUDE.md`, `AGENTS.md`, skills, `.mcp.json`) keep working exactly as today: threads are normal
sessions in a checkout or worktree. That is a real advantage over hosted threads, which skip repo skills and MCP.

## Design

### Module

A new core module, `packages/core/src/coordination/` (`service.ts`, `routes.ts`), implementing
`CoordinationService` from `services.ts`. It owns two tables (migration `0016_coordination.sql`) and the memory
directory. It never touches harness types: everything goes through `services.sessions`.

```
coordinators(session_id PK, project, created_at)
threads(session_id PK, coordinator_id, project, task, created_at)
project_briefs(project PK, instructions, updated_at)
```

No foreign keys to `sessions`: the coordination row is written just before `sessions.start` creates the session
record (so the first `hostTools(id)` call already sees the role). Listings join `sessions` and drop orphans.

### Seams into sessions (contract)

- `SessionsService.start(req, options?: { id?: string })`: the caller may pick the new session's id. Coordination
  uses it to register the role before the harness starts.
- Sessions asks coordination for two things when it starts or resumes a handle:
  - `coordination.hostTools(sessionId)`: coordinator tools for a coordinator, thread tools for a thread, nothing
    otherwise.
  - `coordination.instructions(sessionId)`: the role text, the project brief and `MEMORY.md`, or null.

Both are read on every start and resume, so brief and memory edits reach the *next* start of any session, and a
coordinator keeps its tools across Odin restarts.

### Host tools

Harness-neutral `HostTool`s (Claude: `mcp__odin__<name>`), so coordinators and threads work on every harness that
supports host tools.

Coordinator:

| Tool | Does |
|---|---|
| `start_thread(task, title?, worktree?=true, model?)` | Starts a thread in the coordinator's project(s) on the coordinator's harness, permission mode and model. Refuses past 6 threads running or waiting at once. |
| `list_threads()` | Id, title, state, what it waits for, branch, task. |
| `read_thread(thread_id)` | State plus the thread's latest reply (bounded), for results the update message cut. |
| `message_thread(thread_id, message)` | Follow-up or correction; queued if the thread is busy. |
| `stop_thread(thread_id)` | Ends the live handle (resumable, like End in the UI). |
| `update_brief(instructions)` | Replaces the project brief (≤ 16,000 chars). Reaches new threads, not running ones. |

Coordinator and threads:

| Tool | Does |
|---|---|
| `memory_list()` / `memory_read(path)` | Project memory files. |
| `memory_write(path, content)` | Create or replace a memory file (Markdown, ≤ 64 KB, ≤ 200 files). Keep `MEMORY.md` as the index. |
| `memory_delete(path)` | Forget one. |

Only tools that a coordinator owns can address its threads: `read_thread`, `message_thread` and `stop_thread`
refuse a session that is not one of the caller's threads.

### Thread updates

Coordination subscribes to `sessions.onUpdated`. When a thread goes `running → idle` it sends the coordinator:

```
[Odin thread update] "Fix flaky checkout test" (thread 3f2a…) finished a turn on branch odin/fix-flaky-…:
<the thread's latest reply, first 2,000 chars>
```

and a shorter message when a thread fails. `waiting` is not forwarded: only the user can answer a permission
prompt, so it is surfaced in the UI instead (phase 2). Updates go through `sessions.send`, so they queue durably
behind a running coordinator turn, and resume a coordinator whose handle was closed.

### Safety

- Threads are normal sessions: same permission prompts, modes and approvals. A coordinator can't answer a thread's
  permission prompt, and can't raise a thread's permission mode above its own.
- Memory paths are relative, `.md` only, confined with `resolveInside` (no `..`, no symlinks out).
- No secrets pass through: tools return session metadata and assistant text only.
- Concurrency cap per coordinator (6 running or waiting). A daily cap and a per-project budget can follow once
  metrics show real usage.
- The SDK's own `Projects` tool is disallowed in Odin's Claude sessions: it only makes sense inside a hosted
  claude.ai project.

## REST (prototype)

| Route | Body / result |
|---|---|
| `POST /api/projects/:name/coordinators` | `StartCoordinatorRequest` (the session start fields minus `project`) → `Session` |
| `GET /api/projects/:name/threads` | `ProjectThreads`: coordinators and their threads with session records |
| `GET /api/projects/:name/brief` | `ProjectBrief`: instructions and the memory file list |
| `PUT /api/projects/:name/brief` | `{ instructions }` → `ProjectBrief` |
| `GET /api/projects/:name/memory?path=` | `{ path, content }` |
| `PUT /api/projects/:name/memory` | `{ path, content }` → `ProjectBrief` |
| `DELETE /api/projects/:name/memory?path=` | 204 |

SSE: none new. Thread and coordinator changes are already `session.updated` events; the web groups them with
`GET …/threads`.

## Phases

1. **Core prototype** (this change): module, tables, host tools, updates, REST, tests on `fakeHarness()`.
   The contract parts (`services.ts`, shared types, migration) should land as their own PR before the module when
   this graduates from prototype.
2. **Web**: a "Coordinator" start option on the new-session screen; a project tab section listing coordinators and
   threads (waiting first, using `@/styles/status`), thread rows link to sessions; brief and memory editors.
   Coordinator session screen shows its threads beside the transcript.
3. **Polish**: suggested threads (coordinator proposes, user clicks to start), thread budgets, closing a thread's
   worktree when its branch merges (sync already links PRs), forwarding `waiting` as a desktop notification naming
   the coordinator.

## Open questions

- Should a coordinator be allowed to start threads on a *different* harness than its own (e.g. Codex threads from a
  Claude coordinator)? Easy to add (`harness` param); left out until there's a reason.
- Should the brief live in `PROJECT.md` instead? Odin never writes `PROJECT.md`, so no: it stays in Odin's state,
  like project sources.
- Memory in the library (shareable across projects) vs per project: per project for now.
