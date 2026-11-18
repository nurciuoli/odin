// The seams between core modules. Each module implements one interface here and receives the others through
// `Services`, so modules never import each other's internals. server.ts builds them and wires routes.
// Changing an interface here is a contract change: own commit, called out in the PR. docs/contracts.md.
//
// Wiring rule: every factory is `createXService(deps, services)` where `services` is the shared object server.ts
// fills in after all factories ran. A factory may subscribe to other services' listeners but must not *call* them
// while constructing (they may not exist yet); calls happen later, inside methods and listeners.
import type { DatabaseSync } from "node:sqlite";
import type {
  AppSettings, Artifact, ArtifactDetail, ArtifactSubmitRequest, AssetDetail, AssetFiles, AssetKind, CreateProjectRequest,
  ForkSessionRequest, ExportResult, ImportPreview, ImportRequest, Installation, InstallRequest, InstallResult, 
  LibraryAsset, MetricsQuery, MetricsRow, ModelPrice, PermissionAnswer,
  PermissionMode, ProjectActivity, ProjectAgent, ProjectBranch, ProjectDetail, ProjectSettings, PullRef, Session,
  MessageQueue, SessionCounts, SessionDetail, SessionFilter, SessionMetrics, SessionState, StartSessionRequest, SyncStatus,
  UpdateProjectSettingsRequest, UpdateProjectSourcesRequest, UpdateSessionRequest, UserMessage,
} from "@odin/shared/api";
import type { HarnessEvent, TaskHistory } from "@odin/shared/harness";
import type { IngestResponse } from "@odin/shared/ingest";
import type { Config } from "./config.ts";
import type { EventBus } from "./events.ts";
import type { Router } from "./http/router.ts";
import type { Harnesses, HostTool, McpServerStart } from "./harness/types.ts";

export interface Deps {
  config: Config;
  db: DatabaseSync;
  bus: EventBus;
  /** fetch for GitHub. Tests inject a fake; never the network in tests. */
  githubFetch: typeof fetch;
  /** fetch for MCP OAuth discovery, registration and tokens. Tests inject a fake; never the network in tests. */
  mcpFetch: typeof fetch;
  now: () => Date;
  /** Harness drivers by id. Production: Claude, Codex, Grok, OpenCode, and Antigravity. Tests pass fakeHarness(). */
  harnesses: Harnesses;
}

/** Something with timers, watchers or live handles to stop. */
export interface Closeable {
  close(): void | Promise<void>;
}

// ── projects (wave 1b: src/projects) ───────────────────────────────────────

export interface ProjectRef {
  name: string;
  path: string;
  settings: ProjectSettings;
  manifestError: string | null;
  missing: boolean;
}

export interface ProjectsService extends Closeable {
  list(): ProjectRef[];
  get(name: string): ProjectRef | null;
  /** Detail minus the parts other modules own (sessions, sync, activity, session span): the route fills those. */
  detail(name: string): Omit<ProjectDetail, "sessions" | "sync" | "activity" | "firstSessionAt" | "lastSessionAt"> | null;
  /** The project a path belongs to: the repo or anything below it, or one of its Odin worktrees. */
  resolveCwd(cwd: string): string | null;
  /** Registers an existing directory (git init'ing it when asked). Emits project.updated. */
  create(req: CreateProjectRequest): Promise<ProjectRef>;
  updateSettings(name: string, req: UpdateProjectSettingsRequest): Promise<ProjectRef>;
  /** `null` returns the project to discovered sources. A selection is stored in Odin and is not written into the repo. */
  updateSources(name: string, req: UpdateProjectSourcesRequest): Promise<ProjectRef>;
  /** Re-read PROJECT.md, agents and git state from disk. */
  refresh(name: string): Promise<void>;
  /** Unregisters. Never deletes files. */
  remove(name: string): void;
  agents(name: string): ProjectAgent[];
  /**
   * `git worktree add -b <branch> <ODIN_HOME>/worktrees/<project>/<branch slug> <base>` where base is
   * origin/<default> when it exists, else <default>. Reuses an existing worktree of that branch.
   */
  createWorktree(name: string, branch: string): Promise<{ path: string; branch: string }>;
  /**
   * Removes a Odin worktree (branch kept). 400 for paths outside <ODIN_HOME>/worktrees/<project>/ (never the
   * project checkout); 409 when a live session's cwd is inside it or the tree is dirty.
   */
  removeWorktree(name: string, path: string): Promise<void>;
  /**
   * Local branches with ahead/behind/merged against the default branch, the worktree that has each checked out,
   * the sessions on it and its PR. Read-only git. 404 unknown project.
   */
  branches(name: string): Promise<ProjectBranch[]>;
  /** Other modules report repo files they wrote (library installs, hooks, permission rules) for dirtyFiles. */
  noteWritten(name: string, repoRelativePaths: string[]): void;
}

