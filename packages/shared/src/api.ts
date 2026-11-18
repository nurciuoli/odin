// REST types shared by core and web. docs/contracts.md explains how they behave; this file is the source of truth.
// Times are ISO-8601 strings. Session IDs are stable Odin IDs (Claude uses the same UUID; Codex IDs are mapped).
import type { PermissionRequest, SlashCommand, TranscriptEntry } from "./harness.ts";

/** Paths are slash-separated relative to the session's working directory. */
export interface SessionFileEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
  size: number | null;
}
export interface SessionFileListing {
  path: string;
  entries: SessionFileEntry[];
  truncated: boolean;
}
/** One `@` file-reference suggestion; directories end without a slash. */
export interface FileMatch {
  path: string;
  kind: "file" | "directory";
}
/** Fuzzy path matches for `query`, best first. */
export interface FileSearchResult {
  query: string;
  matches: FileMatch[];
  /** True when the folder had more files than Odin indexes. */
  truncated: boolean;
}
/** One file in a project's map: its size, and what the working tree changed in it against HEAD. */
export interface ProjectMapFile {
  /** Slash-separated, relative to the project folder. */
  path: string;
  size: number;
  /** Lines now (text files only); lets a client judge how much of the file changed. Absent for binary files. */
  lines?: number;
  /** Lines added and removed against HEAD, untracked text files counting as all added. Absent when unchanged. */
  added?: number;
  removed?: number;
}
/** The project's tracked and unignored files, for the Files tab's treemap. */
export interface ProjectFileMap {
  files: ProjectMapFile[];
  /** True when the folder had more files than Odin maps. */
  truncated: boolean;
}
export interface SessionTextFile {
  path: string;
  content: string;
  /** Opaque content version; required on save to detect external edits. */
  version: string;
  size: number;
}

/** A shallow directory listing on the machine running Odin; never includes file contents. */
export interface ProjectFolders {
  path: string;
  parent: string | null;
  folders: { name: string; path: string }[];
}

// ── Projects ────────────────────────────────────────────────────────────────

export interface ProjectCommands {
  install?: string;
  check?: string;
  build?: string;
}

/**
 * A project's settings. Effective value = saved override ?? PROJECT.md frontmatter ?? a discovered source
 * (overview document, package.json scripts, git remote) ?? the default. Odin never writes project files.
 */
export interface ProjectSettings {
  /** Optional GitHub PR integration. Off unless explicitly enabled. No issue or milestone mirroring. */
  githubEnabled?: boolean;
  /** Run new sessions in a fresh worktree by default. Unset falls back to AppSettings.defaultWorktree. */
  defaultWorktree?: boolean;
  title: string;
  description: string;
  /** GitHub owner/name, or null for a local-only project. */
  repo: string | null;
  defaultBranch: string;
  commands: ProjectCommands;
}

export interface GitState {
  branch: string | null;
  headSha: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
}

export type SyncState = "off" | "idle" | "syncing" | "error";

export interface SyncStatus {
  state: SyncState;
  lastSyncAt: string | null;
  /** Human-readable, never contains the token. */
  error: string | null;
}

/** Live session counts for a project (or everything, on Home). */
export interface SessionCounts {
  running: number;
  waiting: number;
  /** Not archived. */
  total: number;
}

export interface ProjectSummary {
  name: string;
  title: string;
  description: string;
  path: string;
  repo: string | null;
  /** True when the path no longer exists; non-git folders are supported. */
  missing: boolean;
  sessions: SessionCounts;
  sync: SyncStatus;
  /** Sessions with any activity per local calendar day, the last 14 days, oldest first (today last). Always 14 entries. */
  activity: number[];
  updatedAt: string;
}

/** One day of GET /api/projects/:name/activity. */
export interface ProjectActivityDay {
  /** Local calendar day (the server's time zone), YYYY-MM-DD. */
  date: string;
  /** Sessions with any activity that day (working project or in projects[]). */
  sessions: number;
  activeMs: number;
  costUsd: number | null;
  /**
   * Commits reachable from any local branch, de-duplicated, whose author date falls on this day. Null when the
   * project folder is not a git repository (or is missing).
   */
  commits: number | null;
  /** Lines added in the diffs of sessions active that day (each session counts once, on its last active day). */
  added: number;
  /** Lines removed, counted like `added`. */
  removed: number;
}

