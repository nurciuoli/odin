// In-memory git for `?mock`: one fake checkout per session or project, shaped like the Permission prompt work in the
// fixtures. Staging moves whole hunks (the `lines` narrowing is accepted but treated as the whole hunk).
import type { Session } from '@odin/shared/api'
import type { ServerEvent } from '@odin/shared/events'
import type {
  GitAction,
  GitActionRun,
  GitBlame,
  GitBranch,
  GitChange,
  GitCommit,
  GitDiffLine,
  GitFileDiff,
  GitFileState,
  GitHunk,
  GitStash,
  GitStatus,
  GitTarget,
} from '@odin/shared/git'
import { AUTO_STASH_PREFIX } from '@odin/shared/git'
import type { Api } from './types'
import { ApiRequestError } from './types'

type GitApi = Pick<
  Api,
  | 'gitStatus'
  | 'gitDiff'
  | 'gitStage'
  | 'gitUnstage'
  | 'gitDiscard'
  | 'gitCommit'
  | 'gitLog'
  | 'gitShow'
  | 'gitBlame'
  | 'gitBranches'
  | 'gitCheckout'
  | 'gitFetch'
  | 'gitPull'
  | 'gitPush'
  | 'gitStashes'
  | 'gitStash'
  | 'gitStashAction'
  | 'gitActions'
  | 'gitRunAction'
>

interface MockHunk extends GitHunk {
  staged: boolean
}
interface MockFile {
  path: string
  state: GitFileState
  hunks: MockHunk[]
}
interface Checkout {
  branch: string
  upstream: string | null
  ahead: number
  behind: number
  files: MockFile[]
  stashes: (GitStash & { files: MockFile[] })[]
  log: GitCommit[]
  branches: GitBranch[]
  fetchedAt: string
}

type Row = ['c' | 'a' | 'd', string]
let hunkSeq = 0
function hunk(
  oldStart: number,
  newStart: number,
  section: string,
  rows: Row[],
  staged = false,
): MockHunk {
  let o = oldStart
  let n = newStart
  const lines: GitDiffLine[] = rows.map(([k, text]) =>
    k === 'a'
      ? { kind: 'add', text, oldLine: null, newLine: n++ }
      : k === 'd'
        ? { kind: 'del', text, oldLine: o++, newLine: null }
        : { kind: 'context', text, oldLine: o++, newLine: n++ },
  )
  const oldLines = lines.filter(l => l.kind !== 'add').length
  const newLines = lines.filter(l => l.kind !== 'del').length
  return {
    id: `${oldStart},${newStart}:m${++hunkSeq}`,
    header: `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@ ${section}`.trimEnd(),
    oldStart,
    oldLines,
    newStart,
    newLines,
    section,
    lines,
    staged,
  }
}

const PROMPT_VUE: Row[] = [
  ['a', '<script setup lang="ts">'],
  ['a', "import { computed } from 'vue'"],
  ['a', "import { IuButton } from '@/components/Button'"],
  ['a', "import type { PermissionRequest } from '@odin/shared/api'"],
  ['a', ''],
  ['a', 'const props = defineProps<{ request: PermissionRequest }>()'],
  ['a', "const emit = defineEmits<{ answer: [choice: 'once' | 'always' | 'deny'] }>()"],
  ['a', 'const command = computed(() => props.request.input?.command ?? props.request.title)'],
  ['a', '</script>'],
  ['a', ''],
  ['a', '<template>'],
  ['a', '  <section class="permission-prompt" role="alertdialog" :aria-label="request.title">'],
  ['a', '    <code class="permission-prompt__command">{{ command }}</code>'],
  ['a', '    <IuButton size="sm" @click="emit(\'answer\', \'once\')">Allow once</IuButton>'],
  [
    'a',
    '    <IuButton size="sm" variant="ghost" @click="emit(\'answer\', \'always\')">Always</IuButton>',
  ],
  [
    'a',
    '    <IuButton size="sm" variant="ghost" @click="emit(\'answer\', \'deny\')">Deny</IuButton>',
  ],
  ['a', '  </section>'],
  ['a', '</template>'],
]