// ── sessions (wave 1a: src/sessions) ───────────────────────────────────────

/** Record-level changes from other modules (ingest, sync links, metrics). */
export interface SessionPatch {
  effort?: import("@odin/shared/api").Effort | null;
  title?: string;
  state?: SessionState;
  waitingFor?: Session["waitingFor"];
  model?: string | null;
  permissionMode?: PermissionMode | null;
  agent?: string | null;
  branch?: string | null;
  pull?: PullRef | null;
  error?: string | null;
  endedAt?: string | null;
  updatedAt?: string;
  /** Merged into the stored metrics (shallow, per top-level key). */
  metrics?: Partial<SessionMetrics>;
}

/** An external session first seen through ingest or the harness's session list. */
export interface ExternalSessionInput {
  id: string;
  harness: string;
  project: string;
  cwd: string;
  title?: string;
  branch?: string | null;
  model?: string | null;
  agent?: string | null;
  at: string;
}

export interface SessionsService extends Closeable {
  nativeState(id: string): Promise<import("@odin/shared/api").NativeSessionState>;
  nativeAction(id: string, action: import("@odin/shared/api").NativeSessionAction): Promise<import("@odin/shared/api").NativeSessionState>;
  /** Runs one user-typed command in the session's working directory (the composer's `!` mode). Any harness. */
  shell(id: string, request: import("@odin/shared/api").ShellRunRequest): Promise<import("@odin/shared/api").ShellRunResult>;
  list(filter?: SessionFilter): Session[];
  get(id: string): Session | null;
  /** The record plus the harness transcript, open prompts, todos and artifacts. */
  detail(id: string): Promise<SessionDetail | null>;
  /** Looks up a task in this parent's transcript before fetching read-only child history. */
  taskMessages(id: string, taskKey: string): Promise<TaskHistory>;
  /** Plans the launch (services.launch), makes the worktree, starts the harness, returns once the record exists. */
  start(req: StartSessionRequest): Promise<Session>;
  /** Sends a message; resumes the harness session first when no live handle exists (external sessions too). */
  send(id: string, message: UserMessage): Promise<Session>;
  queue(id: string): MessageQueue;
  editQueuedMessage(id: string, messageId: string, message: UserMessage): MessageQueue;
  cancelQueuedMessage(id: string, messageId: string): MessageQueue;
  resumeQueue(id: string): Promise<MessageQueue>;
  /** Interrupts a running turn and dispatches the next queued message. An optional message is placed ahead of the queue. */
  sendNow(id: string, message?: UserMessage): Promise<MessageQueue>;
  retryQueuedMessage(id: string, messageId: string): MessageQueue;
  /** Answers an open prompt. 404 unknown session, 409 when the prompt is no longer open. */
  answer(id: string, requestId: string, answer: PermissionAnswer): void;
  interrupt(id: string): Promise<void>;
  update(id: string, req: UpdateSessionRequest): Promise<Session>;
  fork(id: string, req: ForkSessionRequest): Promise<Session>;
  /** Closes the live handle (state → ended). The harness session stays resumable. */
  end(id: string): Promise<Session>;
  /** Deletes the record and the harness's stored session. Closes it first if live. */
  remove(id: string): Promise<void>;
  /** Imports harness sessions in a project Odin has no record of (origin external). Returns how many are new. */
  discover(project: string): Promise<number>;
  counts(project?: string): SessionCounts;
  /** Creates the record for an external session if missing; returns it either way. */
  ensureExternal(input: ExternalSessionInput): Session;
  /** Applies a patch and emits session.updated. */
  patch(id: string, patch: SessionPatch): Session;
  /** Every record change (start, state, patch, metrics). */
  onUpdated(listener: (session: Session) => void): () => void;
  /** Every live harness event, after the record was updated from it (ingest records metrics from these). */
  onEvent(listener: (sessionId: string, event: HarnessEvent) => void): () => void;
}