/** GET /api/projects/:name/activity?days=. */
export interface ProjectActivity {
  /** Oldest first, no gaps, today last. */
  days: ProjectActivityDay[];
}

/** One local branch of a project. GET /api/projects/:name/branches. */
export interface ProjectBranch {
  name: string;
  headSha: string;
  /** Against the default branch. */
  ahead: number;
  behind: number;
  /** Fully merged into the default branch. */
  merged: boolean;
  lastCommitAt: string;
  /** Set when a worktree has this branch checked out. */
  worktreePath: string | null;
  /** True for the project checkout's current branch. */
  current: boolean;
  sessionIds: string[];
  pull: PullRef | null;
}

/** DELETE /api/projects/:name/worktrees. */
export interface RemoveWorktreeRequest {
  /** Absolute path of a worktree Odin created for this project. */
  path: string;
}

export interface ProjectDetail extends ProjectSummary {
  settings: ProjectSettings;
  /** Problems reading PROJECT.md (defaults used), or null. PROJECT.md is optional: missing is not an error. */
  manifestError: string | null;
  git: GitState;
  /** Raw markdown of the first status document, or null when none is selected. */
  status: string | null;
  /** Subagents available for delegation; never a replacement for the session's default agent. */
  agents: ProjectAgent[];
  /** Files Odin wrote into the repo (library installs, tracking hooks, permission rules) that git still shows as changed. */
  dirtyFiles: string[];
  /** Where project fields, excerpts and planning links came from. */
  context: ProjectContext;
  /** Earliest `createdAt` of the project's sessions (not archived, not side threads), or null when there are none. */
  firstSessionAt: string | null;
  /** Latest `updatedAt` of the same sessions, or null. */
  lastSessionAt: string | null;
}

/** Repo-relative documents Odin reads. Empty means the user chose none. */
export interface ProjectSourceSelection {
  /** Overview document. Its heading and first paragraph fill title and description when nothing higher is set. */
  overview: string | null;
  /** Status documents, quoted on the overview. The first one is `ProjectDetail.status`. */
  status: string[];
  /** Planning directories. Markdown under them is listed. */
  planning: string[];
}

/** Where one effective project field came from. */
export type ProjectOrigin =
  | { kind: "override" }
  | { kind: "manifest"; path: "PROJECT.md" }
  | { kind: "document"; path: string }
  | { kind: "package"; path: "package.json" }
  | { kind: "git" }
  | { kind: "default" };

export interface ProjectProvenance {
  title: ProjectOrigin;
  description: ProjectOrigin;
  repo: ProjectOrigin;
  commands: Partial<Record<keyof ProjectCommands, ProjectOrigin>>;
}

/** A short deterministic quote. `text` is plain, capped, and cites `path`. */
export interface ProjectExcerpt {
  path: string;
  heading: string | null;
  text: string;
}

/** A markdown file under a planning directory. `status` is the file's own word. */
export interface PlanningDocument {
  path: string;
  title: string;
  status: string | null;
  root: string;
}

export interface ProjectContext {
  /** True when the user saved a source selection. False means discovery is in effect. */
  customized: boolean;
  /** Paths currently used. Missing files are omitted here and listed in `missing`. */
  sources: ProjectSourceSelection;
  /** What discovery would select right now, ignoring a saved selection. */
  discovered: ProjectSourceSelection;
  provenance: ProjectProvenance;
  excerpts: ProjectExcerpt[];
  planning: PlanningDocument[];
  /** True when the planning walk stopped at its file cap. */
  planningTruncated: boolean;
  /** Saved paths that are not a file or directory inside the project. */
  missing: string[];
}

/** PATCH /api/projects/:name/sources. `null` clears the saved selection and returns to discovery. */
export type UpdateProjectSourcesRequest = ProjectSourceSelection | null;

const PROJECT_RELATIVE_MAX = 240;

/** A repo-relative path Odin will read. Rejects absolute paths, blanks, and parent segments. */
export function normalizeProjectRelativePath(input: string): string | null {
  const text = input.replace(/\\/g, "/").trim();
  if (!text || text.length > PROJECT_RELATIVE_MAX) return null;
  if (text.startsWith("/") || /^[A-Za-z]:/.test(text)) return null;
  const parts = text.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".." || part.includes("\0"))) return null;
  return parts.join("/");
}

