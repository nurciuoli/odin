// One conversation with the default agent; settings are independent of the user message.
import type {
  AppSettings,
  LaunchWhere,
  PermissionMode,
  StartSessionRequest,
} from '@odin/shared/api'

/** An existing place picked in the composer: a worktree by path, or an existing branch (checked out in a new worktree). */
export type ExistingWhere = Extract<LaunchWhere, { kind: 'worktree' | 'branch' }>

export interface SessionForm {
  runtimeOptions?: import('@odin/shared/api').RuntimeOptions
  harness?: string
  project: string
  projects: string[]
  prompt: string
  /** '' = leave it to the default */
  effort?: import('@odin/shared/api').Effort | null
  model: string
  permissionMode: PermissionMode
  worktree: boolean
  branch: string
  /** An existing worktree or branch; wins over `worktree`/`branch` (the new-worktree choice). */
  existing?: ExistingWhere | null
}

export type SessionFormErrors = Partial<
  Record<'project' | 'prompt' | 'branch' | 'variables', string>
>

const BRANCH_PATTERN = /^[\w][\w./-]*$/

export function emptySessionForm(project = '', settings?: AppSettings | null): SessionForm {
  const savedHarness = settings?.defaultHarness ?? 'claude'
  const harness = savedHarness === 'codex-wsl' ? 'codex' : savedHarness
  const family = harness
  const defaults = settings?.harnessDefaults?.[harness] ?? settings?.harnessDefaults?.[family]
  return {
    harness,
    project,
    projects: project ? [project] : [],
    prompt: '',
    model: defaults?.model ?? (family === 'claude' ? settings?.defaultModel : '') ?? '',
    permissionMode:
      defaults?.permissionMode ??
      (family === 'claude' ? settings?.defaultPermissionMode : 'default') ??
      'default',
    worktree: worktreeDefault(undefined, settings),
    branch: '',
  }
}

/** Why a typed branch name is not a valid Git branch, or undefined when it is fine (empty means "choose for me"). */
export function branchProblem(name: string): string | undefined {
  const branch = name.trim()
  if (!branch) return undefined
  const bad =
    !BRANCH_PATTERN.test(branch) ||
    branch.includes('..') ||
    branch.includes('//') ||
    branch.endsWith('/') ||
    branch.endsWith('.') ||
    branch.endsWith('.lock') ||
    branch.split('/').some(p => p.startsWith('.'))
  return bad ? 'Use a valid Git branch name.' : undefined
}

const STOP_WORDS = new Set(
  'a an the and or but to of in on at for with from by is are was were be been it its this that these those please can could would should you your my our we i me do does did how why what when where which who into about as so if then just also need want let lets make'.split(
    ' ',
  ),
)

/** A Git-valid branch slug from the first few meaningful words of a message: lowercase, hyphenated, at most 40 chars. */
export function slugFromPrompt(text: string, maxLength = 40, maxWords = 4): string {
  const words = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  const meaningful = words.filter(w => !STOP_WORDS.has(w))
  const chosen = (meaningful.length ? meaningful : words).slice(0, maxWords)
  let slug = ''
  for (const word of chosen) {
    const next = slug ? `${slug}-${word}` : word
    if (next.length > maxLength) {
      if (!slug) slug = word.slice(0, maxLength)
      break
    }
    slug = next
  }
  return slug.replace(/^-+|-+$/g, '')
}

/**
 * Whether a new composer starts in a new worktree: the project's own default, else the global setting.
 */
export function worktreeDefault(
  project: { defaultWorktree?: boolean } | null | undefined,
  settings: AppSettings | null | undefined,
): boolean {
  return project?.defaultWorktree ?? settings?.defaultWorktree ?? false
}

/** Prefixes like `feat/` from the most recently committed branches, newest first, at most `limit`. */
export function recentBranchPrefixes(
  branches: { name: string; lastCommitAt: string | null }[],
  limit = 2,
): string[] {
  const prefixes: string[] = []
  const sorted = [...branches].sort((a, b) =>
    (b.lastCommitAt ?? '').localeCompare(a.lastCommitAt ?? ''),
  )
  for (const { name } of sorted) {
    const slash = name.indexOf('/')
    if (slash <= 0) continue
    const prefix = name.slice(0, slash + 1)
    if (!prefixes.includes(prefix)) prefixes.push(prefix)
    if (prefixes.length >= limit) break
  }
  return prefixes
}

export function validateSessionForm(form: SessionForm): SessionFormErrors {
  const errors: SessionFormErrors = {}
  if (!form.project) errors.project = 'Pick a project.'
  if (!form.prompt.trim()) errors.prompt = 'Write a message to start a session.'
  if (form.worktree && !form.existing) {
    const branch = branchProblem(form.branch)
    if (branch) errors.branch = branch
  }
  return errors
}

/** What the form says about where the session runs, as the API's `where`. */
export function whereOf(form: SessionForm): LaunchWhere {
  if (form.existing) return form.existing
  if (!form.worktree) return { kind: 'checkout' }
  const branch = form.branch.trim()
  return branch ? { kind: 'new-worktree', branch } : { kind: 'new-worktree' }
}

export function buildStartRequest(form: SessionForm): StartSessionRequest {
  const req: StartSessionRequest = {
    project: form.project,
    projects: [...new Set([form.project, ...form.projects])],
    prompt: { text: form.prompt.trim() },
    permissionMode: form.permissionMode,
    where: whereOf(form),
  }
  if (form.effort) req.effort = form.effort
  if (form.runtimeOptions) req.runtimeOptions = form.runtimeOptions
  if (form.harness) req.harness = form.harness
  if (form.model && form.model !== 'default') req.model = form.model
  return req
}
