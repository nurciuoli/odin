// The real Api: plain fetch against the REST table in docs/contracts.md. JSON in, JSON out; any non-2xx becomes
// an ApiRequestError carrying the server's `error` text.
import type { ApiError } from '@odin/shared/api'
import type { ServerEvent } from '@odin/shared/events'
import { connectEvents, type EventStreamOptions } from './sse'
import { ApiRequestError, type Api } from './types'

export interface HttpApiOptions {
  fetch?: typeof fetch
  baseUrl?: string
  events?: EventStreamOptions
}

export function createHttpApi(options: HttpApiOptions = {}): Api {
  const base = options.baseUrl ?? ''
  const events = sharedEvents(`${base}/api/events`, options.events)
  const doFetch =
    options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args))

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers:
          body === undefined
            ? { accept: 'application/json' }
            : { accept: 'application/json', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch {
      throw new ApiRequestError(0, "Can't reach Odin. Is the server running?")
    }
    if (!res.ok) {
      let message = res.statusText || `Request failed (${res.status})`
      try {
        const parsed = (await res.json()) as Partial<ApiError>
        if (typeof parsed.error === 'string' && parsed.error) message = parsed.error
      } catch {
        // not JSON: keep the status text
      }
      throw new ApiRequestError(res.status, message)
    }
    if (res.status === 204) return undefined as T
    const text = await res.text()
    return (text ? JSON.parse(text) : undefined) as T
  }

  const get = <T>(path: string) => request<T>('GET', path)
  const send = <T>(method: string, path: string, body?: unknown) => request<T>(method, path, body)
  const seg = encodeURIComponent
  const query = (params: Record<string, string | undefined>) => {
    const entries = Object.entries(params).filter((e): e is [string, string] => !!e[1])
    return entries.length ? `?${new URLSearchParams(entries)}` : ''
  }
  const project = (name: string) => `/api/projects/${seg(name)}`

  const session = (id: string) => `/api/sessions/${seg(id)}`
  const asset = (kind: string, id: string) => `/api/library/${seg(kind)}/${seg(id)}`
  const flag = (v: boolean | undefined) => (v === undefined ? undefined : String(v))

  return {
    notebookWidgetState: id => get(`/api/notebooks/${seg(id)}/widgets`),
    sendNotebookComm: (id, message) => send('POST', `/api/notebooks/${seg(id)}/comm`, message),
    notebookVariables: id => send('POST', `/api/notebooks/${seg(id)}/variables`, {}),
    notebookDataFrame: (id, name, query) =>
      send('POST', `/api/notebooks/${seg(id)}/dataframe`, { name, ...query }),
    notebookEnvironment: (name, location) =>
      send('POST', `${project(name)}/notebook-environment/detect`, { location }),
    setupNotebookEnvironment: (name, location) =>
      send('POST', `${project(name)}/notebook-environment/setup`, { location }),
    listNotebooks: name => get(`${project(name)}/notebooks`),
    openNotebook: (name, req) => send('POST', `${project(name)}/notebooks/open`, req),
    getNotebook: id => get(`/api/notebooks/${seg(id)}`),
    saveNotebook: (id, revision, cells) =>
      send('PUT', `/api/notebooks/${seg(id)}`, { revision, cells }),
    sessionNotebooks: id => get(`${session(id)}/notebooks`),
    attachNotebook: (id, kernelId) =>
      send('POST', `${session(id)}/notebooks/${seg(kernelId)}/attach`),
    executeNotebook: (id, req) => send('POST', `/api/notebooks/${seg(id)}/execute`, req),
    notebookExecution: id => get(`/api/notebook-executions/${seg(id)}`),
    interruptNotebook: id => send('POST', `/api/notebooks/${seg(id)}/interrupt`),
    stopNotebook: id => send('POST', `/api/notebooks/${seg(id)}/stop`),
    removeNotebook: id => send('DELETE', `/api/notebooks/${seg(id)}`),
    notebookOutputUrl: (id, cellId, index) =>
      `${base}/a/notebooks/${seg(id)}/${seg(cellId)}/${index}`,
    listProjects: () => get('/api/projects'),
    browseProjectFolders: path => send('POST', '/api/project-folders', { path }),
    getProject: name => get(project(name)),
    createProject: req => send('POST', '/api/projects', req),
    updateProjectSettings: (name, req) => send('PATCH', `${project(name)}/settings`, req),
    updateProjectSources: (name, req) => send('PATCH', `${project(name)}/sources`, req),
    refreshProject: name => send('POST', `${project(name)}/refresh`),
    removeProject: name => send('DELETE', project(name)),
    discoverSessions: name => send('POST', `${project(name)}/discover`),
    setClaudeCodeTracking: (name, enabled) =>
      send('POST', `${project(name)}/tracking/claude-code`, { enabled }),
    getClaudeCodeTracking: name => get(`${project(name)}/tracking/claude-code`),

    listSessions: (f = {}) =>
      get(
        `/api/sessions${query({
          project: f.project,
          state: f.state?.join(','),
          tag: f.tag,
          model: f.model,
          origin: f.origin,
          q: f.q,
          archived: flag(f.archived),
          pinned: flag(f.pinned),
          aside: flag(f.aside),
          parentId: f.parentId,
          since: f.since,
          limit: f.limit === undefined ? undefined : String(f.limit),
        })}`,
      ),
    getSession: id => get(session(id)),
    getSessionTask: (id, key) => get(`${session(id)}/tasks/${seg(key)}`),
    listSessionFiles: (id, path) => get(`${session(id)}/files${query({ path })}`),
    searchSessionFiles: (id, q) => get(`${session(id)}/files/search${query({ q })}`),
    readProjectFile: (name, path) => get(`${project(name)}/file${query({ path })}`),
    getProjectFileMap: name => get(`${project(name)}/files/map`),
    searchProjectFiles: (name, q) => get(`${project(name)}/files/search${query({ q })}`),
    readSessionFile: (id, path) => get(`${session(id)}/file${query({ path })}`),
    createSessionFile: (id, path, content) =>
      send('POST', `${session(id)}/files`, { path, content: content ?? '' }),
    saveSessionFile: (id, path, content, version) =>
      send('PUT', `${session(id)}/file`, { path, content, version }),
    startSession: req => send('POST', '/api/sessions', req),
    updateSession: (id, req) => send('PATCH', session(id), req),
    deleteSession: id => send('DELETE', session(id)),
    sendMessage: (id, message) => send('POST', `${session(id)}/messages`, message),
    queue: id => get(`${session(id)}/queue`),
    editQueuedMessage: (id, messageId, message) =>
      send('PATCH', `${session(id)}/queue/${seg(messageId)}`, message),
    cancelQueuedMessage: (id, messageId) =>
      send('DELETE', `${session(id)}/queue/${seg(messageId)}`),
    resumeQueue: id => send('POST', `${session(id)}/queue/resume`),
    sendNow: (id, message) => send('POST', `${session(id)}/queue/send-now`, message ?? {}),
    retryQueuedMessage: (id, messageId) =>
      send('POST', `${session(id)}/queue/${seg(messageId)}/retry`),
    answerPermission: (id, requestId, answer) =>
      send('POST', `${session(id)}/permissions/${seg(requestId)}`, answer),
    interruptSession: id => send('POST', `${session(id)}/interrupt`),
    endSession: id => send('POST', `${session(id)}/end`),
    forkSession: (id, req) => send('POST', `${session(id)}/fork`, req),
    listModels: harness => get(`/api/models${query({ harness })}`),
    getNativeCatalog: (harness, project) =>
      get(`/api/harnesses/${seg(harness)}/native${query({ project })}`),
    getSessionNativeState: id => get(`${session(id)}/native`),
    sessionNativeAction: (id, action) => send('POST', `${session(id)}/native`, action),

    getArtifact: id => get(`/api/artifacts/${id}`),
    submitArtifact: (id, version, data) =>
      send('POST', `/api/artifacts/${id}/submit`, { version, data }),
    artifactUrl: (id, version) => `${base}/a/${id}/${version}`,

    listLibrary: kind => get(`/api/library${query({ kind })}`),
    getAsset: (kind, id) => get(asset(kind, id)),
    getAssetVersion: (kind, id, version) => get(`${asset(kind, id)}/versions/${seg(version)}`),
    saveAsset: (kind, id, files) => send('PUT', asset(kind, id), { files }),
    deleteAsset: (kind, id) => send('DELETE', asset(kind, id)),
    rescanLibrary: () => send('POST', '/api/library/rescan'),
    listInstallations: name => get(`${project(name)}/library`),
    install: (name, req) => send('POST', `${project(name)}/library`, req),
    getProjectAssetFiles: (name, kind, id) =>
      get(`${project(name)}/library/${seg(kind)}/${seg(id)}/files`),

    syncProject: name => send('POST', `${project(name)}/sync`),

    getProjectActivity: (name, days) =>
      get(
        `${project(name)}/activity${query({ days: days === undefined ? undefined : String(days) })}`,
      ),
    listProjectBranches: name => get(`${project(name)}/branches`),
    removeWorktree: (name, path) => send('DELETE', `${project(name)}/worktrees`, { path }),
    listProjectArtifacts: (name, limit) =>
      get(
        `${project(name)}/artifacts${query({ limit: limit === undefined ? undefined : String(limit) })}`,
      ),

    getMetrics: q =>
      get(
        `/api/metrics${query({ groupBy: q.groupBy.join(','), project: q.project, since: q.since })}`,
      ),
    getSettings: () => get('/api/settings'),
    updateSettings: req => send('PATCH', '/api/settings', req),
    getReadiness: () => get('/api/readiness'),

    subscribe: (listener, onReconnect) => events.subscribe(listener, onReconnect),
  }
}

/**
 * One EventSource for the whole app, however many screens subscribe: opened by the first subscriber, closed after
 * the last one leaves. Browsers cap connections per origin, so a stream per screen would starve real requests.
 */
export function sharedEvents(url: string, options: EventStreamOptions = {}) {
  const listeners = new Set<(event: ServerEvent) => void>()
  const reconnects = new Set<() => void>()
  let close: (() => void) | null = null
  return {
    subscribe(listener: (event: ServerEvent) => void, onReconnect?: () => void): () => void {
      listeners.add(listener)
      if (onReconnect) reconnects.add(onReconnect)
      close ??= connectEvents(
        e => listeners.forEach(l => l(e)),
        () => reconnects.forEach(r => r()),
        { url, ...options },
      )
      return () => {
        listeners.delete(listener)
        if (onReconnect) reconnects.delete(onReconnect)
        if (listeners.size === 0 && close) {
          close()
          close = null
        }
      }
    },
  }
}