/** Shape check for a source selection. Existence inside the project is the server's job. */
export function parseProjectSources(input: unknown): { ok: true; selection: ProjectSourceSelection } | { ok: false; error: string } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "expected a sources object" };
  const body = input as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (key !== "overview" && key !== "status" && key !== "planning") return { ok: false, error: `unknown source "${key}"` };
  }
  let overview: string | null = null;
  if (body.overview !== undefined && body.overview !== null) {
    if (typeof body.overview !== "string") return { ok: false, error: "overview must be a path or null" };
    overview = normalizeProjectRelativePath(body.overview);
    if (!overview) return { ok: false, error: "overview must be a path inside the project" };
  }
  const list = (key: "status" | "planning", max: number): string[] | string => {
    const value = body[key];
    if (value === undefined) return [];
    if (!Array.isArray(value)) return `${key} must be a list of paths`;
    if (value.length > max) return `${key} has too many paths`;
    const out: string[] = [];
    for (const entry of value) {
      if (typeof entry !== "string") return `${key} paths must be strings`;
      const path = normalizeProjectRelativePath(entry);
      if (!path) return `${key} paths must stay inside the project`;
      if (out.includes(path)) return `${key} lists ${path} twice`;
      out.push(path);
    }
    return out;
  };
  const status = list("status", 8);
  if (typeof status === "string") return { ok: false, error: status };
  const planning = list("planning", 8);
  if (typeof planning === "string") return { ok: false, error: planning };
  return { ok: true, selection: { overview, status, planning } };
}

/** A context with nothing discovered and nothing saved. */
export function emptyProjectContext(): ProjectContext {
  const fallback: ProjectOrigin = { kind: "default" };
  const sources: ProjectSourceSelection = { overview: null, status: [], planning: [] };
  return {
    customized: false,
    sources: { ...sources, status: [], planning: [] },
    discovered: { overview: null, status: [], planning: [] },
    provenance: { title: fallback, description: fallback, repo: fallback, commands: {} },
    excerpts: [],
    planning: [],
    planningTruncated: false,
    missing: [],
  };
}

/** POST /api/projects: register an existing directory. Odin never moves or deletes it. */
export interface CreateProjectRequest {
  /** Absolute path to a directory (git is optional). */
  path: string;
  /** Defaults to the folder name, lowercased and slugged (must match PROJECT_NAME_PATTERN, unique). */
  name?: string;
  /** Optionally initialise git when the directory has no repository (no commit). */
  init?: boolean;
}

/** PATCH /api/projects/:name/settings. Every field optional; stored in Odin's DB. `null` clears an override. */
export type UpdateProjectSettingsRequest = {
  [K in keyof ProjectSettings]?: ProjectSettings[K] | null;
};

/** An agent file in a project's .claude/agents/ (Claude Code subagent format). */
export interface ProjectAgent {
  /** File name minus .md. */
  id: string;
  name: string;
  description: string;
  /** Claude Code model alias or id as written (sonnet, opus, haiku, inherit, claude-…), or null. */
  model: string | null;
  tools: string[] | null;
  /** Repo-relative, e.g. .claude/agents/reviewer.md */
  path: string;
  /** Content hash (see library versions). */
  version: string;
  /** Set when the file is a library install: the library asset it came from. */
  libraryId: string | null;
  error: string | null;
}

// ── Sessions ────────────────────────────────────────────────────────────────

/** Harness ids. A session keeps the id it started with. */
export type HarnessId = "claude" | "codex" | "codex-wsl" | "grok" | "opencode" | "antigravity" | (string & {});

/**
 * idle: open, waiting for the next user message (or closed and resumable). running: the harness is working.
 * waiting: blocked on the user (a permission prompt or a question). ended: the session was closed. failed: the
 * harness errored and the session can't continue without a resume.
 */
export type SessionState = "idle" | "running" | "waiting" | "ended" | "failed";
export type SessionOrigin = "odin" | "external";

/** Claude Code permission modes. */
export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions" | "dontAsk" | "auto";

export type Workspace =
  | { kind: "checkout" }
  /** A git worktree Odin made under <ODIN_HOME>/worktrees/, on its own branch. */
  | { kind: "worktree"; path: string; branch: string };