// ── launch (wave 1a basic, wave 2g full: src/launch) ───────────────────────

/** The default agent launch settings, workspace, initial message and optional MCP servers. */
export interface LaunchPlan {
  title: string;
  prompt: UserMessage | null;
  model: string | null;
  permissionMode: PermissionMode | null;
  mcpServers: Record<string, McpServerStart>;
  worktree: boolean;
  /** Worktree branch when `worktree`. */
  branch: string | null;
  tags: string[];
}

export interface LaunchService {
  /** Resolve current library configuration for persisted MCP ids; never persist resolved secrets in sessions. */
  /** `skipDisabled`: leave switched-off library servers out instead of failing (resume and fork). */
  resolveMcpServers(ids: string[], opts?: { skipDisabled?: boolean }): Promise<Record<string, McpServerStart>>;
  /** 400 for a missing message, invalid settings or MCP, or obsolete primary-agent/template selections. */
  plan(req: StartSessionRequest, sessionId: string): Promise<LaunchPlan>;
}

// ── harness-side tools and artifacts (wave 2h: src/artifacts) ──────────────

export interface ArtifactsService {
  forSession(sessionId: string): Artifact[];
  /** Artifacts whose `project` is this one, newest `updatedAt` first. `limit` omitted: all. */
  forProject(project: string, limit?: number): Artifact[];
  get(id: number): ArtifactDetail | null;
  /** The stored HTML of a version, before the bridge is injected. */
  html(id: number, version: number): string | null;
  /** New artifact, or a new version of one in the same session. Emits artifact.updated. */
  post(sessionId: string, input: { title: string; html: string; note?: string; artifactId?: number }): { artifact: Artifact; version: number };
  /** The tools Odin serves to a session it runs (post_artifact). Sessions passes them at start/resume. */
  hostTools(sessionId: string): HostTool[];
  /** Validates (≤ 64 KB JSON, version exists) and sends it into the session as a user message. */
  submit(id: number, req: ArtifactSubmitRequest): Promise<Session>;
}

// ── library (wave 2f: src/library) ─────────────────────────────────────────

export interface LibraryService extends Closeable {
  /** <ODIN_HOME>/library */
  readonly root: string;
  list(kind?: AssetKind): LibraryAsset[];
  get(kind: AssetKind, id: string): LibraryAsset | null;
  detail(kind: AssetKind, id: string): AssetDetail | null;
  /** Files of the current version, or of a recorded version. */
  files(kind: AssetKind, id: string, version?: string): AssetFiles | null;
  /** Writes the files (replacing the asset's directory/file), records the version. Emits library.updated. */
  save(kind: AssetKind, id: string, files: AssetFiles): LibraryAsset;
  remove(kind: AssetKind, id: string): void;
  /** Switches an asset on or off (stored in the database). 404 for an unknown asset. Emits library.updated. */
  setEnabled(kind: AssetKind, id: string, enabled: boolean): LibraryAsset;
  /** Re-reads the library directory (it's plain files; users may edit them outside Odin). */
  rescan(): void;
  /** Reads a Claude Code plugin from a git address or a local folder and says what importing it would add. Writes nothing. */
  importPreview(req: ImportRequest): Promise<ImportPreview>;
  /** Writes the plugin a preview described into the library (own members, nothing split out). Previews last 10 minutes. */
  importConfirm(previewId: string): LibraryAsset;
  /** Writes a plugin, with its included assets resolved, as a Claude Code plugin folder at `path` (absent or empty). */
  exportPlugin(id: string, path: string): ExportResult;
  /** Installed assets in a project with their drift state (recomputed from disk). */
  installations(project: string): Installation[];
  install(project: string, req: InstallRequest): Promise<InstallResult>;
  /** The asset's files as they are in the project now (for drift diffs), or null when missing. */
  projectFiles(project: string, kind: AssetKind, id: string): AssetFiles | null;
}

