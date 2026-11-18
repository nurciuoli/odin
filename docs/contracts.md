# Odin contracts

How the types in `packages/shared/src/` behave. The types are the source of truth; this file explains the rules
around them. `docs/overview.md` says what Odin is for. Changes here, in `packages/shared/`, in
`packages/core/src/services.ts`, `packages/core/src/harness/types.ts`, `db/schema.sql` or
`packages/web/src/api/types.ts` are **contract changes**: own commit, called out in the PR. If you need one,
say so in the PR.

## Processes

- **odin-core** (`packages/core`, Node 24 running TS directly; 22.18+ works) binds `127.0.0.1:8790`, serves the
  built web app from `packages/web/dist`, the API under `/api`, sandboxed artifact pages under `/a/`, and runs agent
  sessions through harness drivers (in-process SDK; the Claude SDK spawns one `claude` child process per live
  session).
- In development the Vite server (`:5190`) proxies `/api` and `/a/` to core.
- **apps/desktop** (Electron) starts core as a child process and loads the web app from it. The web app never
  depends on Electron: everything also works in a plain browser. See [Desktop shell](#desktop-shell).
- State: `~/.odin/` (`ODIN_HOME`) holds `state.db`, `env` (the ingest token, mode 600), `secrets.json` (the secrets vault, mode 600), `oauth.json` (MCP sign-in tokens, mode 600), `pricing.json`,
  `library/` (plain files) and `worktrees/`. Projects live wherever
  they were registered; Odin never moves them.
- Conversations live in the harness's own store (Claude: `~/.claude/projects/…/*.jsonl`). Odin keeps metadata and
  metrics only.

## Security model (single user, local)

- **Host check** on every request: `Host` must be `127.0.0.1`, `localhost`, `[::1]` (any port), or a hostname
  listed in `ODIN_EXTRA_HOSTS`, else 421. The extra list is for Tailscale Serve, which connects to loopback but
  keeps the tailnet hostname. It does not relax the bind address: core still listens only on `127.0.0.1`.
- **Origin check** on non-GET `/api` requests: an `Origin` header, when present, must be local or one of those
  extra hostnames, else 403.
- **Login check**, only when `ODIN_ALLOWED_LOGIN` is set (core hosted behind Tailscale Serve): every request except
  `POST /api/ingest` and `GET /api/health` must carry that login in `Tailscale-User-Login`, else 401. Serve sets
  the header and strips a client's own. A process on the host can forge it over loopback, so it keeps out other
  tailnet users and devices, not other local users.
- **Ingest token**: `POST /api/ingest` needs `authorization: Bearer <ODIN_INGEST_TOKEN>`. Constant-time compare.
- **GitHub token**: `GITHUB_TOKEN`, else `gh auth token` at boot. Never logged, returned, put in events, or passed to
  harness processes: core deletes `GITHUB_TOKEN`, `GH_TOKEN` and `ODIN_INGEST_TOKEN` from its own environment after
  reading them, because harness processes (and their Bash tools) inherit it. Errors from GitHub are scrubbed of it.
- **Vault secrets** (`<home>/secrets.json`, mode 600): values go in through `PUT /api/secrets/:name` and never come
  out of any response, log, event, `launch_config`, library file or repo file. See [Secrets](#secrets).
- **MCP OAuth tokens** (`<home>/oauth.json`, mode 600): same rules as vault secrets. They leave core only as the
  `Authorization` header of a session's MCP server. See [MCP OAuth](#mcp-oauth).
- **Model credentials are not Odin's.** Whatever the environment gives Claude Code passes through untouched; core
  never reads, stores, logs or returns it. See [Model access](#model-access).
- **Subprocesses** (`git`, `gh`) run with `execFile`/`spawn` and an argv array, never a shell.
- **Paths** from requests are resolved and checked against their root (no `..`, no symlink escapes). Library asset
  paths are checked against the asset root; install targets against the project root.
- **Artifacts** are untrusted HTML. See [Artifacts](#artifacts).
- **Permission prompts**: `title`/`description` come from the harness and the tool input from the model: render as
  text, never HTML.

## Model access

The Claude driver uses `@anthropic-ai/claude-agent-sdk`, which spawns its bundled `claude` binary (a per-platform
optional dependency, `@anthropic-ai/claude-agent-sdk-<os>-<arch>`):

- Authentication is exactly Claude Code's: a `claude` login (`/login`), `ANTHROPIC_API_KEY`, an `apiKeyHelper`, or a
  host-managed provider in the environment. Odin passes `process.env` through and adds nothing. `system/init`
  reports `apiKeySource` (a label such as `user`, `ANTHROPIC_API_KEY`, `none`); the driver may show that label,
  never a value.
- Behaviour the driver relies on: one `query()` stays open across turns and emits one `result` per turn;
  `system/init` is re-sent at the start of every turn; `result.modelUsage` is **cumulative for the CLI process**, per
  model, starting from totals the CLI restores on a resume or fork. Those restored totals are what the CLI last
  saved, which lags when the source session's own process is still running, so they can't be used as a baseline.
  `stream_event`s can arrive even when `includePartialMessages` is off, so the driver tolerates them. Read-only tools
  are auto-allowed without calling `canUseTool`.
- The `uuid` of a streamed `SDKUserMessage` is kept as the stored message uuid, and assistant entry ids match
  between the live stream and `getSessionMessages`, so a reloaded transcript equals the live one.
- Recorded SDK messages (scrubbed) used by the driver tests are in
  `packages/core/src/harness/claude/fixtures/sdk-recording.json`.

## Harness

### Interface and event stream

`packages/core/src/harness/types.ts` (`Harness`, `SessionHandle`, `StartOptions`, `HostTool`) and
`@odin/shared/harness` (`HarnessEvent`, `TranscriptEntry`, `PermissionRequest`).

- Only `src/harness/<id>/**` may import a harness SDK. Everything above sees only these types.
- `Deps.harnesses` maps id → driver. Production: Claude, Codex (and Codex WSL on Windows), Grok, OpenCode
  and Antigravity, or the fake drivers when
  `ODIN_FAKE_HARNESS=1`. Tests: `fakeHarness()` from `harness/fake.ts` (scriptable turns, permission prompts that
  block until answered, host tools, usage, a store so `list`/`messages` work, `seed()` for external sessions).
- **Event stream rules:** `init` first (once per handle); `state` running/waiting/idle; `delta`s then the whole
  `entry` with the same id; `tool.result` after its `entry`; `permission.request` → `state waiting` → (answer) →
  `permission.resolved` → `state running`; `usage`; `turn.end` closes a turn, then `state idle`; exactly one `exit`.
- **User-ended tool calls:** a tool result the user refused or stopped carries `status: "denied" | "interrupted"`
  (`ok` stays false, `text` is a short label). Drivers set it; clients show it as stopped, not as a tool failure.
  Harness-written interrupt markers (for example Claude's `[Request interrupted by user]`) are not user entries.
- `applyHarnessEvent` (`@odin/shared/transcript`) folds events into a transcript. Core and web use the same
  function, so live and reloaded views match.

### Capabilities

- Harness capabilities declare supplemental `instructions`, `additionalDirectories` and `attachments` support.
  False additionalDirectories rejects multi-project launches before side effects. Unsupported instructions are
  reported explicitly; native project instruction discovery remains the runtime's responsibility.
- Drivers accept service-owned outbox dispatch at idle boundaries. They are not durable message queues. Failed
  boundaries/exit leave receipts uncertain; interruption must not release a second invisible user message.
- Native permission scope choices may be narrowed, never broadened.

| Capability | Claude | Codex / WSL | Grok | OpenCode | Antigravity |
|---|---|---|---|---|---|
| Additional repositories | Supported | Supported | Rejected | Supported | Supported |
| Supplemental instructions | Supported | Supported | Warning, unsupported | Supported | Supported |
| Attachments | Images/text | Images/text | Images/text | Supported | Supported |
| Fork at a message (`checkpoints.forkAt`) | Planned | Planned | Not supported | Planned | Not supported |

Claude, Codex and Grok rebuild selected MCP servers from library IDs on resume and fork, and discover project and
worktree sessions. Optional capability fields omitted by a driver keep their default behaviour.

### Native runtime controls

`HarnessCapabilities.native` advertises native primary agents, named model variants, native permission rules
and the exact supported `NativeSessionAction` types. Unsupported native settings/actions fail with 400.
`ModelInfo.variants` is independent of the shared effort enum. `RuntimeOptions` selects a native primary agent
and variant (null restores the native default) and ordered native rules `{ action, resource, effect }` where
effect is allow, deny or ask. Patterns retain their runtime semantics. These options are persisted in the
existing session `launch_config`, retained on fork/resume and passed at the driver boundary. PATCH merges
provided native option fields; a provided permissionRules list replaces the list. Legacy agent/template launch
fields remain rejected; native primary selection uses runtimeOptions.agent.

`GET /api/harnesses/:id/native?project=<name>` returns `NativeCatalog`: display-safe agents, commands, skills,
provider enabled status (not an authentication check), MCP status and plugin identifiers. This response excludes raw runtime configuration,
environment, credentials and MCP headers. `updatablePlugins` contains package targets, excluding built-ins;
plugin updates use those targets. `GET /api/sessions/:id/native` reads `NativeSessionState` without starting
a model turn. `POST /api/sessions/:id/native` executes a typed native action through a live/resumed
handle: compact, revert (stage by messageId, optional files), unrevert (clear staged revert), commitRevert,
command, shell, updatePlugins (explicit plugin identifiers), or reload (native location configuration). Native
state may also include a normalized context transcript and file patches from the native context/diff APIs.
Actions require an idle session and empty durable message queue; competing actions, messages,
settings changes, forks and end requests receive 409 while an operation is in progress. Revert operations clear
the cached live transcript tail so the next detail read reflects authoritative native history. Native actions
are explicit commands, never reconstructed from arbitrary API paths or configuration blobs.

Shared settings profiles may include `opencode: { permissionRules?, instructions? }`. Native policy overrides
do not imply equivalence to Claude permission rules or hooks. Optional `Harness.close()` releases runtime-owned
server resources after live sessions close during server shutdown.

### Session task activity

- `TaskActivity` in shared/harness.ts is a native task **run**, identified by `taskKey({taskId, runId})`.
  Both IDs are opaque; a missing native run ID is null. A new run must use a distinct run ID when available.
  Only session-associated agents and commands qualify; ordinary file/search tools and ambient tasks do not.
- `task` events carry full snapshots and fold into `kind: "task"` transcript entries. Drivers recover the same
  entries from native stored history; Odin adds no task database. Duplicate system/injected notifications
  normalize to the same identity. Progress patches a task; it does not create a new user message.
- States are running, completed, failed, stopped and unknown. Launch-tool completion does not establish child
  completion. Missing snapshot members, parent interruption and transport loss do not establish success.
  `reconcileTaskHistory` changes unreconciled historical running tasks to unknown; live snapshots restore known
  liveness. Terminal outcomes cannot regress to running/unknown within the same run. Older observed snapshots
  cannot overwrite newer state, output or summary. A late start can fill missing authoritative times.
- `startedAt` and `completedAt` are authoritative native times or null. `observedAt` is local observation time,
  never a substitute for a native start or completion time. Output is a replacement snapshot, bounded by
  TOOL_RESULT_MAX_CHARS with a truncation flag; final output replaces streamed snapshots rather than appending.
- Source `toolUseId`, `parentToolUseId` and optional native `childSessionId` link task cards, parent tools and
  nested transcripts. Child assistant entries retain their parent linkage and never become parent replies.
- `GET /api/sessions/:id/tasks/:taskKey` returns `TaskHistory`: available plus a transcript, or unavailable plus
  a display-safe reason. Encode the opaque task key as a URL segment. The sessions service resolves the task
  from that parent's transcript before calling optional `Harness.taskMessages(parentId, task, cwd)`; callers
  cannot supply an arbitrary child ID. Drivers validate the native parent relationship. Reads never start,
  resume or send to a child. Missing native support returns unavailable; permission/credential data is excluded.
  Commands may display their bounded task output without child retrieval. Unknown parent/task returns 404.

### Injected messages

- A user-role message the harness added that the user didn't type (a subagent hand-back or report, another
  session's message, a channel message, a `[SYSTEM NOTIFICATION - NOT USER INPUT]` notice, a scheduled wakeup) is a
  `kind: "injected"` entry: `source` (`InjectedSource`), `from` (sender name or null) and `text` (the body without
  its wrapper). It is never a `user` entry and clients never show it with the user's label or styling.
- Detection, Claude driver: the SDK's `origin` first (`peer` → agent when it has `senderTaskId`, else peer, with
  `origin.name`/`origin.body`; `channel` → channel; `human` → the user's). Without an origin, the wrapper the CLI
  puts at the very start of the text (after any `<system-reminder>` blocks): `Another Claude session sent a
  message:`, `<agent-message`, `<cross-session-message`, `<teammate-message`, `<channel`,
  `[SYSTEM NOTIFICATION`, scheduled-wakeup wrappers. Text that only contains these mid-message stays the user's.
  Background `<task-notification>` blocks keep becoming task entries (malformed ones stay user text, as before).
- Claude driver, local commands: `<command-name>`/`<command-message>`/`<command-args>` and `<bash-input>` become a `user`
  entry of what was typed (`/mcp`, `!ls`; history only, the driver already echoes live sends);
  `<local-command-stdout>`/`<bash-stdout>` become a `system` info entry and the `-stderr` ones an error entry (ANSI
  stripped); `<local-command-caveat>` is dropped. Text with anything else beside the wrappers stays the user's.
- Live and stored history give the same entry (id = the message uuid), so old sessions re-render correctly on
  reload; nothing is migrated.

### Claude driver

`harness/claude/driver.ts` keeps one `query()` per live handle in streaming-input mode.

- Options: `cwd`, `sessionId` (new sessions and the new id of a fork), `resume` (+ `forkSession: true`), `model`,
  `permissionMode` (always passed explicitly; when omitted the CLI may pick `auto`), `canUseTool`,
  `includePartialMessages: true`, `settingSources: ["user", "project", "local"]` (CLAUDE.md, skills, agents, hooks,
  permissions load as in Claude Code), `agent`, `agents`, `mcpServers` (plus an in-process `createSdkMcpServer` named
  `odin` for `hostTools`; tools appear as `mcp__odin__<name>`), `additionalDirectories`, `title`,
  `env: process.env`, `stderr` (logged, never returned).
- Mapping: `system/init` → `init` once (later inits → `model`/`permission.mode` when they changed); a sent message or
  `system/status requesting` → `state running`; `stream_event` text/thinking deltas → `delta` with entry id
  `<message.id>:<content block index>`; `assistant` content blocks → `entry` (text → assistant, thinking → thinking,
  tool_use → tool with its `id`; `parent_tool_use_id` → `parentToolUseId`); `user` tool_result blocks → `tool.result`
  (`is_error` → `ok: false`, text via `toolResult()`); TodoWrite input → `todos`; `active_goal` → `goal`; `result` → `usage` per model with the **turn's own** usage
  (`cumulative: false`): the difference between this and the previous `modelUsage` in the same process (`costUsd`
  likewise from `costUSD`); for the first result of a resumed/forked process, the sum of the turn's assistant
  message `usage` (deduped by message id) with `costUsd` = `costUSD` × its share by token weight (input 1, output 5,
  cache read 0.1, cache write 1.25); models with nothing new are skipped; `contextTokens` from the last main-thread
  assistant usage; then `turn.end` (`duration_ms`, `is_error`, errors joined) then `state idle`; `api_retry`, compaction, rate-limit
  rejections → `notice`; `system/local_command_output` (output of `/context`, `/usage`…) → assistant `entry`;
  `system/commands_changed` → `commands`; `conversation_reset` → warning `notice`; process exit/error → `exit`.
  `init.slashCommands` from the SDK's `SlashCommand` (`builtin` → `source: "builtin"`, else `custom`).
- `canUseTool(tool, input, opts)` → `PermissionRequest` { `id`: `opts.requestId`, `kind`: plan for `ExitPlanMode`,
  question for `AskUserQuestion`, else tool; `title`, `description`, `canAlwaysAllow: !opts.suppressAlwaysAllowRule`,
  `defaultToDeny: !!opts.defaultToNo` }; the promise waits for `answer()`. `opts.signal` abort → `permission.resolved`
  cancelled.
- `answer` → `PermissionResult`: allow once → `{ behavior: "allow", updatedInput: updatedInput ?? input,
  decisionClassification: "user_temporary" }`; allow with a scope → also `updatedPermissions`: the `addRules`
  suggestions re-targeted to the scope (session → `session`, project → `projectSettings`, local → `localSettings`,
  user → `userSettings`), or `{ type: "addRules", rules: [{ toolName }], behavior: "allow", destination }` when
  there are none; `setMode` suggestions only for scope session; classification `user_permanent`. Deny →
  `{ behavior: "deny", message, interrupt, decisionClassification: "user_reject" }`.
- History: `listSessions({ dir, includeWorktrees: true })`, `getSessionInfo`, `getSessionMessages` (mapped with
  the same entry rules, tool results attached), `renameSession`, `forkSession`, `deleteSession`.
- `models()`: `supportedModels()` from the latest live query, cached; before any session ran, the aliases
  `default`, `opus`, `sonnet`, `haiku` with `resolved: null`.
- `check()`: available when the platform binary package resolves; the note says auth comes from the environment.
- Tests: a contract test feeds the recorded messages (and hand-built shapes for what the recording lacks: thinking,
  subagent `parent_tool_use_id`, errors, compaction) through the mapping and asserts the event stream. No test
  spawns `claude`.

### Other runtimes

Claude and Codex are first-class local runtimes. `codex` uses the local installation and login;
`codex-wsl` uses Codex and its login in the default WSL distribution. A session retains its runtime on resume
and fork. Model credentials stay owned by the runtime. No automatic cross-harness conversation conversion.

Codex uses app-server JSON-RPC over stdio. `harness_session_links` maps stable Odin IDs to runtime thread IDs;
the mapping is metadata, never a transcript. Drivers expose supported permission modes/scopes in settings
`harnesses[].capabilities`. Unsupported choices fail before starting work; they are never silently broadened.
Runtime setting changes can apply on the next turn (`settingsOnNextTurn`).

App settings may specify `defaultHarness` and `harnessDefaults` keyed by runtime. Legacy model/mode defaults
apply to Claude only. Explicit request settings override runtime defaults. Legacy templates and their native
overrides are retained only for migration/reference; they no longer configure session launches.
Shared library assets remain canonical; native adaptations happen at the driver boundary. Unsupported native
features must be reported explicitly rather than dropped. Windows and WSL paths are translated at that boundary.

Shared settings profiles may include `codex: { permissionMode, instructions? }` as their native adaptation.
Claude rules and hooks are not equivalent to a Codex sandbox policy: profiles containing those require this
explicit adaptation before a Codex launch. Conflicting native policies across installed profiles are rejected.

Codex library projections are content-addressed under `<ODIN_HOME>/native-library/codex/`. Project installs
remain the canonical editable copies for drift/push/reset; projected native agent roles and skills are generated
at launch, preserving installed versions and project edits. Commands become skills (including explicit native
skill inputs for `/command` invocations). An installed native profile sets the initial Codex policy. A read-only
subagent constrains its own sandbox; it does not change the default agent’s sandbox. The user's Codex home, login, and configuration are never rewritten.
Model/mode changes take effect on the next turn; usage from the active turn stays attributed to its model.
Codex slash commands: Odin library skills, the thread's native skills (`skills/list` for the cwd, refreshed on
`skills/changed` → `commands`; a library skill wins a name clash) and two built-ins the driver runs over app-server:
`/compact` → `thread/compact/start`, `/review` → `review/start` (inline) with `uncommitted` (also the bare form),
`branch <name>`, `commit <sha>` or free text as custom instructions; `/review` carries `choices` for these.
Both run as ordinary turns (`turn/*` notifications); `exitedReviewMode` → assistant entry with the review.
Codex's per-item model identity is unknown in both live entries and history (session/usage models remain known).
Native tool definitions persist on threads created by Odin. Imported threads may not have `post_artifact`;
adding host tools to already-created external threads needs a separate MCP bridge. Legacy SSE MCP is rejected.

Protocol reference: https://learn.chatgpt.com/docs/app-server. Verified against the installed CLI 0.167.1's
generated stable/experimental schemas. Dynamic host tools and plan collaboration use experimental API opt-in.

Grok Build is the `grok` runtime. It spawns `grok --no-auto-update agent --no-leader stdio` and speaks
Agent Client Protocol JSON-RPC on stdin/stdout. Auth is `authenticate` with `cached_token` after `grok login`.
An interactive-only method (`grok.com`) fails the start with a login error. Odin does not read `XAI_API_KEY`
or `~/.grok/auth.json`. `session/new` assigns Grok's session id; `harness_session_links` maps it to the Odin id.
Resume is `session/load`. All six permission modes are `session/set_mode` mode ids. Scopes are once and session.
`session/set_model` runs only when the id is in the live catalog. An unknown or rejected model, and a rejected
`session/set_mode`, are reported with a notice and the session continues on the model and mode Grok already has.
A JSON-RPC error includes the message and data, not only the code. `session/prompt` returns `stopReason` and
`_meta.usage`; `costUsd` is `costUsdTicks / 1e9`. Reasoning tokens are
included in output. Context used is left null. Host tools are a loopback-bridged stdio MCP server named `odin`.
Caller MCP servers are passed through. Subagent definitions and extra instructions are reported with a notice.
Images (png, jpeg, gif, webp) go as ACP image blocks after a name tag; other files go as embedded resources.
A file Grok would drop is left out and reported with a notice. History reads the stored image, file and
dropped-image notes back into the user entry.
History is `~/.grok/sessions/<encodeURIComponent(cwd)>/<id>/` (`summary.json`, `chat_history.jsonl`); system lines
are skipped. `session/fork` needs `cwd`. Delete is `grok sessions delete`. There is no rename RPC. No new dependency.
Verified against the installed CLI 1.0.77. Tests use a fake transport and do not spawn `grok`.

Antigravity is the `antigravity` runtime. It spawns `agy acp --stdio` and speaks Agent Client Protocol JSON-RPC
on stdin/stdout. Auth uses the existing user login; Odin never reads or stores Google credentials.
`session/new` assigns Antigravity's native session id; `harness_session_links` maps it to the Odin session id.
Resume uses `session/load`. Antigravity modes (`auto`, `plan`, `accept-edits`) map to Odin's permission modes
(`default`/`auto` -> `auto`, `plan` -> `plan`, `acceptEdits` -> `accept-edits`, `bypassPermissions` -> auto with
`--dangerously-skip-permissions`). Native reasoning effort (`low`, `medium`, `high`, `xhigh`, `max`) is supported
for Gemini models (`gemini-3.8-flash`, `gemini-3.8-pro`, `gemini-3.8-flash-lite`). Host tools are loopback-bridged
via an in-process stdio MCP server named `odin`. Caller MCP servers and additional project directories are passed through.
Subagents (`invoke_subagent`) and background tasks map to Odin task activities. Tests use a fake transport and do not spawn `agy`.

## Projects

- A project is a registered directory, normally a git repo. `POST /api/projects { path, name?, init? }`; a non-repo
  folder is refused (400) unless `init: true` (`git init`, no commit). `name` defaults to the folder name slugged;
  must match `PROJECT_NAME_PATTERN` and be unique (409).
- **Settings**: effective = DB override ?? PROJECT.md frontmatter (`title`, `description`, `repo`, `default_branch`,
  `commands`) ?? a discovered source ?? default (`title` = name, `defaultBranch` = the repo's current default or
  `main`). A title comes from an overview heading, never from `package.json`'s name. Description is that
  document's first paragraph. Commands come from package scripts (`install`, else `<manager> install`; `check`,
  else `test`, else `typecheck`; `build`) using `packageManager` when it starts with pnpm or yarn, otherwise npm.
  `repo` is `owner/name` from `origin` when the remote URL has that shape. PATCH stores overrides in the DB
  (`null` clears one). Odin never writes PROJECT.md or any other project file. A missing PROJECT.md is not an
  error; a malformed one is reported in `manifestError`.
- **Sources**: `ProjectDetail.context` says where each field came from (`provenance`), quotes the first paragraph
  of each status document (`excerpts`, plain text, citing `path`), and lists markdown under the planning
  directories (`planning`). Those files are read-only links. Their `status` word is the file's own frontmatter,
  Discovery uses `README.md`, `docs/STATUS.md` and `docs/plans` when they exist.
  `PATCH /api/projects/:name/sources` stores a `ProjectSourceSelection` in the database; `null` clears it and
  returns to discovery. Paths must be relative and stay inside the project. Missing paths are listed in
  `context.missing` and are not quoted. `ProjectDetail.status` is the raw markdown of the first status document.
- Re-read of those source files is included in `refresh`: a size or mtime change emits `project.updated`.
- `missing` when the path is gone or no longer a repo; the project stays registered.
- Re-read PROJECT.md, `.claude/agents/*.md`, and git state on `refresh`, on the `projectsRescanMs` timer, and after
  `noteWritten`. Emit `project.updated` when anything changed.
- `agents`: parsed with `agents/parse.ts` (`version` = `fileHash("<id>.md", content)`, the library's rule);
  `libraryId` set when `installations` has that agent for the project.
- **Worktrees**: `createWorktree(name, branch)` → `<worktreesDir>/<project>/<slugify(branch)>` with
  `git worktree add -b <branch> <path> <base>` (base: `origin/<default>` when it exists, else `<default>`); an existing
  branch is checked out instead of created; an existing Odin worktree for the branch is reused. `resolveCwd` maps
  paths inside a project's repo or its Odin worktrees to the project. Odin never commits, resets, pushes or
  checks out in the main clone.
- `dirtyFiles` = files reported through `noteWritten` that `git status --porcelain` still shows changed.
- The route builds `ProjectSummary`/`ProjectDetail` from `projects.detail()` plus `sessions.counts(name)`,
  `sync.status` and `activity`.
- `ProjectSummary.activity`: 14 numbers, sessions with any activity per local calendar day for the last 14 days,
  oldest first, today last (`metrics.sessionsPerDay(name, 14)`, the `sessions` column of `metrics.activity`).
- `ProjectDetail.firstSessionAt` / `lastSessionAt`: earliest `createdAt` and latest `updatedAt` of the project's
  sessions counted by `sessions.counts` (working project or in `projects[]`, not archived, not side threads); null
  when there are none. Only on `ProjectDetail`, not in the project list.
- **Branches** (`GET /api/projects/:name/branches` → `ProjectBranch[]`, `ProjectsService.branches`): every local
  branch (`git for-each-ref refs/heads`), with `ahead`/`behind`/`merged` against the default branch
  (`origin/<default>` when it exists, else `<default>`), `worktreePath` from `git worktree list --porcelain` (null
  when no worktree has it checked out; the project checkout counts and is the one with `current: true`),
  `sessionIds` = the project's sessions whose `branch` is this one (newest first) and `pull` = the stored PR whose
  head is this branch, or null. Read-only git, argv only. 404 unknown project; a missing project gives `[]`.
- **Remove a worktree** (`DELETE /api/projects/:name/worktrees`, body `RemoveWorktreeRequest { path }` → 204,
  `ProjectsService.removeWorktree`): only worktrees Odin created under `<worktreesDir>/<project>/`, never the
  project checkout (400 for any other path, or a path that isn't absolute). 409 when a session with a live handle
  has its `cwd` inside the worktree (a session in state `idle`, `running` or `waiting` counts as live), or when the
  tree is dirty (`git status` shows any change; `git worktree remove` without `--force`). The branch
  is kept. A path that no longer exists is pruned and answers 204. 404 unknown project.

### Folder browsing

`POST /api/project-folders { path? }` returns `ProjectFolders`: the absolute current path, parent
(null at a filesystem root), and sorted immediate subdirectories. Dot folders and files are omitted;
symlinks to directories are included. Paths must be absolute (or `~` / `~/…`); omitting the path starts
beside an existing project, or in the user's home. This read-only operation uses POST
so the API's origin check applies. It browses the server's filesystem, including accessible Windows UNC
paths, and never reads file contents, starts git, or creates anything.

### Project files

`GET /api/projects/:name/files/map` returns a `ProjectFileMap` for the project's Files tab: every file git tracks or
would add (`git ls-files --cached --others --exclude-standard`, so `.gitignore` applies; a bounded walk when the
folder is not a repo), at most 20,000 (`truncated` beyond), each with its byte `size`. Text files up to 2 MiB also
carry `lines`. `added`/`removed` are the working tree against HEAD (`git diff --numstat --no-renames HEAD`); an
untracked text file counts as all added, a binary file has no counts, an unchanged file omits them, and a repo with
no commits has none. Deleted files are left out. Read-only git, argv only, cached per project for 10 seconds.
404 unknown project; a missing folder gives an empty map.

`GET /api/projects/:name/file?path=` reads one file of that map as a `SessionTextFile` (read-only; there is no
project save). It has the session viewer's confinement and limits: relative paths inside the project folder, no
`.git`, symlinks, binary or non-UTF-8 files (415) or files above 2 MiB (413). 404 unknown project or file.

#### Project file management

Rename, move, duplicate and a trash for the Files tab. All paths are relative to the project folder and reached
without symlinks; `.git` and paths escaping the folder are refused (403); unknown project or path → 404. Each change
calls `projects.noteWritten`. Nothing is committed.

- `POST /api/projects/:name/files/rename` `{ path, name }` → `{ path }`. `name` is one segment (no separators, `..`,
  `.git`, trailing dot or space, `\/:*?"<>|`; 400). 409 when the name is taken (a case-only rename is allowed).
- `POST /api/projects/:name/files/move` `{ paths: string[1..200], to }` (`to` = folder, `""` = root) →
  `{ moved: [{ from, to }] }`. 409 on a name clash (nothing is overwritten) or when the file is already there; 400
  into itself. All checks run before the first move.
- `POST /api/projects/:name/files/duplicate` `{ path }` → 201 `{ path }` (`<name> copy<ext>`, `copy 2`, ...). Files only
  (400), up to 50 MiB (413).
- Trash: `POST .../files/trash` `{ paths }` → `FileTrashEntry[]` moves items to `<home>/trash/<project>/<id>/`
  (never unlinks; a copy + remove across devices). `GET .../files/trash` lists, newest first; items older than 7 days
  are purged whenever the trash is listed or added to. `POST .../files/trash/:id/restore` → `{ path }` puts it back,
  recreating missing folders; 409 when something is at the original path. `DELETE .../files/trash/:id` or
  `DELETE .../files/trash` deletes one or all for good (204).
- Rename, move and trash answer 409 when a running notebook kernel's folder is inside the path (`notebooks.usesPath`).

### Project worktree default

`ProjectSettings.defaultWorktree` (optional boolean, saved override only, `null` clears it) sets whether new sessions in the
project run in a worktree when the launch request omits `worktree`. Resolution: `req.worktree ?? project.defaultWorktree ??
AppSettings.defaultWorktree`.

## Sessions

- **Record** (`sessions` table): one per harness session Odin knows. `id` is the harness's id. Odin sessions
  get a fresh UUID before the harness starts (`StartOptions.sessionId`), so the record and the URL exist at once.
- **States** (`SESSION_TRANSITIONS`): `running` while the harness works; `waiting` while a prompt is open
  (`waitingFor` permission | question); `idle` between turns (live or not); `ended` after `end`/close; `failed` when
  the harness exited with an error. Any message to an ended/failed/idle-not-live session resumes it (→ running).
- **Start** (`POST /api/sessions`): `req.harness` (default `claude`; not a key of `Deps.harnesses` → 400) →
  `launch.plan(req, id)` → worktree when `plan.worktree` → record (origin odin, state running) → `harness.start`
  with `hostTools = artifacts.hostTools(id)` → respond 201 with the record. A start
  failure before the harness answers → record `failed` with the error, 4xx/5xx.
- **Live handles**: kept while running/waiting and for 10 minutes idle, then closed (state stays `idle`, resumable).
  `detail.live` says whether one is open. On boot, records left running/waiting become `idle` with no pending prompts.
- **Events**: every harness event updates the record (state, waitingFor, model, permissionMode, pending prompts,
  todos, goal), is passed to `ingest.recordHarnessEvent`, is fired to `onEvent` listeners and goes out as `session.event`;
  record changes go out as `session.updated`. On `turn.end`: `metrics.refreshOutput(id)` (async).
- **Detail** (`GET /api/sessions/:id`): the record + `transcript` (the harness's stored messages, plus a live
  session's events since; completed entries only: text still streaming arrives through `session.event`), `pending`,
  `todos`, `goal`, `artifacts`, `live`, `slashCommands`. Clients then apply `session.event` frames with `applyHarnessEvent`.
- **Slash commands**: every `init` and `commands` event stores its `slashCommands` (`SlashCommand[]`) on the record
  (`sessions.slash_commands`, not part of `Session`; older rows holding bare names read as `source: "custom"`).
  `detail.slashCommands` = the live handle's, else the session's stored list, else the newest stored list in the same
  project (an external session that never ran here), else `[]`. A later `init` or `commands` replaces them in the view.
  Drivers leave out commands Odin owns or that make no sense here (Claude: `clear`/`reset`/`new`, `model`,
  `rename`, `send`/`now`, `color`, `focus`, `heapdump`, `__*`). The web adds Odin's own: `/clear` (aliases `reset`, `new`) opens
  a new session in the project, `/model <model>` and `/rename <title>` use PATCH, `/send` (alias `now`) sends now, and `/status` and `/cost` show the session's settings and usage in a toast;
  these never reach the harness. Send
  and start reject a message starting with `/clear`, `/reset` or `/new` with 400 (the CLI would reset the
  conversation under Odin).
- **Send** (`POST /:id/messages`): enqueue and dispatch when eligible to the live handle, else resume
  (`harness.start({ cwd: session.cwd, resume: id, prompt })`). 409 while `waiting` (answer the prompt first). External sessions can be resumed; they stay
  `origin: external`.
  Follow-up sends now persist in a service-owned SQLite outbox before acknowledgement; the response remains a
  `Session`. Optional `UserMessage.clientId` (1–200 nonblank characters) is a per-session idempotency key:
  repeating the original content returns success without dispatching again, including after completion/cancellation;
  reusing the key for different original content is 409. Editing preserves the original receipt/key. Completed and
  cancelled records retain a content hash for deduplication, with their content/attachments removed from the outbox.
  Initial start/fork prompts keep their existing launch behavior and are not outbox messages.
- **Shell commands (`!`)**: `POST /api/sessions/:id/shell` with `ShellRunRequest` runs one user-typed command in the
  session's working directory (`/bin/sh -c`, `cmd.exe /c` on Windows) and returns `ShellRunResult` (`output` is stdout
  and stderr combined, capped at 128 KiB with `truncated`; 120 s timeout kills the process tree, `timedOut`, `exitCode`
  null). Odin runs it, so it works for every harness and needs no live handle. Nothing is persisted or added to the
  transcript: the web shows the result and prefixes it to the user's next message. Odin's own token and secret
  environment variables (`ODIN_*TOKEN|SECRET|KEY`, `GITHUB_TOKEN`, `GH_TOKEN`) are removed from the child's environment.
  400 empty or oversized (8 KiB) command, 404 unknown session, 409 while another command runs in that session.
- **Message queue**: `SessionDetail.messageQueue` and `GET /:id/queue` return `{ revision, paused, messages }`.
  `revision` is monotonic per session. `session.queue` SSE carries `{ sessionId, queue }`; clients merge by revision
  and refetch on reconnect. Each message has `{ id, message: UserMessage, state, createdAt, updatedAt }`, ordered by
  enqueue sequence. `queued` is editable, `sending` means handed off and still awaiting turn completion, and
  `uncertain` means a failed/incomplete turn or connection loss may have accepted/executed it. These records are
  separate from native transcript entries; no optimistic transcript entry claims native acceptance.
  The service reserves one message synchronously before invoking a runtime, dispatches only between turns, and
  completes a receipt on successful `turn.end`. Unsuccessful turn completion pauses remaining work and retains the
  active receipt as uncertain, because tool effects may already have occurred. A stop (`turn.end` with
  `error: "interrupted"`) is not a failure: if the agent had already acted on the message (any reply, tool call or
  prompt) the receipt completes, and if the stop beat the agent the receipt returns to `queued` with its payload and
  the queue stays paused, so nothing is lost or duplicated. Send now is the exception: that
  interrupt completes the in-flight receipt and dispatches the next message. Exit/restart also turns sending into
  uncertain; boot restores outstanding work paused, never automatically replayed. End/interrupt pause before stopping
  the runtime. Idle-handle cleanup preserves the outbox. A new send does not release retained paused work; when no
  outstanding work remains, an ordinary new send can resume the session as before. Delete cascades queue records.
  `PATCH /:id/queue/:messageId` accepts `UserMessage` and edits only queued messages. `DELETE` on that path cancels
  queued work or dismisses an uncertain local receipt (it never undoes native work). Sending messages return 409;
  missing session/message returns 404. `POST /:id/queue/:messageId/retry` explicitly moves uncertain work back to
  queued, holding dispatch paused: retry can repeat native side effects. `POST /:id/queue/resume` releases paused
  work, but returns 409 while any uncertain receipt remains. `POST /:id/queue/send-now` accepts an optional
  `UserMessage` (an empty body sends the oldest queued message). It interrupts a running or waiting turn, completes
  the in-flight receipt because that message was already handed off, and dispatches the next queued message. A
  given message is placed ahead of other queued messages. A duplicate idempotency key does not interrupt or send
  again. When the queue was paused, this sends that one message and leaves the rest paused; otherwise later
  messages continue as usual. Idle sessions dispatch without a turn to stop. Uncertain receipts return 409 and
  nothing is interrupted or enqueued. An empty queue is 409. All queue mutations return the current `MessageQueue`.
- **Answer** (`POST /:id/permissions/:requestId`): 204; 404 unknown session; 409 when the prompt isn't open.
- **Interrupt**: 204; pauses the queue even when idle, and stops the runtime when running/waiting.
  **End**: pauses the queue and closes the handle → `ended`.
- **Update** (`PATCH`): title (also `harness.rename`), tags, pinned, archived, model, permissionMode, aside
  (`false` only: promotes a side thread), `addProjects` (appends to `projects`, never removes: 404 unknown project, 409
  unavailable project or a running/waiting turn, 400 when the harness lacks `additionalDirectories`; an idle process is
  closed so the next message resumes with the new directories). Model and mode
  go to the live handle when there is one; without one they're stored and the next resume starts with them. When the
  live process refuses a change between turns, the handle is closed and the change applies on the resume; mid-turn
  that's a 409 with the reason.
- **Fork** (`POST /:id/fork`): new id; `harness.start({ resume: id, fork: true, sessionId: newId, prompt })` when a
  prompt is given, else `harness.fork(id)` (stored only, `idle`). `parentId` set; template, agent, tags copied;
  `ingest.recordBaseline(newId, id)`. With `worktree: true` the fork gets its own worktree. The Claude
  CLI resumes and forks a session from a different cwd (it keeps the session file under the original project dir;
  history calls with the worktree as `dir` find it). `permissionMode` and `model` override the parent's for the fork.
- **Side thread** (`POST /:id/fork` with `aside: true`): a fork with a required `prompt` (400 without), never a worktree
  (400 with `worktree: true`), `permissionMode` default `plan`, title default `Side: <first 60 chars of the prompt>`.
  Allowed in any parent state, including running and waiting: the harness forks the conversation as stored so far.
  Stored with `aside = 1` and `parentId`. `list()` leaves side threads out unless `filter.aside === true` or
  `filter.parentId` is given; `counts()` and project session counts leave them out. `session.updated` events still fire
  for them (clients filter on `aside`). Promote: `PATCH { aside: false }` (optionally with a `title`) turns it into an
  ordinary session; `aside: true` on a PATCH is a 400 (a session can't be demoted).
- **Delete**: closes, `harness.delete`, removes the record (cascade). A native deletion failure returns 502 and
  preserves the record for retry; drivers accept already-absent native sessions. Worktrees are kept (the branch may hold work).
- **External sessions**: `discover(project)` imports `harness.list(path)` entries Odin has no record of
  (origin external, state idle, title from the harness); it runs on `POST /api/projects/:name/discover`, on the
  `projectsRescanMs` timer, and when a project is registered. Ingest creates them too (`ensureExternal`).
- `counts(project?)`: running, waiting, total (not archived).

### Continuity and limits

- `SessionDetail.streaming` contains the IDs of live partial assistant/thinking entries. A fetched partial entry
  continues accepting deltas until a complete entry or turn boundary; missing means empty for older clients.
  Core adds a UTF-16 `offset` to each delta before folding it. Replaying a delta already reflected in a REST
  partial trims its covered prefix; gaps are ignored until authoritative history/refetch restores continuity.
- Outbox receipt identity (`sequence`) is global; `sort_order` is independent and ordered within a session, with
  `sequence` as tie-breaker. Prioritizing one session must not collide with another session's receipts.
- Session `launch_config` stores selected library MCP IDs only, never resolved environment/header secrets.
  Start, resume and fork resolve those IDs using current library configuration. Missing/broken selections fail
  explicitly rather than silently removing tools; historical sessions with no recorded selection remain supported.
- Messages allow at most 10 attachments, 5 MiB decoded per file, 20 MiB decoded total. Session-message JSON has
  a separate 32 MiB transport ceiling (including escaping/base64); text is bounded at 1 MiB. Start, follow-up,
  fork, queue edits and Send now use the same validation. Unsupported harness attachments are rejected before dispatch.

### Session files

`GET /api/sessions/:id/files?path=` lists a relative directory as `SessionFileListing` (at most 1000 entries,
with an explicit `truncated` flag). `GET /api/sessions/:id/file?path=` reads a `SessionTextFile` containing
the path, UTF-8 content, byte size and SHA-256 version. `PUT /api/sessions/:id/file` accepts
`{ path, content, version }` and returns the saved snapshot. A stale version returns 409 without saving the draft.

Paths are confined to the session's working directory. Absolute paths, parent traversal, `.git`, symlinks,
binary/non-UTF-8 files and files above 2 MiB are refused. Saves only replace existing regular files,
refuse hard links, preserve mode bits and use a sibling temporary file followed by rename. The version is
checked again before rename; this is optimistic conflict detection, not an operating-system lock against
uncooperative concurrent writers. No model calls, watchers or arbitrary filesystem access.

`POST /api/sessions/:id/files` creates a new file from `{ path, content? }` (content defaults to `""`, at most 2 MiB,
valid UTF-8 without NUL) and returns `201` with the same `SessionTextFile` a read returns. It is create-only: an
existing file, folder or link at the path is `409` and nothing is overwritten (the create is an exclusive open, so
the check and the create are one step). The same confinement as reads applies: relative paths only, no `..`, `.git`,
or links in the path, and the final path must stay inside the session's working directory. The parent folder must
already exist; the endpoint never creates folders, so a missing one is `404`. Unknown sessions are `404`, malformed
bodies `400`, and a path that leaves the session `403`. A created file is recorded as written for the project's
dirty files, like a save.
Line endings and UTF-8 BOM remain part of the authoritative content. Existing local host/origin checks apply.

`GET /api/sessions/:id/files/search?q=` and `GET /api/projects/:name/files/search?q=` return a `FileSearchResult`
for the composer's `@` file references: fuzzy path matches (files, and the directories that contain them) in the
session's working directory or the project's folder, best first, at most 50. The index is `git ls-files --cached
--others --exclude-standard` (so `.gitignore` applies), else a bounded walk that skips dot folders and
`node_modules`; at most 20,000 paths (`truncated` beyond), cached per folder for 10 seconds. An empty query returns
top-level entries. The composer inserts `@<path>`; Claude expands it natively (verified in SDK mode); Codex reads the
path from the text.

### Workspace sessions

Sessions are top-level conversations with one or more configured repositories, not project navigation children.
`Session.projects` is an ordered list of project names; `Session.project` remains the working repository for
cwd, worktree, branch, artifacts and legacy metrics attribution. `StartSessionRequest.projects` optionally
supplies the full list and must include `project`; omission means `[project]`. Names are deduplicated, working
repository first; unknown or missing repositories fail before launch. Existing rows migrate to `[project]`.
Additional repositories are passed as harness `additionalDirectories` on every start/resume/fork and identified
in instructions, including their AGENTS.md. Only the working repository gets a worktree; the others use checkouts.
Project filters/counts match any configured repository. Metrics grouped by project retain working-project attribution
so workspace totals are not double counted. Removing a project used by a session is refused; remove its sessions first.
Projects retain an overview of related sessions, library and settings. The overview's Start chat
opens the global launcher with that project preselected. Old project Sessions URLs redirect to the overview.
The global session list is `/sessions`; `/history` remains an alias.

### Session effort

`Session.effort`, `StartSessionRequest.effort` and `UpdateSessionRequest.effort` are optional named reasoning
levels (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`); null restores the harness default. Migration
0010 stores the selection on the session. Resume and fork inherit it. Updates apply to subsequent turns and
are returned through the existing session response and `session.updated` event. No conversation turn is sent.

`ModelInfo.effortLevels` advertises available choices; absent/empty means the control is unavailable. Start and
update reject levels outside the selected model's list with 400. Model changes clear an incompatible effort.
The optional `SessionHandle.setEffort` changes the live session; `StartOptions.effort` supplies the stored value.
Claude uses the SDK effort option and session-only `applyFlagSettings`; its initial fallback catalog offers
low/medium/high until the SDK supplies a richer model catalog. Codex sends `turn/start.effort` and plan-mode
`collaborationMode.settings.reasoning_effort`. Grok uses `session/set_model` with `_meta.reasoningEffort`,
and its advertised default level when resetting. Permission mode remains independent.

The composer offers `/effort <level>` and `/effort default` for models with advertised effort levels, with the
same behavior as its effort selector. Unsupported commands remain native harness commands.

## Checkpoints

Status: contracts only; behaviour lands in later PRs (`docs/plans/checkpoints.md`). Until then `list` is empty and
`capture` does nothing.

- A **checkpoint** is the state of a session just before the agent acted on one user message: the conversation up to
  but not including that message, and the working tree at that moment. One per turn (`kind: "turn"`, id
  `<sessionId>:<n>`), plus a `pre-restore` safety snapshot (`<sessionId>:undo:<n>`) taken before any restore writes files.
- **Files** are snapshotted by core for every harness, in a bare git repository Odin owns at
  `<home>/checkpoints/<project>/<hash of cwd>.git`, driven as `git --git-dir=<store> --work-tree=<cwd>` with argv
  (never a shell string). The user's own `.git`, index, refs and hooks are never touched, so "Odin never commits, resets,
  pushes" still holds. The session's `cwd` only: `additionalDirectories` are not snapshotted. Nested repositories,
  submodules and files over 5 MB are skipped; over 20,000 files or 10 s the checkpoint is `snapshot: "skipped"`.
  Ignored files (`.gitignore`) are neither captured nor deleted by a restore.
- **Turn boundaries.** The transcript id of a user message is only known once the harness announces it, but the
  before-tree must be taken before the agent can act. So `capture("turn.prepare", null)` is awaited by sessions just
  before the message is handed over (bounded by the budget above) and holds the tree as pending;
  `capture("turn.start", messageId)` (on the user entry, not awaited) creates the checkpoint from it;
  `capture("turn.end", null)` (not awaited) records the end tree and `files`. Captures never throw; each change is
  announced with `checkpoint.updated`.
- **Conversation** rewind is a fork cut before the message: optional `Harness.forkAt` (the service then resumes the new
  session when the fork has a prompt),
  declared by `capabilities.checkpoints.forkAt`. Odin keeps no transcript of its own, so a harness without it can only
  do files-only restores (`conversation: true` is a 400).
- **Fork** with `atMessageId` is the conversation fork cut there; with `restoreFiles: true` (needs `worktree: true`) the
  fork's fresh worktree is filled from that checkpoint's tree through `materialize`, and the fork inherits the
  parent's checkpoints before that message.
- **Restore** (`POST …/restore`) needs an idle session and an empty queue (409 otherwise). `files` writes the tree back
  in the session's own workspace after a `pre-restore` snapshot, deleting only files that the latest snapshot had and
  the target lacks. `conversation` forks at the message and archives the original, which is kept: the result's
  `session` is the new fork and `archivedSessionId` the original. Undo is a files-only restore of `undoCheckpointId`
  and unarchiving the original.
- **Retention**: per project, `ProjectSettings.checkpoints` (`enabled` default true, `maxCount` 200, `maxBytes`
  500 MB); the oldest are pruned. Deleting a session or project removes its checkpoints and unreferenced objects.
- Checkpoints are keyed by Odin session id and transcript message id, not by harness, so a handoff to another harness
  can anchor on one.

## Launch

`LaunchService.plan(req, sessionId)` resolves a single default agent's settings. There are no saved
prompt/template workflows or selectable primary agents. A non-empty first message is required. Supplying
`agent` or `templateId` is a 400, including alongside a valid message. Install subagents and skills through
the library; the native default agent can delegate to them.

- Runtime: request harness ?? app default ?? Claude. One runtime per session, retained for resume/fork.
- Settings: explicit request > per-runtime app defaults (native/WSL, then family) > legacy Claude defaults.
  Unsupported models and permission modes are rejected. Worktree: request ?? app default; branch from the
  request, else `odin/<slug>-<id8>` from the session title/id. MCP IDs explicitly passed at launch resolve validated library specs.
- Title: explicit title ?? first message line (up to 60 characters).
- First-message substitutions remain supported for API callers: project, branch and caller
  variables. There is no template or variable-picker UI.
- Instructions: `instructions/global/AGENTS.md` in the library applies to every Odin start, resume and fork
  that opens a handle. Other instruction assets apply when installed in a project. Claude receives the project
  workspace's root AGENTS.md appended to its native default system prompt, while continuing to load CLAUDE.md
  and native user/project/local settings. Codex receives global instructions and reads project AGENTS.md natively.
  Existing project instruction files are never rewritten during launch. Global instruction errors fail launch.
- New records have null agent, agentVersion and templateId; historical/imported attribution remains readable
  for history/metrics. `LaunchPlan` carries no primary-agent/template fields. `StartOptions.agents` means
  available subagents only; `StartOptions.instructions` augments the native default agent.

## Library

- **Active kinds/layout**: instruction (`instructions/<id>/AGENTS.md`, a single plain Markdown file),
  skill (`skills/<id>/SKILL.md` plus supporting files), agent (`agents/<id>.md`, subagent definition),
  MCP (`mcp/<id>.json`), settings (`settings/<id>.json`). The instruction ID `global` is the shared default;
  the UI opens/creates it through Global instructions. Other instruction assets are reusable project fragments.
  Skills and subagents use their native frontmatter. Limits: 64 files, 1 MB/file, safe relative paths and IDs.
- **Legacy conversion**: on upgrade, prompts, commands and templates are converted additively into skills once.
  Existing skills win; collisions use a source-kind prefix. Template prompt references resolve to task text;
  former JSON settings are preserved in `references/former-template.json`, never auto-applied. Former placeholders
  become descriptive angle-bracket inputs. Original files and version history remain untouched. Unparseable
  source templates remain on disk for manual recovery; legacy kinds cannot be created/launched through the API.
  The DB marker prevents deleted converted skills from reappearing on restart. Existing native project files
  are retained; install converted skills explicitly where wanted.
- **Instruction installation**: merge into root AGENTS.md using named Odin comment markers, preserving
  user text outside each fragment, including line endings. Hash/diff/push operate on the owned fragment.
  Modified/conflicting fragments require force to update; malformed/duplicate markers refuse writes (409).
  Forget removes only an unchanged owned fragment; edited instructions stay. A missing file is created.
- **First boot**: an absent library directory is created from `config.librarySeedDir` (`templates/library/`).
- **Versions**: `version = filesHash(files)` (`core/src/hash.ts`: paths relative to the asset root; a single-file
  asset's one key is `<id><ext>`). Every new version is recorded in `library_versions` when first seen (rescan or
  save). `sessionCount` per version counts sessions with that `agentVersion` (agents) or `templateId` (templates,
  current version only).
- **Install** (`INSTALL_TARGETS`): agent/skill are copied to `.claude/agents/<id>.md`,
  `.claude/skills/<id>/…`; mcp is merged into `.mcp.json` under `mcpServers.<id>`;
  settings into `.claude/settings.json` (permission rules appended without duplicates, hook entries added; the
  exact fragment kept in `installations.merged` so it can be diffed and removed). Instructions follow the Markdown
  merge rules above. Legacy prompts/templates/commands are inactive (400). Files are written,
  `projects.noteWritten` is called, nothing is committed.
- **Drift** (`DriftState`): `projectVersion` = the hash of what's in the project now (merge kinds: of Odin's
  fragment as it currently appears; null when gone). current / update-available / modified / conflict / missing as
  in `api.ts`. For merge kinds `projectVersion` hashes the fragment rebuilt in library form, so clients go by `state`,
  never by comparing `projectVersion` with `libraryVersion`. `install` over an existing untracked file → 409 unless
  `force`; untracked content identical to the library version is adopted (no 409).
  `update` over modified/conflict → 409 unless `force`. `push` saves the project's files as a new library version and
  makes it the installed one; a copy-kind file that exists only in the project can be pushed without an
  installation (creates the asset and the row); merge kinds need an installation (404). `forget` on a copy kind drops
  the row, files stay; on mcp/settings it also takes Odin's own fragment back out of the shared file, only when it
  is still exactly as Odin wrote it, never the user's own entries. Every change emits `install.updated`.
- **Enabled** (`PATCH /api/library/:kind/:id` with `{ enabled: boolean }` → the asset; 404 unknown, 400 bad body):
  `LibraryAsset.enabled` (default true) is kept in `library_disabled`, not in the library files, and is dropped when
  the asset is deleted. Disabled means: `install`/`update` → 409 (forget and push still work; project copies are
  untouched); launch with a disabled MCP id → 400, while resume and fork skip it; a disabled `instruction/global`
  is left out of the prompt. Emits `library.updated`.
- **Save** (`PUT /api/library/:kind/:id`): bad file keys or an asset that doesn't parse (invalid JSON, a spec that
  fails validation, broken frontmatter) → 400 and nothing is written. Assets edited on disk can still carry an
  `error`; launch refuses them (400) and install refuses them (409).

## Secrets

Named values that library MCP specs refer to, so tokens and keys stay out of library files and `.mcp.json`.

- **Reference**: `${secret:NAME}` inside an MCP spec's `args`, `env` values, `url` or `headers` values (not keys,
  `command` or `name`). `NAME` matches `SECRET_NAME_PATTERN` (`^[A-Za-z][A-Za-z0-9_-]{0,63}$`). A malformed
  reference makes the library asset fail to parse (`error`; 400 on save). Core does not rescan filled output, so a
  value that itself contains `${secret:…}` stays literal.
- **Storage**: `<home>/secrets.json` → `{ version: 1, secrets: { NAME: { value, createdAt, updatedAt } } }`, written
  with mode 600 to a temp file and renamed over the old one. (Windows has no mode bits; the file sits in the
  user's profile.) The file is plain text: it protects against the repo, the library and logs, not against another
  process of the same user. The store sits behind `SecretStore` (`secrets/store.ts`), so an OS-keychain backend
  can replace it without an API change. An unreadable or malformed file → 500 with a message that never contains
  file content.
- **API**: `GET /api/secrets` → `SecretsResponse` (`secrets`: name, timestamps and `usedBy` library MCP ids, sorted
  by name; `missing`: names MCP specs refer to that are not set). `PUT /api/secrets/:name` (`{ value }`) creates or
  replaces → `SecretInfo`. `DELETE /api/secrets/:name` → 204, 404 when unknown. Values are 1 byte to 16 KiB with no
  control characters or line breaks (they end up in headers and environment variables), else 400. Names that fail
  the pattern → 400.
- **Resolution**: only at launch. `resolveMcpServers` (start, resume and fork) fills references into the
  `McpServerStart` handed to the driver, so a harness sees real values and Odin's stored state never does. A
  reference to a secret that is not set → 400 `MCP server <id> needs secret <NAME>, which is not set` and the
  session does not start; the library asset keeps the placeholder. Specs with no reference never touch the vault.
- **Install**: `.mcp.json` receives the spec as saved, placeholders included. A harness that reads `.mcp.json` on its
  own (a terminal Claude Code session in that project) does not know `${secret:…}` and will not fill it; only
  sessions Odin launches get values.

## MCP OAuth

Odin signs in to remote MCP servers that use OAuth, once, and sends the token to every harness the same way.

- **Spec**: an `http`/`sse` library MCP spec may carry `oauth: { scope?, clientId? }` (`McpOAuthConfig`). A spec with
  `oauth` and its own `Authorization` header, or `oauth` on a stdio spec, fails to parse. `scope` is space-separated.
  `clientId` names a client registered by hand (a public PKCE client, no secret) for servers without dynamic
  registration.
- **Discovery** (`oauth/discovery.ts`): probe the MCP url; a 401 whose `WWW-Authenticate` carries `resource_metadata`
  points at the protected-resource metadata (RFC 9728), else `/.well-known/oauth-protected-resource[/path]` on the
  server. Its first `authorization_servers` entry (else the server's own origin) gives the authorization-server
  metadata (RFC 8414, then OpenID configuration). A server that lists `code_challenge_methods_supported` without
  `S256` is refused. Every discovered endpoint must be https, or http on localhost; requests time out after 10 s,
  follow no redirects, and responses over 256 KB are refused. Failures are 502.
- **Registration**: with `clientId`, none. Otherwise a stored client for the same issuer and redirect URI is reused,
  else RFC 7591 dynamic registration as a public client named "Odin". No registration endpoint and no `clientId` → 400.
- **Sign-in** (`POST /api/mcp/:id/oauth/start`, body `{ origin }`): `origin` is the browser's own origin; it must be
  this Odin's address (localhost names or `ODIN_EXTRA_HOSTS`, https unless localhost) or 400. The authorization URL
  uses code flow, PKCE `S256`, a random single-use `state` held in memory for 10 minutes, and the RFC 8707
  `resource`. The server returns to `GET /api/oauth/callback`, which exchanges the code and stores the tokens. The
  state is consumed whatever happens, so a replayed or forged callback is a 400 and never reaches the token
  endpoint. The callback answers a small HTML page that shows only the outcome (OAuth error codes limited to
  `[a-z_]`, everything escaped), with `no-store`, `no-referrer` and a `default-src 'none'` CSP. Tokens must be
  `bearer`.
- **Storage**: `<home>/oauth.json` → `{ version: 1, servers: { <id>: { url, issuer, resource, endpoints, clientId,
  clientSecret, redirectUri, tokens } } }`, mode 600, atomic replace, behind `OAuthStore`. A grant belongs to the spec
  `url` it was made for: changing the url voids it. Token-endpoint error descriptions are never stored, shown or logged.
- **Use at launch**: `resolveMcpServers` (start, resume, fork; now async) adds `Authorization: Bearer <token>` for a
  spec with `oauth`. A token within 60 s of its end is refreshed first (one refresh at a time per server). A refresh
  refused with `invalid_grant`/`invalid_client`, or no grant at all → 400 `MCP server <id> needs sign-in`, and the
  session does not start; other refresh failures → 502 and the grant is kept. A token that ends during a running
  session is not replaced until the next resume.
- **API**: `GET /api/mcp/:id/oauth` → `McpOAuthStatus` (`connected` while the token is valid or refreshable, else
  `needs-sign-in`; never a token). `POST …/oauth/start` → `{ authorizationUrl }`. `DELETE …/oauth` → 204 forgets the
  grant (it is not revoked at the server). 404 for an unknown library id, 400 when the server has no `oauth`.
- `Deps.mcpFetch` carries all of this traffic; tests inject a fake.

### Plugins

A plugin is a library asset of kind `plugin`: a folder `<library>/plugins/<id>/` with a manifest and optional members of
its own. Design: `docs/plans/plugins.md`. Core scans, saves, lists and installs plugins (`LIBRARY_KINDS` in
`shared/src/library.ts` is `ASSET_KINDS` plus `plugin`); the web app does not show them yet, so `ASSET_KINDS` is unchanged.

- **Manifest** `plugin.json`: `name`, `description`, `version` (a label, ≤ 64 characters), `includes`
  (`{ kind, id, version? }[]`, at most 64, no duplicates; `kind` is one of `PLUGIN_MEMBER_KINDS`: instruction, skill,
  agent, mcp, settings, never plugin; `version` pins a library version hash) and `source`
  (`{ type: "git", url, rev? }`, an https, ssh or `git@` address and a branch, tag or commit name that does not start
  with `-`). Unknown fields are errors.
- **Own members** are files in the plugin folder laid out like the library: `skills/<id>/…`, `agents/<id>.md`,
  `mcp/<id>.json`, `settings/<id>.json`, `instructions/<id>/AGENTS.md`. Each must be a valid asset of its kind on its
  own (`filesError` and `parseAsset`), and `README.md` at the root is allowed. Any other file is an error. An own member
  and an included one must not share a kind and id.
- **Parse result**: `name` and `description` from the manifest (name defaults to the id); `meta` is `PluginSpec` plus
  `own: PluginOwnMember[]` (kind, id, name, description, error), sorted by kind then id; `error` joins every problem.
  The parser cannot see the library, so whether included assets exist is checked when a plugin is installed.
- Limits are the library's: 64 files per plugin, 1 MB per file.

#### Installing a plugin

`POST /api/projects/:name/library` with `kind: "plugin"` (`InstallRequest`): actions `preview`, `install`, `update`
and `forget`; `push` is 400. A plugin has no files of its own in a project (`INSTALL_TARGETS.plugin.mode` is
`"bundle"`). It installs its members one by one with the normal rules above.

- **Members**: own members are library-shaped "virtual" assets keyed `plugin:<plugin>/<member>` (versions in
  `library_versions` under that key) and installed under their plain id (`installations.project_id`). Included members
  are ordinary installations of the library asset, optionally at a pinned version (`installations.pinned_version`).
  Own members never appear in `GET /api/projects/:name/library` as installations; the plugin's `Installation.members`
  (`PluginMemberState`: kind, id, origin `own|library`, state) lists them. The plugin row is in
  `plugin_installations` (installed version, hash of what it runs, member list).
- **All or nothing**: every member is checked (conflicts, untracked files, ids claimed by another asset or plugin, a
  missing include → 409) before any is written. `force` overrides what it overrides for a single asset.
- **Preview** (`action: "preview"`, writes nothing): `InstallResult.preview` is a `PluginPreview` with the members and
  what would happen to each, `runs` (hooks, local MCP commands and remote servers, with their text), `missing` includes,
  the `${secret:NAME}` names with whether each is set, the remote servers that need an OAuth sign-in, and `confirm`.
- **Confirm**: a plugin with hooks or local MCP commands refuses to install (409) unless `InstallRequest.confirm`
  equals the preview's token (a hash of what runs). An update asks again only when that hash changed from the one
  stored at install. Remote servers need no confirmation.
- **Drift**: the plugin's state is the worst member state (conflict, modified, missing, then update-available when a
  member is not installed yet or the plugin version moved). `update` adds new members, rewrites changed ones and
  releases members the manifest dropped.
- **Forget**: releases only members the plugin installed itself: not ones that were already installed by hand
  (`adopted`) and not ones another installed plugin lists. Copy files stay and merged fragments come out, as for
  any `forget`.


#### Import and export

Plugins come from and go to Claude Code plugins. Sources are a git address or a local folder only (`PluginSource`).

- `POST /api/library/import` (`ImportRequest`: `source`, optional `id`) → `ImportPreview`, writing nothing. A git source
  is https, ssh or `git@` (never `file:`) and an optional branch, tag or commit; Odin runs `git init`, `fetch --depth 1`
  and `checkout` by argv (never a shell, no hooks, no prompts, 60 s) in a temp folder under `<home>/tmp` and removes
  it. A local source is an absolute folder. Everything read is untrusted: symlinks are ignored, at most 500 files,
  1 MB each and 16 MB in all, text only, library path rules.
- **Conversion**: `skills/<id>/…` and `agents/<id>.md` are kept; `commands/<id>.md` become skills (a name clash becomes
  `command-<id>`); `hooks/hooks.json` becomes the own member `settings/hooks`; each `.mcp.json` server becomes
  `mcp/<name>`; `README.md` is kept; the manifest keeps name, description and version and records `source` for git.
  Members that do not parse are skipped with a warning, as are files with no place (`scripts/`, and so on). Hooks or
  servers that use `${CLAUDE_PLUGIN_ROOT}` or `${NAME}` environment references get a warning, since Odin has neither.
  Own members stay in the plugin; nothing is split into the shared library. A plugin id already in the library is 409.
- The preview lists members, `runs` (hooks, local commands and remote servers, with exact text), `secrets` and
  `warnings`, plus a `previewId` valid for 10 minutes and one use. `POST /api/library/import/:previewId` writes the
  plugin (201, `LibraryAsset`). Nothing runs at import; installing it into a project is the confirmed preview of the
  section above.
- `POST /api/library/plugin/:id/export` (`ExportRequest`: absolute `path`, absent or an empty folder, else 409) →
  `ExportResult`. It writes `.claude-plugin/plugin.json`, `skills/`, `agents/`, `hooks/hooks.json` (hooks from settings
  members) and `.mcp.json`, with included assets at their current or pinned version. `${secret:NAME}` stays as a
  placeholder (never a value), `oauth` is dropped with a note, and members a Claude Code plugin cannot express
  (instruction fragments, settings with no hooks) are listed in `skipped`. Files are written without the executable bit.
## Notebooks and Python analysis

A notebook is an ordinary `.ipynb` file in the project, addressed by a project-relative path (forward slashes, ends
in `.ipynb`, checked against the project root). `@odin/shared/notebooks` defines one kernel record per
(root, path) (`NotebookKernel.path`; `name` is the file basename), immutable interpreter/OS/distro, notebook
snapshots with revisions and stable cell IDs, execution receipts. The kernel process starts
lazily on first execute; opening a notebook starts nothing. A kernel belongs to its file, not to a session; there are no
session links. One lazy Jupyter host serves each project/location. Notebooks are not
stored under `Config.home` and not in session transcripts. The Files service lists `.ipynb` files like any other
file. Restart restores stopped resources and interrupted receipts; it never replays code. Busy kernels do not expire.

SQLite migration 0014 (recreating 0013's tables; existing notebooks and kernels are dropped, not migrated) holds
kernels keyed by UNIQUE(root, path) and execution receipts; migration 0015 drops the session-link and notice tables
and the execution receipts' `session_id`. `.ipynb` remains the
source of truth for cells/outputs. Saves use revision checks and atomic rename; conflicts return 409. Edits made to
the file outside Odin (an editor, git, another tool) surface through the same revision check: a save or execute
with a stale revision returns 409 and the client refetches. There is no external-editor hand-off. Execution
is serialized per kernel. Cells carry no authorship: `NotebookCell` has no `author`, no
cell metadata is written beyond what the file already holds, and an `odin_author` entry in an existing file is
ignored. Agent tools are scoped to their session's project; `notebook_create` and `notebook_open` take a
project-relative `path`, and `notebook_status`/`notebook_wait` take the execution id. Nothing is delivered into
sessions when a notebook changes; the revision check is the only coordination.

HostToolResult adds bounded text/image content while preserving its text field. All driver adapters map images
to native content blocks. Executable/inspecting host tools declare `effect: execute`; mutations declare `edit`.
Core checks these effects independently of native harness tool approvals: plan/dontAsk deny, bypassPermissions
allows, other modes ask explicitly. Only once approvals are advertised until native rule mappings are proven;
acceptEdits never authorizes Python execution. Interrupt/end cancels outstanding core prompts. Read-only file
snapshot tools need no execution approval. Inspecting Python objects is execution and must be gated.

REST: GET `/api/projects/:name/notebooks` lists kernels; POST `/api/projects/:name/notebooks/open` with
`OpenNotebookRequest` `{path, sessionId?, create?, interpreter?, location?}` (with `sessionId`, which must belong to that project else 400, `path` is relative to that session's cwd, e.g. a worktree, instead of the project root; the absolute root is stored on the kernel so saves and runs hit the same file; host tools always use the calling session's cwd) returns the existing record for that path or
creates one (`create` writes an empty nbformat-4 file when missing, else 404); GET/PUT/DELETE `/api/notebooks/:id`
(DELETE removes the record and stops the kernel, never the file);
POST `/api/notebooks/:id/execute`, `/interrupt`, `/stop`;
GET `/api/notebook-executions/:id`; POST `/api/notebook-executions/:id/wait`.
Updates stream as notebook.updated, notebook.execution and bounded notebook.output frames. Clients refetch
snapshots on reconnect; SSE is not a durable output store. Long tools return execution handles promptly.

Rich HTML/JavaScript/SVG output is served only at `/a/notebooks/:id/:cellId/:index` with artifact sandbox/CSP
headers and embedded only in the existing scripts/forms sandbox. Native output rendering permits text and
raster images; it never inserts HTML into the app DOM. Jupyter credentials stay inside core, absent from agent
results, browser responses and logs; kernel child environments omit Odin tokens. Environment provisioning is
an explicit action.

The widget bridge uses bounded comm_open/comm_msg/comm_close envelopes with base64 buffers. It serves only
bundled standard widget classes, never CDN modules. The user explicitly enables callbacks for each frame;
messages are accepted only from that frame's window with matching kernel/model identity and size bounds.
Widget callbacks execute Python and keep kernels busy until the protocol reports idle. Stop revokes bridges.

Environment detect/setup use POST `/api/projects/:name/notebook-environment/{detect,setup}`. Setup is explicit,
creates the Odin-managed Jupyter environment, adds only ipykernel to an existing project environment, or creates
a .venv with the analysis baseline (built with uv when installed, else `python -m venv` and pip, so only Python is
required). `location` in the body is optional: when omitted the server picks where Python runs (this machine, or on
Windows the first WSL distro with Python when the machine has none) and returns it as `location`. A second setup
request while one runs joins it. Variable/dataframe inspection is explicit Python execution via
POST `/api/notebooks/:id/{variables,dataframe}`. GET `/api/notebooks/:id/widgets` returns bounded live widget
models; POST `/api/notebooks/:id/comm` sends a validated callback.

## Artifacts

- Posted by the agent through the host tool **`post_artifact`** (`title`, `html`, `note?`, `artifact_id?`) that
  `artifacts.hostTools(sessionId)` returns: a new artifact in the session, or a new version of one of the session's
  artifacts. HTML ≤ 8 MiB, raised for reports with embedded charts; transport envelopes remain separately bounded.
  The tool answers `Posted artifact <id> v<n>`. Emits `artifact.updated`.
- Served at `GET /a/<id>/<version>` with:
  `content-security-policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:
  blob:; font-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts allow-forms`
  plus `x-content-type-options: nosniff` and `cross-origin-resource-policy: same-origin`.
- The web app embeds it only as `<iframe sandbox="allow-scripts allow-forms" src="/a/<id>/<v>">`. **Never**
  `allow-same-origin`, never `srcdoc`, never inserted into the app DOM (the guard enforces this).
- Core injects the bridge before `</head>` (or at the start): `window.odin = { submit(data), theme }`; `submit`
  does `parent.postMessage({ type: "odin.submit", artifactId, version, data }, "*")`; `theme` is the `--iu-*` token
  values from `packages/web/src/styles/tokens.css`. The app accepts messages only from that iframe's `contentWindow`,
  with matching ids and data ≤ 64 KB of JSON, asks to confirm, then `POST /api/artifacts/:id/submit`.
- **Per project**: `GET /api/projects/:name/artifacts?limit=` → `Artifact[]` whose `project` is that one, newest
  `updatedAt` first (`ArtifactsService.forProject`). `limit` is a positive integer (400 otherwise); omitted means
  all. 404 unknown project.
- **Submit** sends a user message into the artifact's session: `Answer from "<title>" (v<n>):` and the data as a
  fenced JSON block. 409 while the session is waiting.
- **Reports/slides** use ordinary saved HTML artifacts, including print CSS for HTML decks (no PPTX export).
  Desktop `exportArtifactPdf(id,version)` validates the top-frame sender and numeric saved identity, renders in
  an isolated sandboxed window and uses printToPDF after the user's destination choice. Arbitrary URLs/HTML
  are not accepted by IPC. The browser fallback `/api/artifacts/:id/print/:version` prints a trusted wrapper;
  report HTML remains in an opaque sandbox at `/a/:id/:version/print`, without allow-modals or allow-same-origin.

## GitHub sync

Optional, read-only. `ProjectSettings.githubEnabled` defaults to false. When enabled with a repo and credentials,
sync reads PRs; it never reads, mirrors or writes issues or milestones, and makes no remote writes. Project
directories may have no git repository; `CreateProjectRequest.init` optionally creates one. A missing project means
the directory is absent, not non-git.

- Poll every `githubSyncMs` and on `POST /api/projects/:name/sync`; ETags; rate limits. `pulls` table (head branch,
  merged, files, `Closes #n`, review rounds = `CHANGES_REQUESTED` reviews). Off without `repo` or token.
- **Session ↔ PR**: on `sync.onPull`, every session in the project whose `branch` is the PR's head gets `pull` and
  `metrics.prOutcome` (open; merged with 0 review rounds → merged; merged after ≥ 1 → merged-after-changes; closed
  unmerged → closed) and `reviewRounds`, via `sessions.patch`.

## Ingest

Hook events from sessions run outside Odin (`claude` in a terminal), through the Claude Code adapter.

- `POST /api/ingest`, one `IngestEvent` or an array (≤ `INGEST_MAX_BATCH`). Response `IngestResponse`. Per-event
  validation (a bad event is listed in `rejected`, the rest land); 401 without the token; 413 over 1 MB.
- **Idempotent** on `event.id` (`session_events` primary key); duplicates are counted, not reapplied.
- **Session resolution**: `session` is the harness session id. Unknown → `sessions.ensureExternal` with the project
  from `project` or `projects.resolveCwd(cwd)` (an event with neither, or an unknown project, is rejected).
  Exception: `session.started` / `session.ended` for an unknown session are dropped (neither accepted nor rejected).
  A terminal session with no message is not saved; its first `turn`, `tool`, `usage` or `message` creates it.
  An event whose `session` is a `harness_session_links.native_id` of an existing session is a duplicate and does
  not create a record: that conversation already has an Odin id.
- **Sessions Odin runs** also fire the project's hooks (settings sources include local settings). Events for a
  session with `origin: odin` are acknowledged and counted as `duplicates`: the harness stream already measures it.
- A batch is one SQLite savepoint; its SSE events go out after commit (`EventBus.batch`). `tool.target` ≤ 200 chars,
  message text ≤ 2000. Events never carry file contents.
- **Harness facts** (`recordHarnessEvent`): `usage` → a `usage` row; `turn.end` → `turn`; a tool `entry` → `tool`
  (name and a target: `file_path`/`path`/`pattern`, or a command's first two words); `exit` failed → `error`. Rows
  have `source: harness`.
- **Metrics** (`SessionMetrics`), recomputed from a session's `session_events` after each batch/fact:
  - `wallMs` = last event ts − first; `activeMs` = Σ turn `durationMs`; `turns`, `toolCalls` = counts.
  - `tokensByModel`: `cumulative: true` replaces earlier usage for that model, otherwise adds; minus the baseline for
    forks (`recordBaseline`, applied only to cumulative reports: the Claude driver reports per turn, so a fork counts
    only its own turns without one); `tokens` = the sum.
  - The record's `model` is the selected or initial model (the user's PATCH, the harness's `init`/`model` events, or
    the start event of an ingested session). Usage never rewrites it. An ingested session with no model yet takes the
    model with most output tokens, so it gets one. Per-model totals live in `tokensByModel`.
  - `costUsd` = Σ `costOf(tokens, model, pricing)` when every model is priced; else the harness's reported cost
    (latest cumulative per model, or the sum of incremental ones, minus the baseline); else null.
  - `contextTokens` = the latest reported. `diff`, `commits`, `prOutcome`, `reviewRounds` come from
    `metrics.refreshOutput` and sync; never overwritten by events.

### Imported session measurements

Imported sessions may expose optional harness `measurements()`: stable, timestamped usage, turn and tool facts,
or null when native measurements cannot be recovered. On detail load, an unattached external session's native
history replaces its harness measurement facts atomically; hook facts prevent replacement to avoid duplicate
accounting. Repeated reads are idempotent. Never apply this replacement to Odin-origin sessions or while a
live handle is attached. Codex reads only measurement/model fields from its own app-server-reported JSONL
history and paginates stored turns without resuming or running the model. Unavailable cost remains null;
reasoning output is already included in output tokens, and cached input is counted separately from fresh input.
`SessionMetrics.contextWindow` and usage-event `contextWindow` optionally carry the runtime's reported capacity;
the UI prefers this to its model fallback. Activity boundary facts provide wall time; missing turn durations
remain unknown instead of being represented as zero active time.

## Claude Code adapter

- `adapters/claude-code/`: `odin-hook.ts`, run by Claude Code hooks as `node <abs path>/odin-hook.ts <Event>`,
  posts to `/api/ingest` on the port in `~/.odin/runtime.json` (else 8790; `ODIN_URL` overrides) with the token from `~/.odin/env` (or `ODIN_INGEST_TOKEN`). It
  **never blocks or fails the agent**: 2s timeout, every error swallowed (logged to `~/.odin/hook.log`), exit 0.
- Hooks: `SessionStart` → `session.started` (also on resume/clear/compact: same session; `source` says which);
  `PostToolUse` → `tool`; `SubagentStop` and `Stop` → cumulative `usage` from the transcript + new `turn`s (`Stop`
  fires after every reply, so it never ends the session); `SessionEnd` → final `usage` + `session.ended`.
- Installed per project by `POST /api/projects/:name/tracking/claude-code {enabled}` into
  `.claude/settings.local.json` (not committed), merged with existing hooks and removable cleanly.
- Grok Build runs those same project hooks and sets `GROK_SESSION_ID`. The adapter posts nothing for that
  process. A Grok session is measured by its harness, and ingesting the hook would open an empty Claude session
  under Grok's native id.

## Metrics

`GET /api/metrics?groupBy=model,template&project=&since=&until=` → `MetricsRow[]` (`MetricsService.query`).

`GET /api/projects/:name/activity?days=84` → `ProjectActivity` (`MetricsService.activity(project, days)`): one
`ProjectActivityDay` per calendar day for the last `days` days ending today, oldest first, no gaps (days with nothing
are zeros with `costUsd: null`). `days` defaults to 84 and must be an integer 1–168 (400 otherwise); 404 unknown
project. **Days are the server's local calendar days** (the time zone core runs in; web and core run on the same
machine), `date` is `YYYY-MM-DD`. A session counts for a project when it is its working project or in `projects[]`.
Computed from `session_events` turn facts where they exist (a turn belongs to the day it ended; `activeMs` = Σ turn
durations, `costUsd` = Σ priced usage that day, null when unknown; a cumulative usage report counts its increase over
the previous report), else from the session's `createdAt` and `updatedAt` days (both count, nothing in between).
Archived sessions count. `added`/`removed` are the session's `metrics.diff` lines, counted once on the session's last
active day inside the window (0 when unknown). `commits` = commits reachable from any local branch
(`git log --branches --since=<window start>`, each commit once) whose author date falls on that local day; null when
the project folder is missing or not a git repository. The git read is cached per project and window for 30 s.

- **Population**: sessions with at least one turn, not archived, filtered by `project`, `updatedAt >= since` and
  `createdAt < until` (both ISO-8601, 400 otherwise).
  `groupBy` takes 0–3 distinct `MetricsDimension`s (400 otherwise). Empty (`groupBy=` or absent) returns exactly one
  row with `key: {}` over the whole population, even when it is empty (`n: 0`).
- **Totals** (`total`): `tokens` = Σ `metrics.tokens` per field; `costUsd` = Σ known `metrics.costUsd`, null when none
  is known.
- **Keys** (`"∅"` when unknown): `model` = `normaliseModel(session.model)`; `agent`; `agentVersion` =
  `<agent>@<first 8 of agentVersion>`; `template` = `templateId`; `harness`; `project`; `origin`.
- **Medians** over sessions where the value is known: `wallMs`, `activeMs`, `turns`, `toolCalls`, `tokensOut`,
  `costUsd`, `diffLines` (added + removed).
- **Rates** (null when the denominator is 0): `merged` = (merged + merged-after-changes) / sessions with a merged or
  closed PR; `mergedClean` = merged / the same; `failed` = sessions in state failed / n.
- Rows sorted by `n` descending, then key. `lowConfidence` = `n < LOW_CONFIDENCE_N`.
- `refreshOutput(id)`: for a session with a branch (worktree or checkout), `git diff --numstat <merge-base>...<branch>`
  against `origin/<default>` (else `<default>`) and `git rev-list --count` → `diff`, `commits`. Read-only git.

## Settings

- `AppSettings` in `app_settings`; `GET /api/settings` → `SettingsResponse` (settings, pricing = `pricing.json` over
  `DEFAULT_PRICING`, GitHub `{ configured, source }`, harnesses from `check()`, `libraryPath`). `PATCH` updates
  settings and/or replaces `pricing.json`.
- Desktop settings: `notifyOnFinished` (default true), `launcherShortcut` (accelerator string, at most 100 chars, or
  null = off; default `CommandOrControl+Shift+Space`), `editorCommand` (non-empty, at most 200 chars; default `code`),
  `toolPaths` (keys `claude`, `codex`, `grok`, `gh`, `git` only; values absolute paths, at most 1024 chars; an empty
  string drops the override; a PATCH replaces the whole map; default `{}`). Core uses a `toolPaths` entry instead of
  PATH lookup when it resolves that executable.

## Readiness

`GET /api/readiness` → `ReadinessResponse { ready, checks[] }`: what a fresh machine still needs. Checks, in order:
`harness` (some runtime available; else `missing`), `claude-auth` (only when Claude is available: `ok` when an auth
env var is set or `<CLAUDE_CONFIG_DIR or ~/.claude>/.credentials.json` exists, else `warn`; macOS keeps the login in
the keychain, so there it is "cannot tell"; Odin checks names and file presence only, never values), `git`
(`git --version` runs; else `missing`), `github` (token configured; else `optional`), `projects` (none yet: `todo`).
`ready` is false when any check is `missing`. The web app shows the non-ok checks on Home unless only `optional`
ones remain.

## Desktop shell

`apps/desktop` (Electron; see [desktop.md](desktop.md)). The server/UI split stays clean: the shell
is a client like a browser, holds no application state, and the web app never requires it. The app is named **Odin**
(window, tray, installer, notifications); `~/.odin`, `ODIN_*` variables and API identifiers keep their names.

- **Port**: preferred `CORE_PORT` (8790; the dev channel 8791). On launch the shell attaches to the port in
  `<home>/runtime.json` if this home's core answers there, else uses the preferred port, else (another program or
  another home's core holds it) asks the OS for a free port and spawns core there. `ODIN_PORT` pins the port: no
  moving, an error window instead. Hooks find the port through `runtime.json` (`ODIN_URL` overrides).
- **Instance and runtime files**: `<home>/instance` holds a random id for the home (created by whichever of core or
  shell starts first). A running core writes `<home>/runtime.json` → `{ port, pid, instance, startedAt }` after it
  listens and removes it on clean shutdown if it still names its pid.
- **Attach or spawn**: on launch the shell probes `GET /api/health`. A response with `app: "odin"` means a core is
  already running: the shell **attaches** and never stops it. Nothing listening: spawn core with argv (no shell
  string; `node packages/core/src/index.ts` in development, a bundle when packaged), wait for health (20 s), load
  `http://127.0.0.1:<port>/`. Attach only to a core whose `instance` matches this home (one without `instance` is
  an older core and counts as a match).
- **Health identity**: `GET /api/health` → `{ ok: true, app: "odin", version, instance, now }`. A 200 without `app: "odin"`
  is not a Odin core.
- **Owned core**: stdout/stderr go to `<home>/desktop.log` (rotated at 5 MB, one previous kept). Unexpected exits
  restart with backoff (1 s, 2 s, 5 s; give up after 5 tries in 2 minutes and show "Restart" / "Open log"). Core's
  environment is the shell's plus the resolved `PATH`; model credentials pass through untouched and are never read.
- **Path overrides** (a packaged app has no repo layout): `ODIN_WEB_DIST` (built web app), `ODIN_LIBRARY_SEED`
  (`templates/library`), `ODIN_ARTIFACT_THEME` (the artifact theme `tokens.css` file), `ODIN_ADAPTER_DIR` (the
  Claude Code adapter scripts dir holding `odin-hook.ts`). Unset means the repo defaults.
- **Window**: closing hides to the tray; core and live sessions keep running. One window, single-instance lock (a
  second launch shows and focuses it). On Windows and Linux there is no native menu bar and no separate title-bar
  row: minimize, maximize and close overlay the app's own 48px header, which is the drag region. Copy, paste, undo,
  reload, zoom and quit keep their shortcuts. The waiting count stays on the document title (taskbar). macOS keeps a
  normal title bar and the application menu. `contextIsolation: true`, `sandbox: true`, no `nodeIntegration`.
  Navigation is confined to the core origin; other URLs and `window.open` go to the system browser. Page permission
  requests are denied.
- **Quit**: stops an owned core only. When sessions are running or waiting it asks first ("2 sessions are live. Quit
  and stop them?"). Graceful stop: SIGTERM on macOS/Linux; on Windows the shell spawns core with a Node IPC channel
  and sends `{ type: "shutdown" }`. Either way core closes live handles, and exits 0; the shell
  waits up to 10 s, then kills. Core ignores IPC disconnect (an orphaned core keeps running).
- **Tray**: tooltip "Odin: 2 running, 1 needs you"; a distinct needs-you icon (shape, not only colour). Menu: Open
  Odin · New session (`/?launch=1`) · up to 5 waiting sessions by title (`/s/<id>`) · Quit. Counts come from the
  shell's SSE `session.updated`, seeded from the sessions list on every (re)connect; background agents/commands count
  as running.
- **Notifications**: a session becoming waiting (permission, question, plan approval) raises one native notification
  per waiting episode when `notifyOnWaiting` (session title and prompt title only; never tool input or file
  contents); clicking opens `/s/<id>`. A session finishing while the window is hidden or unfocused notifies too
  (`notifyOnFinished`, default on). No notification for the session the focused window is showing; reconnects and
  repeated events never repeat one.
- **Global shortcut**: opens the launcher (`/?launch=1`); default `Ctrl+Shift+Space`, configurable or off. A failed
  registration is reported in Settings, never fatal.
- **Preload**: `window.odinDesktop` through `contextBridge` (`OdinDesktop` in `web/src/app/desktop.ts`):
  `platform`; `openPath(path, target: "editor" | "terminal" | "files")`; `getLoginItem(): Promise<boolean>`,
  `setLoginItem(on)`; `shortcutStatus(): Promise<{ accelerator: string | null; registered: boolean; error? }>`;
  `openLog()`. Every method is optional on the web side (callers check before calling). `openPath` resolves the
  real path and only accepts paths under a registered project or Odin worktree (`GET /api/projects`), rejecting
  symlink and junction escapes; launches with `shell.openPath` or `spawn` with argv. IPC handlers accept only the core
  origin's top frame. The web app treats `odinDesktop` as optional (`src/app/desktop.ts`).
- **Desktop settings** (shown only with the shell): start at login (off by default; starts hidden in the tray),
  notify on waiting, notify on finished, launcher shortcut, editor command, tool paths, Open log. Start-at-login and
  window state are shell-local (`<home>/desktop.json`), not API settings.
- **Packaging**: Windows first. `electron-builder`, x64 NSIS, per-user, unsigned, no auto-update; app id
  `dev.odin.app`, output `apps/desktop/dist/`. Core is bundled to JavaScript (esbuild, a dev dependency of
  `apps/desktop` only); the web dist, library seed, artifact theme and adapter scripts ship as resources passed via
  the path overrides above.

## REST

The main routes; each module's `routes.ts` has the full list. All JSON. Errors: `{ error }` with a 4xx/5xx status. `204` for empty bodies.

| Route | Returns |
|---|---|
| GET `/api/health` | `{ ok: true, app: "odin", version, instance, now }` |
| GET `/api/projects` | `ProjectSummary[]` |
| POST `/api/projects` (`CreateProjectRequest`) | `ProjectDetail` (201) |
| GET `/api/projects/:name` | `ProjectDetail` |
| PATCH `/api/projects/:name/settings` (`UpdateProjectSettingsRequest`) | `ProjectDetail` |
| PATCH `/api/projects/:name/sources` (`UpdateProjectSourcesRequest` or `null`) | `ProjectDetail` |
| POST `/api/projects/:name/refresh` | 204 |
| DELETE `/api/projects/:name` | 204 (unregisters; never deletes files) |
| GET `/api/projects/:name/branches` | `ProjectBranch[]` |
| DELETE `/api/projects/:name/worktrees` (`RemoveWorktreeRequest`) | 204; 400 not a Odin worktree of the project; 409 a live session's cwd is inside it, or the tree is dirty |
| GET `/api/sessions?project=&state=a,b&tag=&model=&origin=&q=&archived=&pinned=&since=&limit=` | `Session[]` (newest `updatedAt` first; `archived` defaults to false) |
| POST `/api/sessions` (`StartSessionRequest`) | `Session` (201) |
| GET `/api/sessions/:id` | `SessionDetail` |
| PATCH `/api/sessions/:id` (`UpdateSessionRequest`) | `Session` |
| DELETE `/api/sessions/:id` | 204 |
| POST `/api/sessions/:id/messages` (`UserMessage`) | `Session` |
| POST `/api/sessions/:id/permissions/:requestId` (`PermissionAnswer`) | 204 |
| POST `/api/sessions/:id/interrupt` | 204 |
| POST `/api/sessions/:id/end` | `Session` |
| POST `/api/sessions/:id/fork` (`ForkSessionRequest`) | `Session` (201) |
| GET `/api/sessions/:id/checkpoints` | `Checkpoint[]` (oldest first) |
| GET `/api/sessions/:id/checkpoints/:cid/diff?against=turn\|current` | `CheckpointDiff` |
| POST `/api/sessions/:id/checkpoints/:cid/restore` (`RestoreCheckpointRequest`) | `RestoreCheckpointResult` |
| POST `/api/projects/:name/discover` | `{ added }` |
| GET `/api/models?harness=claude` | `ModelInfo[]` |
| GET `/api/artifacts/:id` | `ArtifactDetail` |
| GET `/api/projects/:name/artifacts?limit=` | `Artifact[]` (newest first) |
| POST `/api/artifacts/:id/submit` (`ArtifactSubmitRequest`) | `Session` |
| GET `/a/:id/:version` | the sandboxed page (text/html), bridge injected |
| GET `/api/library?kind=` | `LibraryAsset[]` |
| GET `/api/library/:kind/:id` | `AssetDetail` |
| GET `/api/library/:kind/:id/versions/:version` | `AssetFiles` |
| PUT `/api/library/:kind/:id` (`SaveAssetRequest`) | `LibraryAsset` (201 when new) |
| DELETE `/api/library/:kind/:id` | 204 |
| POST `/api/library/rescan` | 204 |
| POST `/api/library/import` (`ImportRequest`) | `ImportPreview` |
| POST `/api/library/import/:previewId` | `LibraryAsset` (201) |
| POST `/api/library/plugin/:id/export` (`ExportRequest`) | `ExportResult` |
| GET `/api/projects/:name/library` | `Installation[]` |
| POST `/api/projects/:name/library` (`InstallRequest`) | `InstallResult` |
| GET `/api/projects/:name/library/:kind/:id/files` | `AssetFiles` (404 when missing) |
| POST `/api/projects/:name/sync` | 204; 409 when sync is off; 502 when the run fails (scrubbed) |
| POST `/api/ingest` | `IngestResponse` |
| GET/POST `/api/projects/:name/tracking/claude-code` | `ClaudeCodeTrackingStatus` |
| GET `/api/metrics?groupBy=&project=&since=&until=` | `MetricsRow[]` |
| GET `/api/projects/:name/activity?days=` | `ProjectActivity` (`days` default 84, 1–168) |
| GET `/api/settings` | `SettingsResponse` |
| GET `/api/readiness` | `ReadinessResponse` |
| GET `/api/secrets` | `SecretsResponse` (no values) |
| PUT `/api/secrets/:name` (`PutSecretRequest`) | `SecretInfo` |
| DELETE `/api/secrets/:name` | 204 |
| GET `/api/mcp/:id/oauth` | `McpOAuthStatus` |
| POST `/api/mcp/:id/oauth/start` (`StartMcpOAuthRequest`) | `StartMcpOAuthResponse` |
| DELETE `/api/mcp/:id/oauth` | 204 |
| GET `/api/oauth/callback?code=&state=&error=` | HTML page (the authorization server's redirect) |
| PATCH `/api/settings` (`UpdateSettingsRequest`) | `SettingsResponse` |

## SSE (`GET /api/events`)

- Frames: `event: <type>\ndata: <json>\n\n`, typed `ServerEvent`. A `heartbeat` on connect and every 20s.
- The client reconnects with backoff when nothing arrives for `STALE_MS`, and refetches REST state on reconnect.
- `session.updated` carries the full record; `session.event` carries one `HarnessEvent` for live views;
  `project.updated` means "refetch this project". `checkpoint.updated` carries one `Checkpoint` (merge by `id`).

## SQLite

- `node:sqlite` `DatabaseSync`, WAL, foreign keys on. `db/schema.sql` is version 1 of `state.db`; changes are new
  numbered files in `db/migrations/` (`0002_…sql`). Never edit a migration once merged. `schema.sql` plus the
  migrations is the current shape.
- JSON columns are TEXT; each module owns its tables and goes through the owning service to change others.
  Main tables by module:

| Module | Tables |
|---|---|
| settings | `app_settings` |
| projects | `projects` |
| sessions | `sessions` |
| checkpoints | `checkpoints` |
| sync | `gh_map`, `sync_state`, `pulls` |
| ingest | `session_events` |
| artifacts | `artifacts`, `artifact_versions` |
| library | `library_versions`, `installations`, `plugin_installations` |

  A module may **read** another module's tables for joins.

## Wiring

- Every factory is `createXService(deps, services)`; `server.ts` creates them all into one `services` object. A
  factory may subscribe to other services' listeners but must not call them while constructing.
- Routes: `registerXRoutes(router, deps, services)` in the module's `routes.ts`; `http/api.ts` already lists every
  module.

## Conventions

- Node runs TypeScript directly: erasable syntax only, `.ts` imports. Core and shared: double quotes, semicolons;
  web: Prettier (no semis, single quotes) and Instrument UI's rules.
- Tests sit next to the code: `node:test` in core/shared/adapters, vitest in web. Temp dirs, `:memory:` databases,
  `fakeHarness()`, fake GitHub, no network; never the real `~/.odin` or `~/.claude` (`testDeps()`, `startApp()`).
- Session worktree branches are `odin/<slug>-<id8>` unless the request names one.