export type ChecksResult = "pass" | "fail" | "skipped";
export type PrOutcome = "open" | "merged" | "merged-after-changes" | "closed";

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface SessionMetrics {
  /** First event → last event (or now while live). */
  wallMs: number | null;
  /** Σ turn durations. */
  activeMs: number | null;
  turns: number;
  toolCalls: number;
  tokens: TokenUsage;
  /** Per model, so Compare can price and group. */
  tokensByModel: Record<string, TokenUsage>;
  /** pricing.json × tokens when every model is priced; else the harness's own reported cost; else null. */
  costUsd: number | null;
  /** Tokens in the context window at the last turn, when the harness reports it. */
  contextTokens: number | null;
  /** Runtime-reported context capacity; absent on older measurements. */
  contextWindow?: number | null;
  /** git diff against the merge base with the default branch, for the session's branch/worktree. */
  diff: { added: number; removed: number; files: number } | null;
  commits: number | null;
  prOutcome: PrOutcome | null;
  reviewRounds: number;
}

export interface PullRef {
  number: number;
  url: string;
  state: "open" | "closed";
  merged: boolean;
}

export interface Session {
  /** Native runtime controls, persisted across resume and fork. */
  runtimeOptions?: RuntimeOptions;
  /** null restores the harness default. Applied to subsequent turns. */
  effort?: Effort | null;
  /** Stable Odin session id; the driver maps to a native id when needed. */
  id: string;
  harness: HarnessId;
  /** Working project for cwd, worktree, branch and legacy attribution; not a navigation parent. */
  project: string;
  /** Configured repositories, working project first. */
  projects: string[];
  title: string;
  tags: string[];
  pinned: boolean;
  archived: boolean;
  origin: SessionOrigin;
  state: SessionState;
  /** What a `waiting` session waits for. */
  waitingFor: "permission" | "question" | null;
  /** Where the harness runs: the project path, or the worktree path. */
  cwd: string;
  workspace: Workspace;
  /** Git branch at start (or the worktree's branch). */
  branch: string | null;
  /** As the harness reports it (alias resolved when known). Mixed models: the one with most output tokens. */
  model: string | null;
  permissionMode: PermissionMode | null;
  /** Historical/imported main-thread agent name. New Odin sessions use the default agent (null). */
  agent: string | null;
  /** Library content hash of that agent when it came from the library or a tracked project file. */
  agentVersion: string | null;
  /** Historical template attribution; null for new sessions. */
  templateId: string | null;
  /** The session this one was forked from. */
  parentId: string | null;
  /**
   * A side thread: a fork of `parentId` for a question asked during that session. Left out of session lists, counts,
   * Home and the sidebar unless asked for (`SessionFilter.aside` / `parentId`); shown beside its parent.
   */
  aside: boolean;
  pull: PullRef | null;
  createdAt: string;
  /** Last activity. */
  updatedAt: string;
  endedAt: string | null;
  error: string | null;
  metrics: SessionMetrics;
}

export interface SessionDetail extends Session {
  /** Durable follow-up messages, separate from native conversation history. */
  messageQueue: MessageQueue;
  /** The conversation so far, from the harness's own transcript (Odin stores none). */
  transcript: TranscriptEntry[];
  /** IDs of partial assistant/thinking entries that still accept deltas. Empty when no turn is streaming. */
  streaming?: string[];
  /** Open permission prompts / questions, oldest first. */
  pending: PermissionRequest[];
  /** Latest todo list the agent wrote (TodoWrite), or empty. */
  todos: Todo[];
  /** Artifacts posted in this session. */
  artifacts: Artifact[];
  /** True while Odin holds a live harness handle (it can send/answer/interrupt without a resume). */
  live: boolean;
  /**
   * Slash commands for the composer, as the harness reports them: from the live handle's `init` or `commands`, else
   * the last ones reported for this session, else for its project; empty when none is known yet.
   */
  slashCommands: SlashCommand[];
}

export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export interface SessionFilter {
  project?: string;
  state?: SessionState[];
  tag?: string;
  model?: string;
  origin?: SessionOrigin;
  /** Title / first prompt substring, case-insensitive. */
  q?: string;
  archived?: boolean;
  pinned?: boolean;
  /** Side threads: true lists only side threads, false (the default) leaves them out. Ignored with `parentId`. */
  aside?: boolean;
  /** Sessions forked from this one (side threads included). */
  parentId?: string;
  /** updatedAt >= since */
  since?: string;
  limit?: number;
}

