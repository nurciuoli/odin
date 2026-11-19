// Git state for one checkout (a session's worktree or a project's folder): the status, kept fresh from `git.changed`
// and the session's own activity, plus `run()` for writes that turns git's typed refusals into something to show.
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch, type Ref } from 'vue'
import type { GitStatus, GitTarget } from '@odin/shared/git'
import { ApiRequestError, useApi } from '@/api'
import { useToast } from '@/components/Toast'

export interface GitFailure {
  code: string | null
  message: string
}

export function sameTarget(a: GitTarget, b: GitTarget): boolean {
  return a.kind === b.kind && a.id === b.id
}

export function useGitStatus(target: Ref<GitTarget | null>) {
  const api = useApi()
  const { toast } = useToast()
  const status = shallowRef<GitStatus | null>(null)
  const loading = ref(false)
  const busy = ref<string | null>(null)
  let latest = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  async function load() {
    const t = target.value
    if (!t) return
    const id = ++latest
    loading.value = true
    try {
      const next = await api.gitStatus(t)
      if (id === latest) status.value = next
    } catch {
      // keep what we had; the panel shows its own empty state
    } finally {
      if (id === latest) loading.value = false
    }
  }
  /** Coalesces bursts (a turn editing many files) into one refetch. */
  function soon() {
    clearTimeout(timer)
    timer = setTimeout(() => void load(), 250)
  }

  /** Runs a write. A failure is toasted unless `quiet` lists its code. */
  async function run<T>(
    label: string,
    fn: (t: GitTarget) => Promise<T>,
    opts: { quiet?: string[] } = {},
  ): Promise<RunResult<T>> {
    const t = target.value
    if (!t) return { ok: false, failure: { code: null, message: 'No checkout' } }
    busy.value = label
    try {
      const out = await fn(t)
      const s = (out as { status?: GitStatus } | null)?.status ?? out
      if (s && typeof s === 'object' && 'staged' in s && 'unstaged' in s)
        status.value = s as GitStatus
      else void load()
      return { ok: true, value: out }
    } catch (e) {
      const failure: GitFailure = {
        code: e instanceof ApiRequestError ? (e.code ?? null) : null,
        message: e instanceof Error ? e.message : String(e),
      }
      if (!failure.code || !opts.quiet?.includes(failure.code))
        toast({ title: `${label} failed`, description: failure.message, intent: 'danger' })
      void load()
      return { ok: false, failure }
    } finally {
      busy.value = null
    }
  }

  let off: (() => void) | null = null
  onMounted(() => {
    void load()
    off = api.subscribe(
      e => {
        const t = target.value
        if (!t) return
        if (e.type === 'git.changed' && sameTarget(e.target, t)) soon()
        // The agent edits files outside the git routes: refetch when its turns end.
        else if (t.kind === 'session' && e.type === 'checkpoint.updated' && e.sessionId === t.id)
          soon()
        else if (t.kind === 'session' && e.type === 'session.updated' && e.session.id === t.id)
          soon()
      },
      () => void load(),
    )
    window.addEventListener('focus', soon)
  })
  onBeforeUnmount(() => {
    off?.()
    clearTimeout(timer)
    window.removeEventListener('focus', soon)
  })
  watch(
    () => target.value && `${target.value.kind}:${target.value.id}`,
    () => {
      status.value = null
      void load()
    },
  )

  const changedCount = computed(() => {
    const s = status.value
    if (!s) return 0
    return new Set([...s.staged, ...s.unstaged].map(c => c.path)).size
  })

  return { status, loading, busy, load, run, changedCount }
}

export type RunResult<T> = { ok: true; value: T } | { ok: false; failure: GitFailure }

/** "packages/web/src/a.vue" → ["a.vue", "packages/web/src"] */
export function splitPath(path: string): [string, string] {
  const i = path.lastIndexOf('/')
  return i < 0 ? [path, ''] : [path.slice(i + 1), path.slice(0, i)]
}

export const STATE_LETTER: Record<string, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  typechange: 'T',
  untracked: 'U',
  conflicted: '!',
}

export function relativeTime(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.round(h / 24)
  if (d < 14) return `${d}d`
  const w = Math.round(d / 7)
  if (w < 9) return `${w}w`
  return `${Math.round(d / 30)}mo`
}