function sessionFiles(): MockFile[] {
  return [
    {
      path: 'packages/web/src/components/PermissionPrompt/PermissionPrompt.vue',
      state: 'added',
      hunks: [hunk(0, 1, '', PROMPT_VUE, true)],
    },
    {
      path: 'packages/core/src/db/schema.ts',
      state: 'modified',
      hunks: [
        hunk(
          212,
          212,
          'export const SCHEMA = `',
          [
            ['c', '  CREATE INDEX checkpoints_session ON checkpoints(session_id);'],
            ['a', '  CREATE TABLE permission_rules ('],
            ['a', '    project TEXT NOT NULL,'],
            ['a', '    tool TEXT NOT NULL,'],
            ['a', '    pattern TEXT NOT NULL,'],
            ['a', "    decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),"],
            ['a', '    PRIMARY KEY (project, tool, pattern)'],
            ['a', '  );'],
            ['c', '`'],
          ],
          true,
        ),
      ],
    },
    {
      path: 'packages/web/src/screens/session/SessionSide.vue',
      state: 'modified',
      hunks: [
        hunk(41, 41, 'setup()', [
          ['c', '  const open = ref(false)'],
          ['c', "  const width = useStoredWidth('side', 420)"],
          ['a', '  const pending = computed(() =>'],
          ['a', '    props.session.permissions.filter(p => !p.answered),'],
          ['a', '  )'],
          ['c', ''],
          ['d', '  function toggle() {'],
          ['d', '    open.value = !open.value'],
          ['a', '  function toggle(force?: boolean) {'],
          ['a', '    open.value = force ?? !open.value'],
          ['c', '  }'],
        ]),
        hunk(88, 91, 'onMounted', [
          ['c', '  onMounted(load)'],
          ['a', '  watch(pending, list => {'],
          ['a', '    if (list.length) toggle(true)'],
          ['a', '  })'],
          ['a', '  // keep the prompt in view while a request is pending'],
          ['c', ''],
          ['c', '</script>'],
        ]),
      ],
    },
    {
      path: 'packages/core/src/permissions.ts',
      state: 'modified',
      hunks: [
        hunk(18, 18, 'export function decide(', [
          [
            'c',
            '  const rule = rules.find(r => r.tool === request.tool && matches(r.pattern, request))',
          ],
          ['d', '  if (rule) return rule.decision'],
          ['a', '  if (rule) return { decision: rule.decision, remembered: true }'],
          ['a', "  if (answer === 'always') {"],
          [
            'a',
            '    store.save({ project, tool: request.tool, pattern: patternOf(request), decision: "allow" })',
          ],
          ['a', '  }'],
          ['c', '  return ask(request)'],
        ]),
      ],
    },
    {
      path: 'packages/core/src/permissions.test.ts',
      state: 'untracked',
      hunks: [
        hunk(0, 1, '', [
          ['a', "import { it } from 'node:test'"],
          ['a', "import assert from 'node:assert/strict'"],
          ['a', ''],
          ['a', "it('persists allow-always per project', () => {"],
          ['a', "  assert.equal(decide(req, 'always').remembered, true)"],
          ['a', '})'],
        ]),
      ],
    },
  ]
}

const MIN = 60_000
const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()
let shaSeq = 0x9b2d10e
function commit(
  subject: string,
  author: string,
  msAgo: number,
  extra: Partial<GitCommit> = {},
): GitCommit {
  const sha = (shaSeq += 0x11f3a).toString(16).padStart(7, '0') + 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
  return {
    sha: sha.slice(0, 40),
    shortSha: sha.slice(0, 7),
    subject,
    body: '',
    author,
    authorEmail: `${author}@example.com`,
    at: at(msAgo),
    parents: [],
    sessionId: null,
    turns: null,
    additions: 12,
    deletions: 3,
    ...extra,
  }
}