/** An attachment on a user message. Images go to the model as image blocks; text files inline. */
export interface Attachment {
  name: string;
  mediaType: string;
  /** base64 for images, utf-8 text otherwise. ≤ 5 MB decoded. */
  data: string;
}

export interface UserMessage {
  /** Optional per-session idempotency key for follow-up sends. */
  clientId?: string;
  text: string;
  attachments?: Attachment[];
}

export interface QueuedMessage {
  id: string;
  message: UserMessage;
  state: "queued" | "sending" | "uncertain";
  createdAt: string;
  updatedAt: string;
}

export interface MessageQueue {
  /** Monotonic per-session version; reject older snapshots after reconnect/action races. */
  revision: number;
  paused: boolean;
  messages: QueuedMessage[];
}

/** POST /api/sessions */
export interface StartSessionRequest {
  runtimeOptions?: RuntimeOptions;
  /** null restores the harness default. Applied to subsequent turns. */
  effort?: Effort | null;
  project: string;
  /** All configured projects, including `project`. Defaults to [project]. */
  projects?: string[];
  /** Runtime id. Request > app default > claude; unknown → 400. */
  harness?: HarnessId;
  /** The first message; required at runtime. */
  prompt?: UserMessage;
  title?: string;
  model?: string;
  permissionMode?: PermissionMode;
  /** @deprecated Rejected at launch. Agents are subagents, installed through the library. */
  agent?: string;
  /** Run in a new worktree on its own branch. Default false (the checkout). */
  worktree?: boolean;
  /** Branch for the worktree. Default `odin/<slug>-<short id>`. */
  branch?: string;
  /** Library MCP server ids to pass at start (not written to the repo). */
  mcp?: string[];
  /** @deprecated Rejected at launch. Translate reusable task instructions into a skill. */
  templateId?: string;
  /** Optional substitutions in the first message; retained for API callers. */
  variables?: Record<string, string>;
  tags?: string[];
}

/** POST /api/sessions/:id/fork */
export interface ForkSessionRequest {
  title?: string;
  /** Fork into a new worktree (default: same workspace as the parent). */
  worktree?: boolean;
  /** Optional first message for the fork. */
  prompt?: UserMessage;
  /**
   * A side thread (`Session.aside`). Requires `prompt`; never gets a worktree (400 with `worktree: true`). Starts in
   * `plan` mode unless `permissionMode` says otherwise, so it can read but not edit what the parent is working on.
   * Allowed while the parent is running or waiting: it forks the conversation as stored so far.
   */
  aside?: boolean;
  /** Mode for the fork's first turn. Default: the parent's (`plan` for a side thread). */
  permissionMode?: PermissionMode;
  /** Model for the fork. Default: the parent's. */
  model?: string;
}

/** PATCH /api/sessions/:id */
export interface UpdateSessionRequest {
  runtimeOptions?: RuntimeOptions;
  /** null restores the harness default. Applied to subsequent turns. */
  effort?: Effort | null;
  title?: string;
  tags?: string[];
  pinned?: boolean;
  archived?: boolean;
  /** Live only. */
  model?: string;
  /** Live only. */
  permissionMode?: PermissionMode;
  /** `false` promotes a side thread to an ordinary session; `true` is a 400. */
  aside?: boolean;
}

/** POST /api/sessions/:id/permissions/:requestId */
export type PermissionAnswer =
  | {
      behavior: "allow";
      /** once: this call only. session/project/local/user: also add an allow rule at that scope (Claude Code settings). */
      scope: "once" | "session" | "project" | "local" | "user";
      /** Replaces the tool input (question answers, an edited plan or command). */
      updatedInput?: Record<string, unknown>;
    }
  | { behavior: "deny"; message?: string; /** Also stop the turn. */ interrupt?: boolean };

// ── Secrets ─────────────────────────────────────────────────────────────────

/** A vault secret as the API shows it. The value is never returned. */
export interface SecretInfo {
  /** SECRET_NAME_PATTERN. Library MCP specs refer to it as `${secret:NAME}`. */
  name: string;
  createdAt: string;
  updatedAt: string;
  /** Library MCP server ids whose spec refers to this secret. */
  usedBy: string[];
}

