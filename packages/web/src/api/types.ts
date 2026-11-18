// The web app's view of the API. `http.ts` implements it against core; `mock.ts` against in-memory fixtures
// (`?mock` in the URL, or VITE_MOCK=1). Screens only ever use this interface, through useApi().
// One method per REST route in docs/contracts.md#rest, same names and shapes.
import type {
  Artifact,
  ArtifactDetail,
  AssetDetail,
  AssetFiles,
  AssetKind,
  ClaudeCodeTrackingStatus,
  CreateProjectRequest,
  FileSearchResult,
  ProjectFileMap,
  ForkSessionRequest,
  Installation,
  InstallRequest,
  InstallResult,
  LibraryAsset,
  McpOAuthStatus,
  MetricsQuery,
  MetricsRow,
  MessageQueue,
  ModelInfo,
  PermissionAnswer,
  ProjectActivity,
  ProjectBranch,
  ProjectDetail,
  ProjectFolders,
  SecretInfo,
  SecretsResponse,
  StartMcpOAuthResponse,
  ProjectSummary,
  Session,
  SessionDetail,
  SessionFileListing,
  SessionFilter,
  SessionTextFile,
  ShellRunResult,
  ReadinessResponse,
  SettingsResponse,
  StartSessionRequest,
  UpdateProjectSourcesRequest,
  UpdateProjectSettingsRequest,
  UpdateSessionRequest,
  UpdateSettingsRequest,
  UserMessage,
} from '@odin/shared/api'
import type { ServerEvent } from '@odin/shared/events'
import type { TaskHistory } from '@odin/shared/harness'

export interface Api {
  notebookWidgetState(kernelId: string): Promise<import('@odin/shared/notebooks').NotebookComm[]>
  sendNotebookComm(
    kernelId: string,
    message: import('@odin/shared/notebooks').NotebookComm,
  ): Promise<void>
  notebookVariables(kernelId: string): Promise<import('@odin/shared/notebooks').NotebookVariable[]>
  notebookDataFrame(
    kernelId: string,
    name: string,
    query: import('@odin/shared/notebooks').DataFrameQuery,
  ): Promise<import('@odin/shared/notebooks').NotebookDataFrame>
  notebookEnvironment(
    project: string,
    location?: import('@odin/shared/notebooks').KernelLocation,
  ): Promise<import('@odin/shared/notebooks').NotebookEnvironment>
  setupNotebookEnvironment(
    project: string,
    location?: import('@odin/shared/notebooks').KernelLocation,
  ): Promise<import('@odin/shared/notebooks').NotebookEnvironment>
  listNotebooks(project: string): Promise<import('@odin/shared/notebooks').NotebookKernel[]>
  openNotebook(
    project: string,
    request: import('@odin/shared/notebooks').OpenNotebookRequest,
  ): Promise<import('@odin/shared/notebooks').NotebookKernel>
  getNotebook(kernelId: string): Promise<import('@odin/shared/notebooks').NotebookSnapshot>
  saveNotebook(
    kernelId: string,
    revision: string,
    cells: import('@odin/shared/notebooks').NotebookCell[],
  ): Promise<import('@odin/shared/notebooks').NotebookSnapshot>
  executeNotebook(
    kernelId: string,
    request: import('@odin/shared/notebooks').ExecuteCellRequest,
  ): Promise<import('@odin/shared/notebooks').NotebookExecution>
  notebookExecution(id: string): Promise<import('@odin/shared/notebooks').NotebookExecution>
  interruptNotebook(kernelId: string): Promise<void>
  stopNotebook(kernelId: string): Promise<void>
  removeNotebook(kernelId: string): Promise<void>
  notebookOutputUrl(kernelId: string, cellId: string, index: number): string
  getNativeCatalog(
    harness: string,
    project: string,
  ): Promise<import('@odin/shared/api').NativeCatalog>
  getSessionNativeState(id: string): Promise<import('@odin/shared/api').NativeSessionState>
  sessionNativeAction(
    id: string,
    action: import('@odin/shared/api').NativeSessionAction,
  ): Promise<import('@odin/shared/api').NativeSessionState>
  // projects
  listProjects(): Promise<ProjectSummary[]>
  browseProjectFolders(path?: string): Promise<ProjectFolders>
  getProject(name: string): Promise<ProjectDetail>
  createProject(req: CreateProjectRequest): Promise<ProjectDetail>
  updateProjectSettings(name: string, req: UpdateProjectSettingsRequest): Promise<ProjectDetail>
  /** `null` clears a saved source selection and returns to discovery. */
  updateProjectSources(name: string, req: UpdateProjectSourcesRequest): Promise<ProjectDetail>
  refreshProject(name: string): Promise<void>
  removeProject(name: string): Promise<void>
  /** Import sessions the harness has for this project that Odin hasn't seen (terminal sessions). */
  discoverSessions(name: string): Promise<{ added: number }>
  getClaudeCodeTracking(name: string): Promise<ClaudeCodeTrackingStatus>
  setClaudeCodeTracking(name: string, enabled: boolean): Promise<ClaudeCodeTrackingStatus>
  /** Per local calendar day (the server's time zone), oldest first, no gaps. `days` defaults to 84, at most 168. */
  getProjectActivity(project: string, days?: number): Promise<ProjectActivity>
  listProjectBranches(project: string): Promise<ProjectBranch[]>
  /** Removes a worktree Odin created (the branch stays). 409 when a live session uses it or it is dirty. */
  removeWorktree(project: string, path: string): Promise<void>