export function mockGit(options: {
  emit: (event: ServerEvent) => void
  sessions: () => Session[]
}): GitApi {
  const checkouts = new Map<string, Checkout>()
  const sid = (title: string) => options.sessions().find(s => s.title === title)?.id ?? null

  function fresh(t: GitTarget): Checkout {
    const session = t.kind === 'session' ? options.sessions().find(s => s.id === t.id) : undefined
    const branch = session?.branch ?? 'main'
    const onMain = branch === 'main'
    const permission = sid('Permission prompt component')
    const log: GitCommit[] = [
      ...(onMain
        ? []
        : [
            commit('feat(core): persist allow-always rules per project', 'nick', 12 * MIN, {
              sessionId: permission,
              turns: '3',
              additions: 38,
              deletions: 4,
            }),
            commit('feat(web): permission prompt component', 'nick', 21 * MIN, {
              sessionId: permission,
              turns: '2',
              additions: 108,
              deletions: 3,
            }),
          ]),
      commit('Merge #41: keep the runner, tidy the API', 'nick', 2 * 60 * MIN),
      commit('feat(web): session header with branch chip', 'nick', 26 * 60 * MIN),
      commit('feat(web): side panel History tab', 'nick', 3 * 24 * 60 * MIN, {
        sessionId: sid('Session screen: streaming chat'),
        turns: '4',
      }),
      commit('feat(web): resizable panels', 'nick', 14 * 24 * 60 * MIN),
      commit('feat(web): streaming chat', 'rick', 28 * 24 * 60 * MIN, {
        additions: 64,
        deletions: 22,
      }),
      commit('refactor(web): move side panel to SessionSide.vue', 'nick', 35 * 24 * 60 * MIN),
    ]
    const mk = (name: string, o: Partial<GitBranch> = {}): GitBranch => ({
      name,
      remote: false,
      current: name === branch,
      upstream: o.remote ? null : `origin/${name}`,
      ahead: 0,
      behind: 0,
      upstreamGone: false,
      headSha: log[0]!.sha,
      subject: log[0]!.subject,
      lastCommitAt: at(2 * 60 * MIN),
      worktree: null,
      worktreeSession: null,
      ...o,
    })
    const branches: GitBranch[] = [
      mk(branch, onMain ? { behind: 3 } : { ahead: 2, behind: 1, subject: log[0]!.subject }),
      ...(onMain ? [] : [mk('main', { behind: 3, lastCommitAt: at(2 * 60 * MIN) })]),
      mk('feat/perf-history-search', {
        ahead: 1,
        subject: 'perf(core): FTS table for session titles',
        lastCommitAt: at(2 * 60 * MIN),
      }),
      mk('odin/keep-runner-1a2c', {
        worktree: '/home/me/.odin/worktrees/odin/odin-keep-runner',
        worktreeSession: sid('Keep the runner: tidy the API'),
        lastCommitAt: at(2 * 24 * 60 * MIN),
      }),
      mk('fix/header-overflow', {
        upstreamGone: true,
        lastCommitAt: at(4 * 24 * 60 * MIN),
      }),
      mk('origin/feat/permissions-v2', {
        remote: true,
        subject: 'feat(core): permission rules v2',
        lastCommitAt: at(24 * 60 * MIN),
      }),
    ]
    return {
      branch,
      upstream: `origin/${branch}`,
      ahead: onMain ? 0 : 2,
      behind: onMain ? 3 : 1,
      files: t.kind === 'session' ? sessionFiles() : [],
      stashes: [
        {
          ref: 'stash@{0}',
          message: 'palette tweaks',
          branch: 'main',
          at: at(26 * 60 * MIN),
          auto: false,
          files: [],
        },
      ],
      log,
      branches,
      fetchedAt: at(3 * MIN),
    }
  }

  const key = (t: GitTarget) => `${t.kind}:${t.id}`
  function co(t: GitTarget): Checkout {
    let c = checkouts.get(key(t))
    if (!c) checkouts.set(key(t), (c = fresh(t)))
    return c
  }
  const changed = (t: GitTarget) =>
    options.emit({ type: 'git.changed', target: { kind: t.kind, id: t.id } })

  // ── git actions: the tests fail until they've been run again ("fixed") ──
  const TEST_FAIL = [
    ' ✓ permissions › asks once by default',
    ' ✓ permissions › allow-once expires',
    ' ✕ permissions › persists allow-always',
    "     expected 'always', got undefined",
    '       at permissions.test.ts:48:12',
    '',
    'Tests: 1 failed, 11 passed',
  ].join('\n')
  const actionSets = new Map<string, GitAction[]>()
  const run = (ok: boolean, msAgo: number, command: string[], output: string): GitActionRun => ({
    ok,
    at: at(msAgo),
    durationMs: ok ? 3_400 : 14_200,
    exitCode: ok ? 0 : 1,
    timedOut: false,
    command,
    output,
  })
  function actionsOf(t: GitTarget): GitAction[] {
    const k = `${t.kind}:${t.id}`
    let list = actionSets.get(k)
    if (list) return list
    // the sample project's repo has some; the other sample projects have none
    if (t.kind === 'project' && t.id !== 'odin') return []
    const def = (
      o: Partial<GitAction> & Pick<GitAction, 'id' | 'title' | 'on' | 'run'>,
    ): GitAction => ({
      description: '',
      blocking: o.on === 'pre-commit',
      timeoutSec: 120,
      enabled: true,
      file: `.odin/git-actions/${o.id}.json`,
      error: null,
      lastRun: null,
      ...o,
    })
    const testCmd = ['yarn', 'test', '--changed', '$STAGED']
    list = [
      def({
        id: 'test-before-commit',
        title: 'Run tests before commit',
        description: 'Runs the tests that cover the staged files. Blocks the commit on failure.',
        on: 'pre-commit',
        run: testCmd,
        lastRun: run(
          false,
          2 * MIN,
          ['yarn', 'test', '--changed', 'packages/core/src/permissions.ts'],
          TEST_FAIL,
        ),
      }),
      def({
        id: 'format-staged',
        title: 'Format staged files',
        description: 'Prettier on the staged files.',
        on: 'pre-commit',
        blocking: false,
        run: ['yarn', 'prettier', '--write', '$STAGED'],
        lastRun: run(
          true,
          2 * MIN,
          ['yarn', 'prettier', '--write', 'SessionSide.vue'],
          'SessionSide.vue 41ms',
        ),
      }),
      def({
        id: 'changelog',
        title: 'Check the changelog fragment',
        description: 'Fails when changes/ has no fragment for this branch.',
        on: 'manual',
        run: ['node', 'scripts/check-changes.mjs'],
      }),
      def({
        id: 'typecheck-before-push',
        title: 'Typecheck before push',
        description: "yarn typecheck. Warns, doesn't block.",
        on: 'pre-push',
        run: ['yarn', 'typecheck'],
        lastRun: run(true, 26 * 60 * MIN, ['yarn', 'typecheck'], 'Done in 18.2s.'),
      }),
      def({
        id: 'release',
        title: 'Release notes',
        on: 'manual',
        run: [],
        error: '"run" must be a non-empty array of strings (an argv; no shell)',
        enabled: false,
      }),
    ]
    actionSets.set(k, list)
    return list
  }
  const fixed = new Set<string>()
  const counts = (hunks: MockHunk[]) => ({
    additions: hunks.reduce((n, h) => n + h.lines.filter(l => l.kind === 'add').length, 0),
    deletions: hunks.reduce((n, h) => n + h.lines.filter(l => l.kind === 'del').length, 0),
  })

  function status(t: GitTarget): GitStatus {
    const c = co(t)
    const staged: GitChange[] = []
    const unstaged: GitChange[] = []
    for (const f of c.files) {
      const s = f.hunks.filter(h => h.staged)
      const u = f.hunks.filter(h => !h.staged)
      const tracked = f.state !== 'untracked'
      if (s.length)
        staged.push({
          path: f.path,
          oldPath: null,
          state: tracked ? f.state : 'added',
          ...counts(s),
        })
      if (u.length) unstaged.push({ path: f.path, oldPath: null, state: f.state, ...counts(u) })
    }
    return {
      repo: true,
      branch: c.branch,
      headSha: c.log[0]?.sha ?? null,
      upstream: c.upstream,
      ahead: c.ahead,
      behind: c.behind,
      upstreamGone: false,
      staged,
      unstaged,
      conflicted: [],
      operation: null,
      fetchedAt: c.fetchedAt,
    }
  }

  const ok = <T>(v: T) => Promise.resolve(structuredClone(v))
  const fail = (status: number, message: string, code?: string) =>
    Promise.reject(new ApiRequestError(status, message, code))
  const file = (t: GitTarget, path: string) => co(t).files.find(f => f.path === path)

  function mutate(
    t: GitTarget,
    req: { paths?: string[]; hunks?: { path: string; hunkId: string }[] },
    fn: (f: MockFile, h: MockHunk | null) => void,
  ) {
    for (const p of req.paths ?? []) {
      const f = file(t, p)
      if (f) fn(f, null)
    }
    for (const h of req.hunks ?? []) {
      const f = file(t, h.path)
      const hk = f?.hunks.find(x => x.id === h.hunkId)
      if (f && hk) fn(f, hk)
    }
    const c = co(t)
    c.files = c.files.filter(f => f.hunks.length)
    changed(t)
    return ok(status(t))
  }

  const diffOf = (t: GitTarget, path: string, staged: boolean): GitFileDiff => {
    const f = file(t, path)
    return {
      path,
      oldPath: null,
      staged,
      binary: false,
      truncated: false,
      hunks: (f?.hunks ?? []).filter(h => h.staged === staged).map(({ staged: _s, ...h }) => h),
    }
  }

  const blameFor = (t: GitTarget, path: string): GitBlame => {
    const c = co(t)
    const [prompt, header, history, resize, stream, move] = [
      c.log.find(x => x.subject.includes('permission prompt component')) ?? c.log[0]!,
      c.log.find(x => x.subject.includes('session header'))!,
      c.log.find(x => x.subject.includes('History tab'))!,
      c.log.find(x => x.subject.includes('resizable'))!,
      c.log.find(x => x.subject.includes('streaming chat'))!,
      c.log.find(x => x.subject.includes('move side panel'))!,
    ]
    const ranges = [
      { sha: header.sha, start: 1, lines: 2 },
      { sha: stream.sha, start: 3, lines: 2 },
      { sha: resize.sha, start: 5, lines: 1 },
      { sha: prompt.sha, start: 6, lines: 3 },
      { sha: move.sha, start: 9, lines: 1 },
      { sha: prompt.sha, start: 10, lines: 2 },
      { sha: header.sha, start: 12, lines: 2 },
      { sha: stream.sha, start: 14, lines: 3 },
      { sha: move.sha, start: 17, lines: 6 },
      { sha: history.sha, start: 23, lines: 1 },
      { sha: prompt.sha, start: 24, lines: 4 },
      { sha: move.sha, start: 28, lines: 400 },
    ]
    const commits = Object.fromEntries(
      [prompt, header, history, resize, stream, move].map(x => [x.sha, x]),
    )
    return { path, ranges, commits }
  }

  return {
    gitStatus: t => ok(status(t)),
    gitDiff: (t, path, staged) => ok(diffOf(t, path, staged)),
    gitStage: (t, req) =>
      mutate(t, req, (f, h) => (h ? [h] : f.hunks).forEach(x => (x.staged = true))),
    gitUnstage: (t, req) =>
      mutate(t, req, (f, h) => (h ? [h] : f.hunks).forEach(x => (x.staged = false))),
    gitDiscard: (t, req) =>
      mutate(t, req, (f, h) => {
        f.hunks = h ? f.hunks.filter(x => x !== h) : f.hunks.filter(x => x.staged && !req.paths)
        if (!h) f.hunks = []
      }),
    gitCommit: (t, req) => {
      const c = co(t)
      if (req.all) c.files.forEach(f => f.hunks.forEach(h => (h.staged = true)))
      const staged = c.files.flatMap(f => f.hunks.filter(h => h.staged))
      if (!staged.length) return fail(409, 'Nothing is staged to commit.', 'nothing-to-commit')
      const tests = actionsOf(t).find(a => a.id === 'test-before-commit')!
      if (!req.skipActions && tests.enabled && !fixed.has(`${t.kind}:${t.id}`)) {
        tests.lastRun = run(false, 0, tests.lastRun!.command, TEST_FAIL)
        return fail(409, `${tests.title} failed, so nothing was committed.`, 'action-failed')
      }
      const [subject = '', ...rest] = req.message.trim().split('\n')
      const made = commit(subject, 'nick', 0, { body: rest.join('\n').trim(), ...counts(staged) })
      c.log.unshift(made)
      c.files.forEach(f => (f.hunks = f.hunks.filter(h => !h.staged)))
      c.files = c.files.filter(f => f.hunks.length)
      c.ahead++
      changed(t)
      return ok({ sha: made.sha, status: status(t) })
    },
    gitLog: (t, opts = {}) => {
      const c = co(t)
      const incoming = () =>
        Array.from({ length: c.behind }, (_, i) =>
          commit('fix(core): close the SSE stream when a client aborts', 'rick', (40 + i) * MIN, {
            additions: 9,
            deletions: 2,
          }),
        )
      const all =
        opts.ref === 'HEAD..@{u}'
          ? incoming()
          : opts.ref === '@{u}..HEAD'
            ? c.log.slice(0, c.ahead)
            : c.log
      const skip = opts.skip ?? 0
      const limit = opts.limit ?? 50
      return ok({ commits: all.slice(skip, skip + limit), more: all.length > skip + limit })
    },
    gitShow: (t, sha, path) => {
      const c = co(t).log.find(x => x.sha === sha || x.shortSha === sha)
      if (!c) return fail(404, `unknown commit ${sha}`)
      const files = sessionFiles().slice(0, 3)
      const shown = path ? files.filter(f => f.path === path) : files
      const list = shown.length ? shown : [files[2]!]
      return ok({
        commit: c,
        files: list.map(f => ({
          path: path ?? f.path,
          oldPath: null,
          state: f.state === 'untracked' ? ('added' as const) : f.state,
          ...counts(f.hunks),
        })),
        diffs: list.map(f => ({
          path: path ?? f.path,
          oldPath: null,
          staged: true,
          binary: false,
          truncated: false,
          hunks: f.hunks.map(({ staged: _s, ...h }) => h),
        })),
      })
    },
    gitBlame: (t, path) => ok(blameFor(t, path)),
    gitBranches: t => {
      const c = co(t)
      return ok({
        current: c.branch,
        branches: c.branches.map(b => ({ ...b, current: b.name === c.branch })),
      })
    },
    gitCheckout: (t, req) => {
      const c = co(t)
      const dirty = c.files.some(f => f.state !== 'untracked' || f.hunks.some(h => h.staged))
      const mode = req.dirty ?? 'fail'
      if (dirty && mode === 'fail')
        return fail(
          409,
          `${status(t).unstaged.length + status(t).staged.length} files have uncommitted changes.`,
          'dirty-tree',
        )
      const target = c.branches.find(b => b.name === req.branch)
      if (target?.worktree)
        return fail(409, 'That branch is checked out in another worktree.', 'checked-out-elsewhere')
      let stashed: string | null = null
      if (dirty && mode === 'stash') {
        c.stashes.unshift({
          ref: 'stash@{0}',
          message: `${AUTO_STASH_PREFIX} ${c.branch}`,
          branch: c.branch,
          at: at(0),
          auto: true,
          files: c.files,
        })
        c.stashes.forEach((s, i) => (s.ref = `stash@{${i}}`))
        c.files = []
        stashed = 'stash@{0}'
      }
      const name = req.branch.replace(/^origin\//, '')
      if (req.create || !c.branches.some(b => b.name === name))
        c.branches.unshift({
          ...c.branches[0]!,
          name,
          remote: false,
          ahead: 0,
          behind: 0,
          upstream: req.create ? null : `origin/${name}`,
          worktree: null,
          worktreeSession: null,
        })
      const next = c.branches.find(b => b.name === name)!
      c.branch = name
      c.ahead = next.ahead
      c.behind = next.behind
      c.upstream = next.upstream
      let restored = false
      const auto = c.stashes.findIndex(s => s.message === `${AUTO_STASH_PREFIX} ${name}`)
      if (auto >= 0 && !c.files.length) {
        c.files = c.stashes[auto]!.files
        c.stashes.splice(auto, 1)
        c.stashes.forEach((s, i) => (s.ref = `stash@{${i}}`))
        restored = true
      }
      changed(t)
      return ok({ branch: name, stashed, restored, status: status(t) })
    },
    gitFetch: t => {
      const c = co(t)
      c.fetchedAt = at(0)
      changed(t)
      return ok({
        message: c.behind ? `${c.behind} new commits on ${c.upstream}` : 'Up to date',
        status: status(t),
      })
    },
    gitPull: (t, req) => {
      const c = co(t)
      const strategy = req.strategy ?? 'ff-only'
      if (c.ahead && c.behind && strategy === 'ff-only')
        return fail(409, 'The branch and its upstream have diverged.', 'diverged')
      const n = c.behind
      c.log.splice(
        c.ahead,
        0,
        ...Array.from({ length: n }, () =>
          commit('fix(core): close the SSE stream when a client aborts', 'rick', 40 * MIN),
        ),
      )
      c.behind = 0
      changed(t)
      return ok({
        message: n
          ? `Pulled ${n} ${n === 1 ? 'commit' : 'commits'}${strategy === 'ff-only' ? '' : ` (${strategy})`}`
          : 'Already up to date',
        status: status(t),
      })
    },
    gitPush: t => {
      const c = co(t)
      if (c.behind) return fail(409, 'The branch and its upstream have diverged.', 'diverged')
      const n = c.ahead
      c.ahead = 0
      c.upstream ??= `origin/${c.branch}`
      changed(t)
      return ok({
        message: n ? `Pushed ${n} ${n === 1 ? 'commit' : 'commits'}` : 'Pushed',
        status: status(t),
      })
    },
    gitActions: t => ok(actionsOf(t).map(a => ({ ...a }))),
    gitRunAction: (t, id) => {
      const a = actionsOf(t).find(x => x.id === id)
      if (!a) return fail(404, `unknown git action "${id}"`)
      if (a.error) return fail(400, `${a.file}: ${a.error}`)
      if (a.id === 'test-before-commit') fixed.add(`${t.kind}:${t.id}`)
      a.lastRun = run(true, 0, a.run, a.id === 'test-before-commit' ? 'Tests: 12 passed' : 'Done.')
      return ok({ ...a.lastRun })
    },
    gitStashes: t => ok(co(t).stashes.map(({ files: _f, ...s }) => s)),
    gitStash: (t, req) => {
      const c = co(t)
      c.stashes.unshift({
        ref: 'stash@{0}',
        message: req.message || `WIP on ${c.branch}`,
        branch: c.branch,
        at: at(0),
        auto: false,
        files: c.files,
      })
      c.stashes.forEach((s, i) => (s.ref = `stash@{${i}}`))
      c.files = []
      changed(t)
      return ok(status(t))
    },
    gitStashAction: (t, action, ref) => {
      const c = co(t)
      const i = c.stashes.findIndex(s => s.ref === ref)
      if (i < 0) return fail(404, `no stash ${ref}`)
      if (action !== 'drop') c.files = [...c.files, ...c.stashes[i]!.files]
      if (action !== 'apply') c.stashes.splice(i, 1)
      c.stashes.forEach((s, k) => (s.ref = `stash@{${k}}`))
      changed(t)
      return ok(status(t))
    },
  }
}