/** PUT /api/secrets/:name. Creates or replaces. */
export interface PutSecretRequest {
  value: string;
}

/** GET /api/secrets. Secrets sorted by name, plus names MCP specs refer to that are not set, so a UI can flag them. */
export interface SecretsResponse {
  secrets: SecretInfo[];
  /** Referenced by a library MCP spec but not in the vault. */
  missing: { name: string; usedBy: string[] }[];
}

// ── Library ─────────────────────────────────────────────────────────────────

/** command/prompt/template remain readable by the migration parser only; not active library kinds. */
export type AssetKind = "instruction" | "agent" | "skill" | "command" | "prompt" | "template" | "mcp" | "settings";

/** A template: a session preset. Ids refer to other library assets. */
export interface TemplateSpec {
  /** Default runtime; an explicit launch selection wins. Omitted assets remain portable. */
  harness?: HarnessId;
  /** Native overrides of the shared preset, keyed by harness family (claude/codex). */
  harnessOverrides?: Record<string, { model?: string; permissionMode?: PermissionMode; agent?: string }>;
  /** Prompt text with {{variables}}, or empty to use `promptId`. */
  prompt: string;
  promptId: string | null;
  model: string | null;
  permissionMode: PermissionMode | null;
  /** Library agent id (`library:<id>`) or a project agent id. */
  agent: string | null;
  worktree: boolean;
  /** Library MCP server ids. */
  mcp: string[];
  tags: string[];
}

/**
 * Strings in `args`, `env`, `url` and `headers` may contain `${secret:NAME}`; core fills them from the vault at
 * launch and never writes the value to the library, `launch_config` or the repo.
 */
export type McpServerSpec =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "http" | "sse"; url: string; headers?: Record<string, string> };

/** Permission rules and hooks, merged into .claude/settings.json on install. */
export interface SettingsProfileSpec {
  opencode?: { permissionRules?: NativePermissionRule[]; instructions?: string };
  /** Native policy for Codex; replaces Claude rule/hook semantics explicitly. */
  codex?: { permissionMode: PermissionMode; instructions?: string };
  permissions?: { allow?: string[]; deny?: string[]; ask?: string[] };
  hooks?: Record<string, unknown>;
}

export interface LibraryAsset {
  kind: AssetKind;
  /** Slug, unique within the kind (ASSET_ID_PATTERN). */
  id: string;
  name: string;
  description: string;
  /** Content hash of the current files (libraryHash). */
  version: string;
  updatedAt: string;
  /** Files relative to the asset's root in the library (one for most kinds; a skill can have several). */
  files: string[];
  /** Parsed, per kind: agent → {model, tools}; prompt → {variables}; template → TemplateSpec; mcp → McpServerSpec; settings → SettingsProfileSpec. */
  meta: Record<string, unknown>;
  /** Problems parsing the files. */
  error: string | null;
}

export interface AssetVersion {
  version: string;
  firstSeenAt: string;
  /** Sessions started with this version (agents, templates). */
  sessionCount: number;
}

/** An asset's files: path relative to the asset root → UTF-8 content. */
export type AssetFiles = Record<string, string>;

export interface AssetDetail {
  asset: LibraryAsset;
  files: AssetFiles;
  versions: AssetVersion[];
  /** Projects it's installed in, with their drift state. */
  installs: Installation[];
}

/** PUT /api/library/:kind/:id — create or replace the asset's files; records a new version when content changes. */
export interface SaveAssetRequest {
  files: AssetFiles;
}

/**
 * current: project file = installed version = library version. update-available: library moved on, project untouched.
 * modified: project file changed since install, library didn't. conflict: both changed. missing: the file is gone.
 */
export type DriftState = "current" | "update-available" | "modified" | "conflict" | "missing";

export interface Installation {
  project: string;
  kind: AssetKind;
  id: string;
  /** Library version that was installed (or last updated / pushed). */
  installedVersion: string;
  libraryVersion: string | null;
  /** Hash of what's in the project now, or null when missing. */
  projectVersion: string | null;
  state: DriftState;
  /** Repo-relative paths written (for mcp/settings: the merged file). */
  paths: string[];
  installedAt: string;
}