  // sessions
  listSessions(filter?: SessionFilter): Promise<Session[]>
  getSession(id: string): Promise<SessionDetail>
  getSessionTask(id: string, taskKey: string): Promise<TaskHistory>
  listSessionFiles(id: string, path?: string): Promise<SessionFileListing>
  /** `@` file references: fuzzy matches in the session's working directory. */
  searchSessionFiles(id: string, query: string): Promise<FileSearchResult>
  /** `@` file references while composing a new session in a project. */
  searchProjectFiles(project: string, query: string): Promise<FileSearchResult>
  /** The Files tab's data: every file with its size and uncommitted diff. */
  getProjectFileMap(project: string): Promise<ProjectFileMap>
  /** A text file in the project folder (read-only; 413/415 for large or binary files). */
  readProjectFile(project: string, path: string): Promise<SessionTextFile>
  readSessionFile(id: string, path: string): Promise<SessionTextFile>
  /** Create-only: a new file in an existing folder of the session. 409 when the path exists. */
  createSessionFile(id: string, path: string, content?: string): Promise<SessionTextFile>
  saveSessionFile(
    id: string,
    path: string,
    content: string,
    version: string,
  ): Promise<SessionTextFile>
  startSession(req: StartSessionRequest): Promise<Session>
  updateSession(id: string, req: UpdateSessionRequest): Promise<Session>
  deleteSession(id: string): Promise<void>
  sendMessage(id: string, message: UserMessage): Promise<Session>
  /** The composer's `!` mode: runs a command in the session's working directory (any harness). */
  runShell(id: string, command: string): Promise<ShellRunResult>
  queue(id: string): Promise<MessageQueue>
  editQueuedMessage(id: string, messageId: string, message: UserMessage): Promise<MessageQueue>
  cancelQueuedMessage(id: string, messageId: string): Promise<MessageQueue>
  resumeQueue(id: string): Promise<MessageQueue>
  /** Interrupt the current turn and send the next queued message. A message is placed ahead of the queue. */
  sendNow(id: string, message?: UserMessage): Promise<MessageQueue>
  retryQueuedMessage(id: string, messageId: string): Promise<MessageQueue>
  answerPermission(id: string, requestId: string, answer: PermissionAnswer): Promise<void>
  interruptSession(id: string): Promise<void>
  endSession(id: string): Promise<Session>
  forkSession(id: string, req: ForkSessionRequest): Promise<Session>
  listModels(harness?: string): Promise<ModelInfo[]>

  // artifacts
  getArtifact(id: number): Promise<ArtifactDetail>
  /** A project's artifacts, newest first. */
  listProjectArtifacts(project: string, limit?: number): Promise<Artifact[]>
  /** What an artifact sent through `odin.submit`, delivered into its session. */
  submitArtifact(id: number, version: number, data: unknown): Promise<Session>
  /** URL of a sandboxed artifact page, for an iframe src. */
  artifactUrl(id: number, version: number): string

  // library
  listLibrary(kind?: AssetKind): Promise<LibraryAsset[]>
  getAsset(kind: AssetKind, id: string): Promise<AssetDetail>
  getAssetVersion(kind: AssetKind, id: string, version: string): Promise<AssetFiles>
  saveAsset(kind: AssetKind, id: string, files: AssetFiles): Promise<LibraryAsset>
  deleteAsset(kind: AssetKind, id: string): Promise<void>
  rescanLibrary(): Promise<void>
  listInstallations(project: string): Promise<Installation[]>
  install(project: string, req: InstallRequest): Promise<InstallResult>
  /** The asset's files as they are in the project now (drift diff), or 404. */
  getProjectAssetFiles(project: string, kind: AssetKind, id: string): Promise<AssetFiles>

  // secrets and MCP sign-in
  listSecrets(): Promise<SecretsResponse>
  /** Creates or replaces. The value is never returned. */
  putSecret(name: string, value: string): Promise<SecretInfo>
  deleteSecret(name: string): Promise<void>
  getMcpOAuth(id: string): Promise<McpOAuthStatus>
  /** `origin` is this page's own origin; the sign-in returns to it. */
  startMcpOAuth(id: string, origin: string): Promise<StartMcpOAuthResponse>
  disconnectMcpOAuth(id: string): Promise<void>

  // sync
  syncProject(name: string): Promise<void>

  // metrics and settings
  getMetrics(query: MetricsQuery): Promise<MetricsRow[]>
  getSettings(): Promise<SettingsResponse>
  updateSettings(req: UpdateSettingsRequest): Promise<SettingsResponse>
  /** What this machine still needs (first run). */
  getReadiness(): Promise<ReadinessResponse>

  /** Server events. Reconnects on its own; calls `onReconnect` so callers can refetch. */
  subscribe(listener: (event: ServerEvent) => void, onReconnect?: () => void): () => void
}

export class ApiRequestError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}