// ── GitHub sync (kept from v1; wave 2j: src/sync) ──────────────────────────

export interface PullInfo {
  number: number;
  url: string;
  headBranch: string;
  state: "open" | "closed";
  merged: boolean;
  reviewRounds: number;
  files: string[];
  closes: number[];
}

export interface SyncService extends Closeable {
  status(project: string): SyncStatus;
    /** Read PRs when the project explicitly enables GitHub; concurrent calls share one run. No remote writes. */
  syncNow(project: string): Promise<void>;
  pullForBranch(project: string, branch: string): PullInfo | null;
  /** A pull request was stored or changed. Session ↔ PR links and outcomes hang off this. */
  onPull(listener: (project: string, pull: PullInfo) => void): () => void;
}

// ── ingest + metrics + settings (wave 1c: src/ingest, src/metrics, src/settings) ──

export interface IngestService {
  /** Validates and applies a batch exactly as POST /api/ingest does (external sessions, via the hook adapter). */
  ingest(events: unknown[]): IngestResponse;
  /** Odin-run sessions: record usage / turn / tool facts from a live harness event and recompute metrics. */
  recordHarnessEvent(sessionId: string, event: HarnessEvent): void;
  /** Replace harness facts for an unattached external session with its authoritative native history. */
  replaceHistory(sessionId: string, facts: import("./harness/types.ts").HarnessMeasurement[]): void;
  /**
   * A fork's harness reports usage cumulatively *including* the history it copied. Records the parent's per-model
   * totals at fork time as the fork's baseline, so the fork's metrics count only its own usage.
   */
  recordBaseline(sessionId: string, parentId: string): void;
}

export interface MetricsService extends Closeable {
  /** Groups sessions per docs/contracts.md#metrics. */
  query(q: MetricsQuery): MetricsRow[];
  /**
   * Per local calendar day (the server's time zone), the last `days` days ending today, oldest first, no gaps:
   * sessions with any activity (working project or in projects[]), active time, cost, session diff lines and git
   * commits (read-only `git log --branches`, cached briefly). `days` is 1..168.
   */
  activity(project: string, days: number): Promise<ProjectActivity>;
  /** The `sessions` column of `activity` without git: for `ProjectSummary.activity`. Same `days` bounds. */
  sessionsPerDay(project: string, days: number): number[];
  /** Recomputes diff/commits for a session's branch or worktree (git, read-only). Called when a turn ends. */
  refreshOutput(sessionId: string): Promise<void>;
}

export interface SecretsService {
  /** Secrets (no values) and the names library MCP specs need that are not set. */
  list(): import("@odin/shared/api").SecretsResponse;
  /** Creates or replaces. 400 on a bad name or value. The value is never returned, logged or put in an event. */
  put(name: string, value: string): import("@odin/shared/api").SecretInfo;
  /** 404 unknown name. Specs that refer to it fail at launch until it is set again. */
  remove(name: string): void;
  /** Fills each `${secret:NAME}` in `text`. 400 naming `what` and the missing secret; never names a value. */
  fill(text: string, what: string): string;
}

export interface McpOAuthService {
  /** 404 unknown server, 400 when it is not a remote server with `oauth`. */
  status(id: string): import("@odin/shared/api").McpOAuthStatus;
  /** Discovers, registers a client when needed, and returns the URL to open. `origin` must be this Odin's own address. */
  start(id: string, origin: string): Promise<import("@odin/shared/api").StartMcpOAuthResponse>;
  /** The authorization server's redirect: exchanges the code and stores the tokens. 400 for an unknown or expired state. */
  complete(params: { state?: string; code?: string; error?: string }): Promise<{ id: string }>;
  /** Forgets the grant (does not revoke it at the server). */
  disconnect(id: string): void;
  /** A usable access token for launch, refreshed when it is about to end. 400 when the server needs sign-in. */
  accessToken(id: string): Promise<string>;
}