/** POST /api/projects/:name/library: install, update, or push back. */
export interface InstallRequest {
  kind: AssetKind;
  id: string;
  /** install: copy library → project (refused over a modified file unless `force`). update: same, for an installed asset. push: project → library (new library version). forget: stop tracking, files stay. */
  action: "install" | "update" | "push" | "forget";
  force?: boolean;
}

export interface InstallResult {
  installation: Installation | null;
  /** Repo-relative files Odin changed. It never commits them. */
  changed: string[];
}

// ── Artifacts ───────────────────────────────────────────────────────────────

export interface Artifact {
  id: number;
  project: string;
  sessionId: string;
  title: string;
  latestVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactVersion {
  artifactId: number;
  version: number;
  createdAt: string;
  bytes: number;
  note: string;
}

export interface ArtifactDetail {
  artifact: Artifact;
  versions: ArtifactVersion[];
}

/** POST /api/artifacts/:id/submit — what the artifact sent through `odin.submit`. Delivered as a user message. */
export interface ArtifactSubmitRequest {
  version: number;
  data: unknown;
}

// ── Metrics ─────────────────────────────────────────────────────────────────

export type MetricsDimension = "model" | "agent" | "agentVersion" | "template" | "harness" | "project" | "origin";

export interface MetricsQuery {
  /** 0 to 3 distinct dimensions. Empty returns exactly one row over every session in the population. */
  groupBy: MetricsDimension[];
  project?: string;
  /** Sessions with updatedAt >= since. */
  since?: string;
  /** Sessions with createdAt < until. With `since`, the sessions that overlap [since, until). */
  until?: string;
}

export interface MetricsRow {
  /** One entry per groupBy dimension; "∅" for unknown. */
  key: Partial<Record<MetricsDimension, string>>;
  n: number;
  /** n < LOW_CONFIDENCE_N */
  lowConfidence: boolean;
  median: {
    wallMs: number | null;
    activeMs: number | null;
    turns: number | null;
    toolCalls: number | null;
    tokensOut: number | null;
    costUsd: number | null;
    diffLines: number | null;
  };
  /** 0..1 over sessions where the value is known; null when none are. */
  rates: {
    /** merged (clean or after changes) / sessions with a merged or closed PR. */
    merged: number | null;
    /** merged with 0 review rounds / the same denominator. */
    mergedClean: number | null;
    /** sessions that ended `failed` / all. */
    failed: number | null;
  };
  /** Sums over the row's sessions. `costUsd` sums the known costs; null when no session's cost is known. */
  total: {
    tokens: TokenUsage;
    costUsd: number | null;
  };
  sessionIds: string[];
}

// ── Pricing and settings ───────────────────────────────────────────────────

/** USD per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type Effort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface NativePermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
}

export interface RuntimeOptions {
  agent?: string | null;
  variant?: string | null;
  permissionRules?: NativePermissionRule[];
}

/** Display-safe metadata only. Configuration values, environment and credentials are excluded. */
export interface NativeCatalog {
  agents: { name: string; description: string; mode: "primary" | "subagent" | "all"; hidden?: boolean }[];
  commands: { name: string; description: string }[];
  skills: { name: string; description: string }[];
  providers: { id: string; name: string; enabled: boolean }[];
  mcp: { name: string; status: string }[];
  plugins: string[];
  /** Package targets accepted by the native updater; built-in plugins are excluded. */
  updatablePlugins?: string[];
}

export type NativeSessionAction =
  | { type: "compact" }
  | { type: "revert"; messageId: string; files?: boolean }
  | { type: "unrevert" }
  | { type: "commitRevert" }
  | { type: "command"; name: string; arguments: string }
  | { type: "updatePlugins"; targets: string[] }
  | { type: "reload" }
  | { type: "shell"; command: string };

export interface NativeSessionState {
  revert: { messageId: string; partId?: string } | null;
  context?: import("./harness.ts").TranscriptEntry[];
  diff?: { path: string; patch: string; added: number; removed: number; status: string }[];
}

export interface ModelInfo {
  /** Native named variants; independent of the shared effort levels. */
  variants?: string[];
  /** Native model-supported effort levels; absent means unavailable. */
  effortLevels?: Effort[];
  /** What to pass as `model` (alias or id). */
  value: string;
  displayName: string;
  description: string;
  /** The concrete model id an alias resolves to, when known. */
  resolved: string | null;
}

/**
 * The catalog entry a session's model refers to: an exact `value` first, else the alias whose `resolved` id it is
 * (sessions often report the concrete id, e.g. "claude-opus-5-5" for "opus"). Case-insensitive.
 */
export function findModel<T extends ModelInfo>(models: readonly T[], model: string | null | undefined): T | undefined {
  const id = model?.trim().toLowerCase();
  if (!id) return undefined;
  return models.find((m) => m.value.toLowerCase() === id) ?? models.find((m) => m.resolved?.toLowerCase() === id);
}

export interface HarnessInfo {
  id: HarnessId;
  name: string;
  available: boolean;
  /** Why it isn't available, or a note (e.g. "auth: inherited from the environment"). Never contains a secret. */
  note: string | null;
  capabilities?: HarnessCapabilities;
}

export interface HarnessCapabilities {
  native?: { agents: boolean; variants: boolean; permissionRules: boolean; actions: NativeSessionAction["type"][] };
  permissionModes: PermissionMode[];
  permissionScopes: PermissionAnswerScope[];
  /** False means launches with additional repositories must be rejected before starting. */
  additionalDirectories?: boolean;
  /** Whether supplemental instructions can be applied independently of the native project instructions. */
  instructions?: boolean;
  /** False means messages with attachments must be rejected, never silently reduced to text. */
  attachments?: boolean;
  /** A mode change takes effect on the next turn. */
  settingsOnNextTurn?: boolean;
}

export type PermissionAnswerScope = "once" | "session" | "project" | "local" | "user";

/** GET/PATCH /api/settings. Odin's own defaults, in the DB. */
export interface AppSettings {
  defaultHarness?: HarnessId;
  /** Runtime defaults override the legacy Claude defaults. */
  harnessDefaults?: Record<string, { model: string | null; permissionMode: PermissionMode }>;
  defaultModel: string | null;
  defaultPermissionMode: PermissionMode;
  /** Default for the worktree toggle when starting a session. */
  defaultWorktree: boolean;
  /** Notify (desktop) when a session starts waiting. */
  notifyOnWaiting: boolean;
  /** Notify (desktop) when a session finishes a turn. Default true. */
  notifyOnFinished: boolean;
  /** Electron accelerator for the desktop launcher; null turns it off. Default "CommandOrControl+Shift+Space". */
  launcherShortcut: string | null;
  /** Command used to open a folder in an editor. Default "code". */
  editorCommand: string;
  /** Absolute executable paths that override PATH lookup. Default {}. */
  toolPaths: Partial<Record<ToolName, string>>;
}

export const TOOL_NAMES = ["claude", "codex", "grok", "opencode", "antigravity", "gh", "git"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export interface SettingsResponse {
  settings: AppSettings;
  pricing: Record<string, ModelPrice>;
  /** Whether a GitHub token was found (never the token). */
  github: { configured: boolean; source: "env" | "gh" | null };
  harnesses: HarnessInfo[];
  libraryPath: string;
}

// ── Readiness (first run: what this machine still needs) ───────────────────

/** ok; missing blocks sessions; warn may block; optional is a feature left off; todo is a next step. */
export type ReadinessState = "ok" | "missing" | "warn" | "optional" | "todo";
export type ReadinessCheckId = "harness" | "claude-auth" | "git" | "github" | "projects";

export interface ReadinessCheck {
  id: ReadinessCheckId;
  label: string;
  state: ReadinessState;
  /** What was found, plain text. Never a secret. */
  detail: string;
  /** What to do about it, when not ok. */
  fix: string | null;
}

export interface ReadinessResponse {
  /** No check is "missing". */
  ready: boolean;
  checks: ReadinessCheck[];
}

export interface UpdateSettingsRequest {
  settings?: Partial<AppSettings>;
  /** Replaces ~/.odin/pricing.json. */
  pricing?: Record<string, ModelPrice>;
}

// ── Tracking (Claude Code hooks for external sessions) ─────────────────────

export interface ClaudeCodeTrackingRequest {
  enabled: boolean;
}

export interface ClaudeCodeTrackingStatus {
  enabled: boolean;
  /** Repo-relative settings file the hooks live in (.claude/settings.local.json). */
  settingsPath: string;
}

// ── Errors ─────────────────────────────────────────────────────────────────

/** Every non-2xx JSON body. */
export interface ApiError {
  error: string;
}