export interface SettingsService {
  get(): AppSettings;
  update(patch: Partial<AppSettings>): AppSettings;
  /** pricing.json merged over DEFAULT_PRICING; re-read when the file's mtime changes. */
  pricing(): Record<string, ModelPrice>;
  savePricing(pricing: Record<string, ModelPrice>): void;
}

// ── wiring ─────────────────────────────────────────────────────────────────

export interface Services {
  notebooks: NotebooksService;
  files: FilesService;
  projects: ProjectsService;
  sessions: SessionsService;
  launch: LaunchService;
  artifacts: ArtifactsService;
  library: LibraryService;
  sync: SyncService;
  ingest: IngestService;
  metrics: MetricsService;
  settings: SettingsService;
  secrets: SecretsService;
  mcpOAuth: McpOAuthService;
}

export type ServiceName = keyof Services;
export const SERVICE_NAMES: ServiceName[] = ["notebooks", "files", "projects", "sessions", "launch", "artifacts", "library", "sync", "ingest", "metrics", "settings", "secrets", "mcpOAuth"];

export interface NotebooksService extends Closeable {
  widgetState(kernelId: string): import("@odin/shared/notebooks").NotebookComm[];
  sendComm(kernelId: string, message: import("@odin/shared/notebooks").NotebookComm): Promise<void>;
  variables(kernelId: string): Promise<import("@odin/shared/notebooks").NotebookVariable[]>;
  dataframe(kernelId: string, name: string, query: import("@odin/shared/notebooks").DataFrameQuery): Promise<import("@odin/shared/notebooks").NotebookDataFrame>;
  list(project: string): import("@odin/shared/notebooks").NotebookKernel[];
  /** Returns the existing record for request.path or creates one (writing the file if `create`). Starts no process. */
  open(project: string, request: import("@odin/shared/notebooks").OpenNotebookRequest): Promise<import("@odin/shared/notebooks").NotebookKernel>;
  snapshot(kernelId: string): import("@odin/shared/notebooks").NotebookSnapshot;
  save(kernelId: string, revision: string, cells: import("@odin/shared/notebooks").NotebookCell[]): import("@odin/shared/notebooks").NotebookSnapshot;
  execute(kernelId: string, request: import("@odin/shared/notebooks").ExecuteCellRequest): Promise<import("@odin/shared/notebooks").NotebookExecution>;
  execution(id: string): import("@odin/shared/notebooks").NotebookExecution;
  wait(id: string, timeoutMs?: number): Promise<import("@odin/shared/notebooks").NotebookExecution>;
  interrupt(kernelId: string): Promise<void>;
  stop(kernelId: string): Promise<void>;
  remove(kernelId: string): Promise<void>;
  hostTools(sessionId: string): HostTool[];
  usesPath(path: string): boolean;
}

export interface FilesService {
  list(sessionId: string, path?: string): import("@odin/shared/api").SessionFileListing;
  read(sessionId: string, path: string): import("@odin/shared/api").SessionTextFile;
  save(sessionId: string, path: string, content: string, version: string): import("@odin/shared/api").SessionTextFile;
  /** Create-only: a new regular file in an existing folder of the session. 409 when the path already exists. */
  create(sessionId: string, path: string, content?: string): import("@odin/shared/api").SessionTextFile;
  /** Fuzzy `@` file-reference search in the session's working directory. */
  search(sessionId: string, query: string): import("@odin/shared/api").FileSearchResult;
  /** The same search in a registered project's folder (composing a new session). */
  searchProject(project: string, query: string): import("@odin/shared/api").FileSearchResult;
  /** Every tracked or unignored file in a project with its size and working-tree diff against HEAD. */
  projectMap(project: string): import("@odin/shared/api").ProjectFileMap;
  /** Read-only: a text file in a registered project's folder, with the session viewer's confinement and limits. */
  readProject(project: string, path: string): import("@odin/shared/api").SessionTextFile;
}

/** Each module's routes: `register(router, deps, services)`. */
export type RegisterRoutes = (router: Router, deps: Deps, services: Services) => void;
