// In-memory fixtures for the mock API (`?mock`, VITE_MOCK=1, tests, screenshots). Three projects: `odin` (GitHub
// repo, in sync, sessions in every state), `rick` (a plain folder, not a git repository, with sessions from a
// terminal) and `harbor` (a git repository with no sessions yet), so every screen has something to show. Times are relative to `now`, so "5m ago" stays true whenever the page loads.
import type {
  Artifact,
  ArtifactVersion,
  AssetFiles,
  AssetKind,
  AssetVersion,
  Installation,
  LibraryAsset,
  ModelInfo,
  ProjectActivityDay,
  ProjectBranch,
  ProjectContext,
  ProjectDetail,
  Session,
  SessionMetrics,
  SettingsResponse,
  Todo,
} from '@odin/shared/api'
import {
  taskKey,
  type PermissionRequest,
  type TranscriptEntry,
  type TaskActivity,
} from '@odin/shared/harness'
import { emptyProjectContext } from '@odin/shared/api'
import { promptVariables } from '@odin/shared/library'
import { DEFAULT_PRICING } from '@odin/shared/pricing'
import { emptyMetrics } from '@odin/shared/session'

export interface Fixtures {
  projects: ProjectDetail[]
  sessions: Session[]
  /** The harness transcript per session id (core reads it from the harness; the mock keeps it here). */
  transcripts: Record<string, TranscriptEntry[]>
  pending: Record<string, PermissionRequest[]>
  todos: Record<string, Todo[]>
  library: LibraryAsset[]
  /** Current files per asset, keyed `<kind>/<id>`. */
  libraryFiles: Record<string, AssetFiles>
  /** Recorded versions per asset (newest first) and their files, keyed `<kind>/<id>` and `<kind>/<id>@<version>`. */
  libraryVersions: Record<string, AssetVersion[]>
  versionFiles: Record<string, AssetFiles>
  installations: Installation[]
  /** What's in each project for an installed asset, keyed `<project>/<kind>/<id>`. */
  projectFiles: Record<string, AssetFiles>
  artifacts: Artifact[]
  artifactVersions: ArtifactVersion[]
  /** The page each artifact version serves, keyed `<artifactId>/<version>`. */
  artifactHtml: Record<string, string>
  tracking: Record<string, boolean>
  /** GET /api/projects/:name/activity, 168 days per project (oldest first, today last). */
  activity: Record<string, ProjectActivityDay[]>
  /** GET /api/projects/:name/branches. */
  branches: Record<string, ProjectBranch[]>
  models: ModelInfo[]
  settings: SettingsResponse
}

/** A stable stand-in for a sha256: 64 hex chars from the seed. Not cryptographic; fixtures only. */
export function fakeHash(seed: string): string {
  let out = ''
  let h = 0x811c9dc5
  for (let round = 0; out.length < 64; round++) {
    for (const ch of `${seed}:${round}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0
    out += h.toString(16).padStart(8, '0')
  }
  return out.slice(0, 64)
}

/** A stable fake UUID from a seed. */
export function fakeUuid(seed: string): string {
  const h = fakeHash(seed)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}

const MIN = 60_000
/** YYYY-MM-DD in the local time zone. */
export function localDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export const MODELS: ModelInfo[] = [
  {
    value: 'default',
    displayName: 'Default',
    description: 'The account default',
    resolved: 'claude-fable-5-2',
  },
  {
    value: 'opus',
    displayName: 'Opus 5.5',
    description: 'Complex everyday work',
    resolved: 'claude-opus-5-5',
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    value: 'sonnet',
    displayName: 'Sonnet 5.5',
    description: 'Routine tasks',
    resolved: 'claude-sonnet-5-5',
    effortLevels: ['low', 'medium', 'high'],
  },
  {
    value: 'haiku',
    displayName: 'Haiku 5.5',
    description: 'Quick answers',
    resolved: 'claude-haiku-5-5',
  },
]

function metrics(
  over: Partial<SessionMetrics> & { model?: string; out?: number } = {},
): SessionMetrics {
  const m = emptyMetrics()
  const out = over.out ?? 0
  const model = over.model ?? 'claude-sonnet-5-5'
  const tokens = { input: out * 3, output: out, cacheRead: out * 40, cacheWrite: out * 4 }
  const { model: _m, out: _o, ...rest } = over
  return { ...m, tokens, tokensByModel: out ? { [model]: tokens } : {}, ...rest }
}

const AGENT_REVIEWER = `---
name: reviewer
description: Reviews a diff for correctness, tests and the repo's rules. Read-only.
tools: Read, Grep, Glob, Bash
model: sonnet
---

You review changes. Read the diff, run the tests, and report problems with file and line.
`

const AGENT_REVIEWER_OLD = `---
name: reviewer
description: Reviews a diff.
tools: Read, Grep, Glob
model: sonnet
---

You review changes.
`

const AGENT_DOCS = `---
name: docs-writer
description: Keeps README and docs/ in step with the code.
tools: Read, Edit, Grep, Glob
model: haiku
---

Update the docs to match the code. Short sentences.
`

const SKILL_RELEASE = `---
name: release-notes
description: Writes release notes from merged PRs since the last tag.
---

1. Find the last tag with \`git describe --tags --abbrev=0\`.
2. List merged PRs since then.
3. Group by type and write \`CHANGELOG.md\` entries.
`

const COMMAND_TRIAGE = `---
description: Triage the open issues and suggest the next three.
---

Read the open issues and propose the next three to work on, with reasons.
`

const PROMPT_FIX_ISSUE = `---
name: Fix an issue
description: Start work on an issue.
---

Work on issue {{issue}}.

Make a plan first, then implement it on branch {{branch}}. Run the tests before you finish.
`

const PROMPT_REVIEW = `---
name: Review my branch
description: A careful review of the current branch.
---

Review the changes on {{branch}} against main. Focus on {{focus}}.
`

function asset(
  kind: AssetKind,
  id: string,
  name: string,
  description: string,
  files: AssetFiles,
  meta: Record<string, unknown>,
  updatedAt: string,
): LibraryAsset {
  return {
    kind,
    id,
    name,
    description,
    version: fakeHash(`${kind}/${id}/${JSON.stringify(files)}`),
    updatedAt,
    files: Object.keys(files),
    meta,
    error: null,
    enabled: true,
  }
}

const ARTIFACT_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Pick a layout</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; margin: 16px; }
  .opts { display: flex; gap: 12px; }
  button { padding: 12px 16px; border-radius: 8px; border: 1px solid #ccc; background: #fff; cursor: pointer; }
</style></head>
<body>
  <h2>Which History layout?</h2>
  <p>A: one dense table. B: cards grouped by project.</p>
  <div class="opts">
    <button onclick="odin.submit({ choice: 'A' })">A: table</button>
    <button onclick="odin.submit({ choice: 'B' })">B: cards</button>
  </div>
</body></html>`

const CHECKLIST_HTML = (version: number) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Removal checklist</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; margin: 16px; }
  li { margin: 4px 0; }
</style></head>
<body>
  <h2>Removal checklist${version > 1 ? ' (revised)' : ''}</h2>
  <ul>
    <li><label><input type="checkbox" checked> Pi runner and its tests</label></li>
    <li><label><input type="checkbox" checked> PM agent prompts</label></li>
    <li><label><input type="checkbox"${version > 1 ? ' checked' : ''}> Sprints and topics tables</label></li>
    ${version > 1 ? '<li><label><input type="checkbox"> Docs that mention sprints</label></li>' : ''}
  </ul>
  <button onclick="odin.submit({ approved: true, version: ${version} })">Approve</button>
</body></html>`

const DEPENDENCY_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Module dependency map</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; margin: 16px; }
  table { border-collapse: collapse; }
  td, th { border: 1px solid #ccc; padding: 4px 8px; text-align: left; }
</style></head>
<body>
  <h2>What still imports the PM</h2>
  <table>
    <tr><th>Module</th><th>Imports</th></tr>
    <tr><td>sessions</td><td>none</td></tr>
    <tr><td>library</td><td>pm/topics.ts</td></tr>
    <tr><td>metrics</td><td>pm/sprints.ts</td></tr>
  </table>
</body></html>`

function contextFor(status: string | null): ProjectContext {
  const context = emptyProjectContext()
  if (!status) return context
  return {
    ...context,
    discovered: { overview: 'README.md', status: ['docs/STATUS.md'], planning: ['docs/plans'] },
    sources: { overview: 'README.md', status: ['docs/STATUS.md'], planning: ['docs/plans'] },
    provenance: {
      title: { kind: 'override' },
      description: { kind: 'override' },
      repo: { kind: 'override' },
      commands: { install: { kind: 'override' }, check: { kind: 'override' } },
    },
    excerpts: [
      { path: 'docs/STATUS.md', heading: 'Where things stand', text: 'Wave 0 done. Wave 1 next.' },
    ],
    planning: [{ path: 'docs/plans/build.md', title: 'Build', status: null, root: 'docs/plans' }],
  }
}

export function createFixtures(now: number = Date.now()): Fixtures {
  const ago = (ms: number) => new Date(now - ms).toISOString()
  const root = '/home/me/code'

  const projects: ProjectDetail[] = [
    {
      name: 'odin',
      title: 'Odin',
      description: 'A desktop hub for agent sessions.',
      path: `${root}/odin`,
      repo: 'nurciuoli/odin',
      missing: false,
      sessions: { running: 1, waiting: 1, total: 5 },
      sync: { state: 'idle', lastSyncAt: ago(3 * MIN), error: null },
      activity: [0, 1, 2, 0, 0, 3, 1, 2, 4, 0, 1, 3, 2, 2],
      updatedAt: ago(2 * MIN),
      settings: {
        githubEnabled: true,
        title: 'Odin',
        description: 'A desktop hub for agent sessions.',
        repo: 'nurciuoli/odin',
        defaultBranch: 'main',
        commands: { install: 'npm install', check: 'npm run typecheck && npm test' },
      },
      manifestError: null,
      git: { branch: 'main', headSha: 'a1b2c3d4e5f6', dirty: true, ahead: 0, behind: 0 },
      status: '# Odin: where things stand\n\nWave 0 done. Wave 1 next.',
      agents: [
        {
          id: 'reviewer',
          name: 'reviewer',
          description: 'Reviews a diff for correctness, tests and the repo rules. Read-only.',
          model: 'sonnet',
          tools: ['Read', 'Grep', 'Glob', 'Bash'],
          path: '.claude/agents/reviewer.md',
          version: fakeHash('agent/reviewer/old'),
          libraryId: 'reviewer',
          error: null,
        },
        {
          id: 'odin-web',
          name: 'odin-web',
          description: 'Builds Odin web screens with Instrument UI.',
          model: 'opus',
          tools: null,
          path: '.claude/agents/odin-web.md',
          version: fakeHash('agent/odin-web'),
          libraryId: null,
          error: null,
        },
      ],
      dirtyFiles: ['.claude/skills/release-notes/SKILL.md'],
      context: contextFor('# Odin: where things stand\n\nWave 0 done. Wave 1 next.'),
      firstSessionAt: ago(60 * DAY),
      lastSessionAt: ago(5 * MIN),
    },
    {
      name: 'rick',
      title: 'Rick',
      description: 'The earlier agent runner.',
      path: `${root}/rick`,
      repo: null,
      missing: false,
      sessions: { running: 0, waiting: 0, total: 2 },
      sync: { state: 'off', lastSyncAt: null, error: null },
      activity: [0, 0, 1, 0, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0],
      updatedAt: ago(2 * DAY),
      settings: {
        title: 'Rick',
        description: 'The earlier agent runner.',
        repo: null,
        defaultBranch: 'main',
        commands: {},
      },
      manifestError: null,
      git: { branch: null, headSha: null, dirty: false, ahead: 0, behind: 0 },
      status: null,
      agents: [],
      dirtyFiles: [],
      context: contextFor(null),
      firstSessionAt: ago(9 * DAY),
      lastSessionAt: ago(2 * DAY - HOUR),
    },
    {
      name: 'harbor',
      title: 'Harbor',
      description: 'Map tiles for the field app. Registered, no sessions yet.',
      path: `${root}/harbor`,
      repo: null,
      missing: false,
      sessions: { running: 0, waiting: 0, total: 0 },
      sync: { state: 'off', lastSyncAt: null, error: null },
      activity: Array.from({ length: 14 }, () => 0),
      updatedAt: ago(5 * DAY),
      settings: {
        title: 'Harbor',
        description: 'Map tiles for the field app. Registered, no sessions yet.',
        repo: null,
        defaultBranch: 'main',
        commands: { install: 'pnpm install', check: 'pnpm test', build: 'pnpm build' },
      },
      manifestError: null,
      git: { branch: 'main', headSha: '9a8b7c6d5e4f', dirty: false, ahead: 0, behind: 0 },
      status: null,
      agents: [],
      dirtyFiles: [],
      context: contextFor(null),
      firstSessionAt: null,
      lastSessionAt: null,
    },
  ]

  // ── sessions ──
  const s = {
    running: fakeUuid('s-running'),
    waiting: fakeUuid('s-waiting'),
    idle: fakeUuid('s-idle'),
    ended: fakeUuid('s-ended'),
    failed: fakeUuid('s-failed'),
    fork: fakeUuid('s-fork'),
    forkFork: fakeUuid('s-fork-fork'),
    external: fakeUuid('s-external'),
    rickOld: fakeUuid('s-rick-old'),
    aside: fakeUuid('s-aside'),
  }
  const base = (
    id: string,
    o: Partial<Session> & Pick<Session, 'project' | 'title' | 'state'>,
  ): Session => ({
    id,
    projects: [o.project],
    harness: 'claude',
    tags: [],
    pinned: false,
    archived: false,
    origin: 'odin',
    waitingFor: null,
    cwd: projects.find(p => p.name === o.project)!.path,
    workspace: { kind: 'checkout' },
    branch: 'main',
    model: 'claude-sonnet-5-5',
    permissionMode: 'default',
    agent: null,
    agentVersion: null,
    templateId: null,
    parentId: null,
    aside: false,
    pull: null,
    createdAt: ago(HOUR),
    updatedAt: ago(MIN),
    endedAt: null,
    error: null,
    metrics: metrics(),
    ...o,
  })

  const sessions: Session[] = [
    base(s.running, {
      project: 'odin',
      title: 'Session screen: streaming chat',
      state: 'running',
      workspace: {
        kind: 'worktree',
        path: '/home/me/.odin/worktrees/odin/odin-session-screen-3f9a1c2e',
        branch: 'odin/session-screen-3f9a1c2e',
      },
      cwd: '/home/me/.odin/worktrees/odin/odin-session-screen-3f9a1c2e',
      branch: 'odin/session-screen-3f9a1c2e',
      model: 'claude-opus-5-5',
      templateId: 'fix-issue',
      tags: ['web'],
      pinned: true,
      createdAt: ago(40 * MIN),
      updatedAt: ago(10_000),
      metrics: metrics({
        model: 'claude-opus-5-5',
        out: 18_400,
        wallMs: 40 * MIN,
        activeMs: 22 * MIN,
        turns: 6,
        toolCalls: 41,
        costUsd: 1.92,
        contextTokens: 88_000,
        diff: { added: 412, removed: 37, files: 9 },
        commits: 2,
      }),
    }),
    base(s.waiting, {
      project: 'odin',
      title: 'Permission prompt component',
      state: 'waiting',
      waitingFor: 'permission',
      branch: 'odin/permission-prompt-7b2d4e81',
      agent: 'library:reviewer',
      agentVersion: fakeHash('agent/reviewer'),
      pull: {
        number: 42,
        url: 'https://github.com/nurciuoli/odin/pull/42',
        state: 'open',
        merged: false,
      },
      createdAt: ago(25 * MIN),
      updatedAt: ago(2 * MIN),
      metrics: metrics({
        diff: { added: 96, removed: 12, files: 4 },
        prOutcome: 'open',
        out: 6_200,
        wallMs: 25 * MIN,
        activeMs: 9 * MIN,
        turns: 3,
        toolCalls: 14,
        costUsd: 0.31,
        contextTokens: 41_000,
      }),
    }),
    base(s.idle, {
      project: 'odin',
      title: 'Why is history search slow?',
      state: 'idle',
      model: 'claude-haiku-5-5',
      createdAt: ago(3 * HOUR),
      updatedAt: ago(2 * HOUR),
      tags: ['perf'],
      metrics: metrics({
        model: 'claude-haiku-5-5',
        out: 2_100,
        wallMs: 12 * MIN,
        activeMs: 3 * MIN,
        turns: 2,
        toolCalls: 6,
        costUsd: 0.02,
      }),
    }),
    base(s.ended, {
      project: 'odin',
      title: 'Remove Pi and the PM',
      state: 'ended',
      branch: 'odin/remove-pi-c4e8a90d',
      model: 'claude-opus-5-5',
      createdAt: ago(4 * DAY),
      updatedAt: ago(4 * DAY - 2 * HOUR),
      endedAt: ago(4 * DAY - 2 * HOUR),
      pull: {
        number: 40,
        url: 'https://github.com/nurciuoli/odin/pull/40',
        state: 'closed',
        merged: true,
      },
      metrics: metrics({
        model: 'claude-opus-5-5',
        out: 31_000,
        wallMs: 2 * HOUR,
        activeMs: 70 * MIN,
        turns: 14,
        toolCalls: 120,
        costUsd: 3.4,
        diff: { added: 120, removed: 4_210, files: 61 },
        commits: 5,
        prOutcome: 'merged',
        reviewRounds: 0,
      }),
    }),
    base(s.failed, {
      project: 'odin',
      title: 'Try the Electron packaging',
      state: 'failed',
      error: 'The harness exited: API error (overloaded)',
      createdAt: ago(DAY),
      updatedAt: ago(DAY - 5 * MIN),
      metrics: metrics({
        out: 900,
        wallMs: 5 * MIN,
        activeMs: 2 * MIN,
        turns: 1,
        toolCalls: 3,
        costUsd: 0.05,
      }),
    }),
    base(s.fork, {
      project: 'odin',
      title: 'Remove Pi and the PM (fork: keep the runner)',
      state: 'ended',
      parentId: s.ended,
      branch: 'odin/keep-runner-1a2b3c4d',
      workspace: {
        kind: 'worktree',
        path: '/home/me/.odin/worktrees/odin/odin-keep-runner',
        branch: 'odin/keep-runner-1a2b3c4d',
      },
      cwd: '/home/me/.odin/worktrees/odin/odin-keep-runner',
      model: 'claude-opus-5-5',
      archived: true,
      createdAt: ago(4 * DAY - HOUR),
      updatedAt: ago(4 * DAY - 90 * MIN),
      endedAt: ago(4 * DAY - 90 * MIN),
      pull: {
        number: 41,
        url: 'https://github.com/nurciuoli/odin/pull/41',
        state: 'closed',
        merged: false,
      },
      metrics: metrics({
        model: 'claude-opus-5-5',
        out: 8_000,
        wallMs: 30 * MIN,
        activeMs: 18 * MIN,
        turns: 4,
        toolCalls: 30,
        costUsd: 0.9,
        prOutcome: 'closed',
      }),
    }),
    // Third link of the fork chain: ended → fork → this.
    base(s.forkFork, {
      project: 'odin',
      title: 'Keep the runner: tidy the API',
      state: 'ended',
      parentId: s.fork,
      branch: 'odin/keep-runner-1a2b3c4d',
      model: 'claude-sonnet-5-5',
      createdAt: ago(3 * DAY),
      updatedAt: ago(3 * DAY - 40 * MIN),
      endedAt: ago(3 * DAY - 40 * MIN),
      metrics: metrics({
        out: 3_000,
        wallMs: 40 * MIN,
        activeMs: 12 * MIN,
        turns: 3,
        toolCalls: 14,
        costUsd: 0.21,
      }),
    }),
    // Spans two projects: worked in rick, also touched odin.
    base(s.external, {
      project: 'rick',
      projects: ['rick', 'odin'],
      title: 'Port the GitHub client',
      state: 'idle',
      origin: 'external',
      permissionMode: null,
      createdAt: ago(2 * DAY),
      updatedAt: ago(2 * DAY - HOUR),
      metrics: metrics({
        out: 12_000,
        wallMs: HOUR,
        activeMs: 25 * MIN,
        turns: 8,
        toolCalls: 52,
        costUsd: 0.6,
      }),
    }),
    base(s.rickOld, {
      project: 'rick',
      title: 'Write the manifest parser',
      state: 'ended',
      origin: 'external',
      permissionMode: null,
      model: 'claude-haiku-5-5',
      createdAt: ago(9 * DAY),
      updatedAt: ago(9 * DAY - HOUR),
      endedAt: ago(9 * DAY - HOUR),
      metrics: metrics({
        model: 'claude-haiku-5-5',
        out: 4_000,
        wallMs: 40 * MIN,
        activeMs: 10 * MIN,
        turns: 5,
        toolCalls: 20,
        costUsd: 0.04,
      }),
    }),
  ]
  // A side thread of the running session: a question asked beside it, answered in plan mode. Lists leave it out.
  // Its title is what the server makes of the prompt: `Side: <first 60 chars>`.
  sessions.push(
    base(s.aside, {
      project: 'odin',
      title: 'Side: Does the thread keep scroll position on new entries?',
      state: 'idle',
      parentId: s.running,
      aside: true,
      permissionMode: 'plan',
      workspace: sessions[0]!.workspace,
      cwd: sessions[0]!.cwd,
      branch: sessions[0]!.branch,
      model: 'claude-haiku-5-5',
      createdAt: ago(6 * MIN),
      updatedAt: ago(5 * MIN),
      metrics: metrics({ model: 'claude-haiku-5-5', out: 400, turns: 1, costUsd: 0.01 }),
    }),
  )
  const u = (id: string, text: string, at: string): TranscriptEntry => ({
    kind: 'user',
    id,
    text,
    at,
    parentToolUseId: null,
  })
  const a = (id: string, text: string, at: string, model = 'claude-opus-5-5'): TranscriptEntry => ({
    kind: 'assistant',
    id,
    text,
    model,
    at,
    parentToolUseId: null,
  })
  const tool = (
    id: string,
    name: string,
    input: Record<string, unknown>,
    result: string | null,
    at: string,
    parent: string | null = null,
    ok = true,
  ): TranscriptEntry => ({
    kind: 'tool',
    id,
    name,
    input,
    ...(result === null ? {} : { result: { ok, text: result, truncated: false } }),
    at,
    parentToolUseId: parent,
  })

  const transcripts: Record<string, TranscriptEntry[]> = {
    [s.running]: [
      u(
        'r1',
        'Make a plan first, then implement the streaming chat on branch odin/session-screen-3f9a1c2e.',
        ago(40 * MIN),
      ),
      {
        kind: 'thinking',
        id: 'r2',
        text: 'The screen needs the transcript reducer from shared and the new library components. Start with the layout.',
        at: ago(39 * MIN),
        parentToolUseId: null,
      },
      a(
        'r3',
        "Here's the plan:\n\n1. `SessionScreen.vue` with the transcript, composer and side panel.\n2. Render tool calls with `IuToolCall`.\n3. Live updates from `session.event`.",
        ago(39 * MIN),
      ),
      tool('r4', 'TodoWrite', { todos: [] }, 'Todos updated', ago(38 * MIN)),
      tool(
        'r5',
        'Read',
        { file_path: 'packages/shared/src/transcript.ts' },
        '// Folding live harness events into a transcript…',
        ago(37 * MIN),
      ),
      tool(
        'r6',
        'Agent',
        { description: 'Find existing chat components', subagent_type: 'Explore' },
        'Found IuMessage, IuMessageList, IuComposer, IuAgentTrace.',
        ago(36 * MIN),
      ),
      tool(
        'r6a',
        'Grep',
        { pattern: 'IuMessage', path: 'packages/web/src/components' },
        'components/Chat/Message.vue',
        ago(36 * MIN),
        'r6',
      ),
      tool(
        'r7',
        'Write',
        {
          file_path: 'packages/web/src/screens/session/SessionScreen.vue',
          content: '<script setup lang="ts">\n…',
        },
        'File created',
        ago(30 * MIN),
      ),
      tool(
        'r8',
        'Edit',
        {
          file_path: 'packages/web/src/app/router.ts',
          old_string: "import('@/screens/session/SessionStub.vue')",
          new_string: "import('@/screens/session/SessionScreen.vue')",
        },
        'Edited',
        ago(28 * MIN),
      ),
      tool(
        'r8b',
        'Bash',
        { command: 'npm run type-check', description: 'Type-check the web app' },
        "src/screens/session/SessionScreen.vue(41,7): error TS2322: Type 'string' is not assignable to type 'number'.",
        ago(24 * MIN),
        null,
        false,
      ),
      tool(
        'r9',
        'Bash',
        { command: 'npm run verify:web', description: 'Run the web gates' },
        '✓ format\n✓ type-check\n✓ lint\n✓ 212 tests\n✓ build',
        ago(20 * MIN),
      ),
      {
        kind: 'tool',
        id: 'r9a',
        name: 'Bash',
        input: { command: 'rm -rf node_modules', description: 'Clean install' },
        result: { ok: false, status: 'denied', text: 'Denied', truncated: false },
        at: ago(19 * MIN),
        parentToolUseId: null,
      },
      {
        kind: 'tool',
        id: 'r9b',
        name: 'Bash',
        input: { command: 'npm run build', description: 'Build the app' },
        result: { ok: false, status: 'interrupted', text: 'Stopped by you', truncated: false },
        at: ago(19 * MIN),
        parentToolUseId: null,
      },
      a(
        'r10',
        'The screen renders the fixture transcript. Wiring the live events next.',
        ago(19 * MIN),
      ),
      u('r11', 'Also show context usage in the side panel.', ago(5 * MIN)),
      tool(
        'r12',
        'Edit',
        {
          file_path: 'packages/web/src/screens/session/SessionSide.vue',
          old_string: '<!-- usage -->',
          new_string: '<IuMeter …/>',
        },
        null,
        ago(10_000),
      ),
    ],
    [s.waiting]: [
      u(
        'w1',
        'Build the permission prompt component: allow once / always (pick a scope) / deny, with the tool input shown.',
        ago(25 * MIN),
      ),
      a(
        'w2',
        "I'll add `IuPermissionPrompt` under components/ and a doc story.",
        ago(24 * MIN),
        'claude-sonnet-5-5',
      ),
      tool(
        'w3',
        'Write',
        {
          file_path: 'packages/web/src/components/PermissionPrompt/PermissionPrompt.vue',
          content: '<script setup lang="ts">…',
        },
        'File created',
        ago(20 * MIN),
      ),
      tool(
        'w4',
        'Bash',
        {
          command: 'rm -rf packages/web/dist && npm run build -w @odin/web',
          description: 'Clean build of the web app',
        },
        null,
        ago(2 * MIN),
      ),
    ],
    [s.idle]: [
      u('i1', 'History search feels slow with a lot of sessions. Why?', ago(3 * HOUR)),
      tool(
        'i2',
        'Grep',
        { pattern: 'LIKE', path: 'packages/core/src/sessions' },
        'service.ts: WHERE title LIKE ?',
        ago(3 * HOUR),
      ),
      a(
        'i3',
        'The list query does a `LIKE %q%` over every row with no index and parses metrics JSON per row. Two fixes: an FTS table for titles, and paging.',
        ago(3 * HOUR),
        'claude-haiku-5-5',
      ),
    ],
    [s.ended]: [
      u('e1', 'Remove Pi, the PM agent, the runner, sprints and topics.', ago(4 * DAY)),
      a('e2', 'Done: 61 files changed, tests green. PR #40 is open.', ago(4 * DAY - 2 * HOUR)),
    ],
    [s.failed]: [
      u('f1', 'Package the Electron shell for this machine.', ago(DAY)),
      {
        kind: 'system',
        id: 'f2',
        level: 'error',
        text: 'API error (overloaded). The session stopped.',
        at: ago(DAY - 5 * MIN),
        parentToolUseId: null,
      },
    ],
    [s.fork]: [
      u('e1', 'Remove Pi, the PM agent, the runner, sprints and topics.', ago(4 * DAY)),
      a('e2', 'Done: 61 files changed, tests green. PR #40 is open.', ago(4 * DAY - 2 * HOUR)),
      u('k1', 'Try again but keep the runner.', ago(4 * DAY - HOUR)),
      a('k2', 'Kept the runner; PR #41.', ago(4 * DAY - 90 * MIN)),
    ],
    [s.external]: [
      u('x1', 'Port the GitHub client from the old repo.', ago(2 * DAY)),
      a(
        'x2',
        'Ported `github.ts` with ETag support and token scrubbing.',
        ago(2 * DAY - HOUR),
        'claude-sonnet-5-5',
      ),
    ],
    [s.rickOld]: [
      u('o1', 'Write the manifest parser.', ago(9 * DAY)),
      a('o2', 'Done.', ago(9 * DAY - HOUR), 'claude-haiku-5-5'),
    ],
  }

  const pending: Record<string, PermissionRequest[]> = {
    [s.waiting]: [
      {
        id: 'perm-w4',
        sessionId: s.waiting,
        kind: 'tool',
        toolName: 'Bash',
        toolUseId: 'w4',
        input: {
          command: 'rm -rf packages/web/dist && npm run build -w @odin/web',
          description: 'Clean build of the web app',
        },
        title: 'Claude wants to run: rm -rf packages/web/dist && npm run build -w @odin/web',
        description: null,
        canAlwaysAllow: true,
        defaultToDeny: false,
        createdAt: ago(2 * MIN),
      },
      // queued behind the command: the input area shows one prompt at a time ("1 of 2")
      {
        id: 'perm-w5',
        sessionId: s.waiting,
        kind: 'question',
        toolName: 'AskUserQuestion',
        toolUseId: null,
        input: {
          questions: [
            {
              header: 'Layout',
              question: 'Where should the prompt sit?',
              multiSelect: false,
              options: [
                {
                  label: 'In the input area',
                  description: 'Replaces the message box until answered.',
                },
                { label: 'Above the input', description: 'Stacks over the message box.' },
              ],
            },
          ],
        },
        title: 'Claude has a question',
        description: null,
        canAlwaysAllow: false,
        defaultToDeny: false,
        createdAt: ago(MIN),
      },
    ],
  }

  const todos: Record<string, Todo[]> = {
    [s.running]: [
      { content: 'Layout: transcript, composer, side panel', status: 'completed' },
      { content: 'Tool calls with IuToolCall', status: 'completed' },
      {
        content: 'Live updates from session.event',
        status: 'in_progress',
        activeForm: 'Wiring live updates',
      },
      { content: 'Context usage in the side panel', status: 'pending' },
    ],
  }

  // ── library ──
  const lib: {
    kind: AssetKind
    id: string
    name: string
    description: string
    files: AssetFiles
    meta: Record<string, unknown>
    at: string
  }[] = [
    {
      kind: 'agent',
      id: 'reviewer',
      name: 'reviewer',
      description: "Reviews a diff for correctness, tests and the repo's rules. Read-only.",
      files: { 'reviewer.md': AGENT_REVIEWER },
      meta: { model: 'sonnet', tools: ['Read', 'Grep', 'Glob', 'Bash'] },
      at: ago(DAY),
    },
    {
      kind: 'agent',
      id: 'docs-writer',
      name: 'docs-writer',
      description: 'Keeps README and docs/ in step with the code.',
      files: { 'docs-writer.md': AGENT_DOCS },
      meta: { model: 'haiku', tools: ['Read', 'Edit', 'Grep', 'Glob'] },
      at: ago(3 * DAY),
    },
    {
      kind: 'skill',
      id: 'release-notes',
      name: 'release-notes',
      description: 'Writes release notes from merged PRs since the last tag.',
      files: {
        'SKILL.md': SKILL_RELEASE,
        'template.md': '## {{version}}\n\n### Features\n\n### Fixes\n',
      },
      meta: {},
      at: ago(5 * DAY),
    },
    {
      kind: 'command',
      id: 'triage',
      name: 'triage',
      description: 'Triage the open issues and suggest the next three.',
      files: { 'triage.md': COMMAND_TRIAGE },
      meta: {},
      at: ago(6 * DAY),
    },
    {
      kind: 'prompt',
      id: 'fix-issue',
      name: 'Fix an issue',
      description: 'Start work on an issue.',
      files: { 'fix-issue.md': PROMPT_FIX_ISSUE },
      meta: { variables: promptVariables(PROMPT_FIX_ISSUE) },
      at: ago(2 * DAY),
    },
    {
      kind: 'prompt',
      id: 'review-branch',
      name: 'Review my branch',
      description: 'A careful review of the current branch.',
      files: { 'review-branch.md': PROMPT_REVIEW },
      meta: { variables: promptVariables(PROMPT_REVIEW) },
      at: ago(2 * DAY),
    },
    {
      kind: 'template',
      id: 'fix-issue',
      name: 'Fix an issue (worktree, Opus)',
      description: 'Fix an issue in its own worktree with Opus, edits auto-accepted.',
      files: {
        'fix-issue.json': JSON.stringify(
          {
            name: 'Fix an issue (worktree, Opus)',
            description: 'Fix an issue in its own worktree with Opus, edits auto-accepted.',
            prompt: '',
            promptId: 'fix-issue',
            model: 'opus',
            permissionMode: 'acceptEdits',
            agent: null,
            worktree: true,
            mcp: [],
            tags: ['fix'],
          },
          null,
          2,
        ),
      },
      meta: {
        prompt: '',
        promptId: 'fix-issue',
        model: 'opus',
        permissionMode: 'acceptEdits',
        agent: null,
        worktree: true,
        mcp: [],
        tags: ['fix'],
      },
      at: ago(2 * DAY),
    },
    {
      kind: 'template',
      id: 'quick-review',
      name: 'Quick review (reviewer agent)',
      description: 'The reviewer agent on the current checkout, read-only plan mode.',
      files: {
        'quick-review.json': JSON.stringify(
          {
            name: 'Quick review (reviewer agent)',
            description: 'The reviewer agent on the current checkout, read-only plan mode.',
            prompt: 'Review the uncommitted changes.',
            promptId: null,
            model: 'sonnet',
            permissionMode: 'plan',
            agent: 'library:reviewer',
            worktree: false,
            mcp: [],
            tags: ['review'],
          },
          null,
          2,
        ),
      },
      meta: {
        prompt: 'Review the uncommitted changes.',
        promptId: null,
        model: 'sonnet',
        permissionMode: 'plan',
        agent: 'library:reviewer',
        worktree: false,
        mcp: [],
        tags: ['review'],
      },
      at: ago(DAY),
    },
    {
      kind: 'mcp',
      id: 'playwright',
      name: 'playwright',
      description: 'Browser automation over MCP.',
      files: {
        'playwright.json': JSON.stringify(
          {
            name: 'playwright',
            description: 'Browser automation over MCP.',
            type: 'stdio',
            command: 'npx',
            args: ['@playwright/mcp@latest'],
          },
          null,
          2,
        ),
      },
      meta: { type: 'stdio', command: 'npx', args: ['@playwright/mcp@latest'] },
      at: ago(7 * DAY),
    },
    {
      kind: 'mcp',
      id: 'docs',
      name: 'docs',
      description: 'Search the product docs.',
      files: {
        'docs.json':
          '{\n  "name": "docs",\n  "description": "Search the product docs.",\n  "type": "http",\n  "url": "https://mcp.example.com/docs",\n  "oauth": {\n    "scope": "read"\n  }\n}',
      },
      meta: { type: 'http', url: 'https://mcp.example.com/docs', oauth: { scope: 'read' } },
      at: ago(5 * DAY),
    },
    {
      kind: 'mcp',
      id: 'linear',
      name: 'linear',
      description: 'Issues and projects.',
      files: {
        'linear.json':
          '{\n  "name": "linear",\n  "description": "Issues and projects.",\n  "type": "http",\n  "url": "https://mcp.example.com/linear",\n  "oauth": {}\n}',
      },
      meta: { type: 'http', url: 'https://mcp.example.com/linear', oauth: {} },
      at: ago(4 * DAY),
    },
    {
      kind: 'mcp',
      id: 'github',
      name: 'github',
      description: 'GitHub API with a personal token.',
      files: {
        'github.json':
          '{\n  "name": "github",\n  "description": "GitHub API with a personal token.",\n  "type": "http",\n  "url": "https://mcp.example.com/github",\n  "headers": {\n    "Authorization": "Bearer ${secret:GITHUB_TOKEN}"\n  }\n}',
      },
      meta: {
        type: 'http',
        url: 'https://mcp.example.com/github',
        headers: { Authorization: 'Bearer ${secret:GITHUB_TOKEN}' },
      },
      at: ago(3 * DAY),
    },
    {
      kind: 'mcp',
      id: 'internal',
      name: 'internal',
      description: 'Internal service behind an API key.',
      files: {
        'internal.json':
          '{\n  "name": "internal",\n  "description": "Internal service behind an API key.",\n  "type": "http",\n  "url": "https://mcp.internal.example.com/mcp",\n  "headers": {\n    "X-Api-Key": "${secret:INTERNAL_KEY}"\n  }\n}',
      },
      meta: {
        type: 'http',
        url: 'https://mcp.internal.example.com/mcp',
        headers: { 'X-Api-Key': '${secret:INTERNAL_KEY}' },
      },
      at: ago(2 * DAY),
    },
    {
      kind: 'settings',
      id: 'safe-node',
      name: 'Safe Node defaults',
      description: 'Allow npm test/typecheck; deny rm -rf and git push.',
      files: {
        'safe-node.json': JSON.stringify(
          {
            name: 'Safe Node defaults',
            description: 'Allow npm test/typecheck; deny rm -rf and git push.',
            permissions: {
              allow: ['Bash(npm test:*)', 'Bash(npm run typecheck)'],
              deny: ['Bash(rm -rf:*)', 'Bash(git push:*)'],
            },
          },
          null,
          2,
        ),
      },
      meta: {
        permissions: {
          allow: ['Bash(npm test:*)', 'Bash(npm run typecheck)'],
          deny: ['Bash(rm -rf:*)', 'Bash(git push:*)'],
        },
      },
      at: ago(8 * DAY),
    },
  ]
  // Model the active library, including task text translated into skills.
  for (const source of [...lib]) {
    if (source.kind !== 'prompt' && source.kind !== 'command') continue
    const content = Object.values(source.files)[0] ?? ''
    lib.push({
      ...source,
      kind: 'skill',
      files: { 'SKILL.md': content.replace(/name: [^\n]*/, 'name: ' + source.id) },
      meta: {},
    })
  }
  lib.push({
    kind: 'plugin',
    id: 'release-helper',
    name: 'Release helper',
    description: 'Changelog, release notes and the publish MCP server.',
    files: {
      'plugin.json': JSON.stringify(
        {
          name: 'Release helper',
          description: 'Changelog, release notes and the publish MCP server.',
          version: '1.2.0',
          includes: [{ kind: 'skill', id: 'triage' }],
          source: { type: 'git', url: 'https://github.com/example/release-helper.git' },
        },
        null,
        2,
      ),
      'skills/release-notes/SKILL.md':
        '---\nname: release-notes\ndescription: Draft release notes from merged pull requests\n---\nList what changed, grouped by area.\n',
      'mcp/publish.json': JSON.stringify({ type: 'http', url: 'https://publish.example.com/mcp' }),
      'settings/guard.json': JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './guard.sh' }] }],
        },
      }),
    },
    meta: {
      version: '1.2.0',
      includes: [{ kind: 'skill', id: 'triage' }],
      source: { type: 'git', url: 'https://github.com/example/release-helper.git' },
      own: [
        {
          kind: 'skill',
          id: 'release-notes',
          name: 'release-notes',
          description: 'Draft release notes from merged pull requests',
          error: null,
        },
        { kind: 'mcp', id: 'publish', name: 'publish', description: '', error: null },
        { kind: 'settings', id: 'guard', name: 'guard', description: '', error: null },
      ],
    },
    at: ago(2 * DAY),
  })
  lib.push({
    kind: 'instruction',
    id: 'global',
    name: 'Global AGENTS.md',
    description: 'Default instructions for every session',
    files: { 'AGENTS.md': '# Global instructions\n\nFollow the project instructions.\n' },
    meta: {},
    at: ago(DAY),
  })
  for (let i = lib.length - 1; i >= 0; i--)
    if (['prompt', 'command', 'template'].includes(lib[i]!.kind)) lib.splice(i, 1)
  const library = lib.map(l => asset(l.kind, l.id, l.name, l.description, l.files, l.meta, l.at))
  const libraryFiles: Record<string, AssetFiles> = Object.fromEntries(
    lib.map(l => [`${l.kind}/${l.id}`, l.files]),
  )
  const libraryVersions: Record<string, AssetVersion[]> = Object.fromEntries(
    library.map(x => [
      `${x.kind}/${x.id}`,
      [{ version: x.version, firstSeenAt: x.updatedAt, sessionCount: 0 }],
    ]),
  )
  const versionFiles: Record<string, AssetFiles> = Object.fromEntries(
    library.map(x => [`${x.kind}/${x.id}@${x.version}`, libraryFiles[`${x.kind}/${x.id}`]!]),
  )
  // The reviewer agent has an older version, still installed in odin (update available).
  const reviewer = library.find(x => x.kind === 'agent' && x.id === 'reviewer')!
  const reviewerOld = fakeHash('agent/reviewer/old')
  libraryVersions['agent/reviewer']!.push({
    version: reviewerOld,
    firstSeenAt: ago(20 * DAY),
    sessionCount: 3,
  })
  libraryVersions['agent/reviewer']![0]!.sessionCount = 1
  versionFiles[`agent/reviewer@${reviewerOld}`] = { 'reviewer.md': AGENT_REVIEWER_OLD }
  const releaseNotes = library.find(x => x.kind === 'skill')!

  const installations: Installation[] = [
    {
      project: 'odin',
      kind: 'agent',
      id: 'reviewer',
      installedVersion: reviewerOld,
      libraryVersion: reviewer.version,
      projectVersion: reviewerOld,
      state: 'update-available',
      paths: ['.claude/agents/reviewer.md'],
      installedAt: ago(20 * DAY),
    },
    {
      project: 'odin',
      kind: 'skill',
      id: 'release-notes',
      installedVersion: releaseNotes.version,
      libraryVersion: releaseNotes.version,
      projectVersion: fakeHash('skill/release-notes/local'),
      state: 'modified',
      paths: ['.claude/skills/release-notes/SKILL.md', '.claude/skills/release-notes/template.md'],
      installedAt: ago(5 * DAY),
    },
    {
      project: 'odin',
      kind: 'skill',
      id: 'triage',
      installedVersion: library.find(x => x.id === 'triage')!.version,
      libraryVersion: library.find(x => x.id === 'triage')!.version,
      projectVersion: library.find(x => x.id === 'triage')!.version,
      state: 'current',
      paths: ['.claude/skills/triage/SKILL.md'],
      installedAt: ago(6 * DAY),
    },
    {
      project: 'rick',
      kind: 'settings',
      id: 'safe-node',
      installedVersion: library.find(x => x.id === 'safe-node')!.version,
      libraryVersion: library.find(x => x.id === 'safe-node')!.version,
      projectVersion: null,
      state: 'missing',
      paths: ['.claude/settings.json'],
      installedAt: ago(8 * DAY),
    },
  ]
  const projectFiles: Record<string, AssetFiles> = {
    'odin/agent/reviewer': { 'reviewer.md': AGENT_REVIEWER_OLD },
    'odin/skill/release-notes': {
      'SKILL.md': SKILL_RELEASE.replace('Group by type', 'Group by type and by area'),
      'template.md': '## {{version}}\n\n### Features\n\n### Fixes\n',
    },
    'odin/skill/triage': { 'SKILL.md': libraryFiles['skill/triage']!['SKILL.md']! },
  }

  const artifacts: Artifact[] = [
    {
      id: 1,
      project: 'odin',
      sessionId: s.idle,
      title: 'Pick a History layout',
      latestVersion: 1,
      createdAt: ago(2 * HOUR),
      updatedAt: ago(2 * HOUR),
    },
    // The ended session posted two artifacts, one of them twice: the artifact column shows tabs.
    {
      id: 2,
      project: 'odin',
      sessionId: s.ended,
      title: 'Removal checklist',
      latestVersion: 2,
      createdAt: ago(4 * DAY - 30 * MIN),
      updatedAt: ago(4 * DAY - 70 * MIN),
    },
    {
      id: 3,
      project: 'odin',
      sessionId: s.ended,
      title: 'Module dependency map',
      latestVersion: 1,
      createdAt: ago(4 * DAY - 50 * MIN),
      updatedAt: ago(4 * DAY - 50 * MIN),
    },
  ]
  const artifactVersions: ArtifactVersion[] = [
    {
      artifactId: 1,
      version: 1,
      createdAt: ago(2 * HOUR),
      bytes: ARTIFACT_HTML.length,
      note: 'Two layouts to choose from.',
    },
    {
      artifactId: 2,
      version: 1,
      createdAt: ago(4 * DAY - 30 * MIN),
      bytes: CHECKLIST_HTML(1).length,
      note: 'What goes.',
    },
    {
      artifactId: 2,
      version: 2,
      createdAt: ago(4 * DAY - 70 * MIN),
      bytes: CHECKLIST_HTML(2).length,
      note: 'Docs added.',
    },
    {
      artifactId: 3,
      version: 1,
      createdAt: ago(4 * DAY - 50 * MIN),
      bytes: DEPENDENCY_HTML.length,
      note: 'Remaining imports.',
    },
  ]
  // after the opening message, before the final answer
  transcripts[s.ended]!.splice(
    1,
    0,
    tool(
      'e1a',
      'mcp__odin__post_artifact',
      { title: 'Removal checklist', note: 'What goes.' },
      'Posted artifact 2 v1',
      ago(4 * DAY - 30 * MIN),
    ),
    tool(
      'e1b',
      'mcp__odin__post_artifact',
      { title: 'Module dependency map', note: 'Remaining imports.' },
      'Posted artifact 3 v1',
      ago(4 * DAY - 50 * MIN),
    ),
    tool(
      'e1c',
      'mcp__odin__post_artifact',
      { title: 'Removal checklist', note: 'Docs added.' },
      'Posted artifact 2 v2',
      ago(4 * DAY - 70 * MIN),
    ),
  )
  transcripts[s.idle]!.push(
    tool(
      'i4',
      'mcp__odin__post_artifact',
      { title: 'Pick a History layout', note: 'Two layouts to choose from.' },
      'Posted artifact 1 v1',
      ago(2 * HOUR),
    ),
  )

  const activityFixtures: TaskActivity[] = [
    {
      taskId: 'fixture-dev-server',
      runId: '1',
      kind: 'command',
      label: 'npm run dev:web',
      state: 'running',
      toolUseId: null,
      parentToolUseId: null,
      childSessionId: null,
      startedAt: ago(3 * MIN),
      completedAt: null,
      observedAt: ago(0),
      output: {
        ok: true,
        text: 'Local: http://localhost:5190/\nWaiting for changes…\n',
        truncated: false,
      },
    },
    {
      taskId: 'fixture-review',
      runId: '1',
      kind: 'agent',
      label: 'Review session accessibility',
      state: 'running',
      toolUseId: null,
      parentToolUseId: null,
      childSessionId: 'fixture-child-review',
      startedAt: ago(2 * MIN),
      completedAt: null,
      observedAt: ago(0),
      summary: 'Checking keyboard navigation and focus behavior.',
    },
    {
      taskId: 'fixture-tests',
      runId: '1',
      kind: 'command',
      label: 'npm test',
      state: 'completed',
      toolUseId: null,
      parentToolUseId: null,
      childSessionId: null,
      startedAt: ago(3 * MIN),
      completedAt: ago(MIN),
      observedAt: ago(MIN),
      output: { ok: true, text: 'All tests passed.\n', truncated: false },
    },
    {
      taskId: 'fixture-build',
      runId: '1',
      kind: 'command',
      label: 'Check production build',
      state: 'failed',
      toolUseId: null,
      parentToolUseId: null,
      childSessionId: null,
      startedAt: ago(5 * MIN),
      completedAt: ago(4 * MIN),
      observedAt: ago(4 * MIN),
      summary: 'The build reported a missing fixture dependency.',
      output: { ok: false, text: 'Missing fixture dependency\n', truncated: false },
    },
  ]
  for (const task of activityFixtures)
    transcripts[s.running]!.push({
      kind: 'task',
      id: taskKey(task),
      task,
      at: task.startedAt,
      parentToolUseId: task.parentToolUseId,
    })
  transcripts['fixture-child-review'] = [
    a(
      'fixture-child-1',
      'I am reviewing keyboard navigation. New task output leaves focus where the reader placed it.',
      ago(MIN),
    ),
  ]

  // ── activity (168 local days). The last 12 weeks are built from each project's own sessions, so totals agree with
  // Models and Typical session; odin also has older synthetic history so a 12-week range has a previous period.
  // Commits only for git folders.
  const activity: Record<string, ProjectActivityDay[]> = {}
  for (const p of projects) {
    const isGit = p.git.branch !== null || p.git.headSha !== null
    const days: ProjectActivityDay[] = []
    for (let i = 167; i >= 0; i--) {
      const d = new Date(now)
      d.setHours(12, 0, 0, 0)
      d.setDate(d.getDate() - i)
      const date = localDay(d)
      const h = parseInt(fakeHash(`${p.name}:${i}`).slice(0, 6), 16)
      const weekend = d.getDay() === 0 || d.getDay() === 6
      const commits = isGit
        ? p.name === 'odin'
          ? weekend
            ? 0
            : (h >> 16) % 6
          : !weekend && h % 9 === 0
            ? 1 + (h % 3)
            : 0
        : null
      if (p.name === 'odin' && i >= 84) {
        // older history, outside every range, so 12 weeks still has a previous period to compare with
        const n = h % 3 === 0 || (weekend && h % 2 === 0) ? 0 : (h >> 4) % 3
        days.push({
          date,
          sessions: n,
          activeMs: n * (((h >> 8) % 40) + 5) * MIN,
          costUsd: n ? Math.round(n * ((h >> 12) % 90) + 10) / 100 : null,
          commits,
          added: n * ((h >> 6) % 160),
          removed: n * ((h >> 10) % 60),
        })
        continue
      }
      const mine = sessions.filter(
        x =>
          !x.archived &&
          !x.aside &&
          x.projects.includes(p.name) &&
          localDay(new Date(x.updatedAt)) === date,
      )
      const costs = mine.map(x => x.metrics.costUsd).filter((c): c is number => c !== null)
      days.push({
        date,
        sessions: mine.length,
        activeMs: mine.reduce((t, x) => t + (x.metrics.activeMs ?? 0), 0),
        costUsd: costs.length ? costs.reduce((t, c) => t + c, 0) : null,
        commits,
        added: mine.reduce((t, x) => t + (x.metrics.diff?.added ?? 0), 0),
        removed: mine.reduce((t, x) => t + (x.metrics.diff?.removed ?? 0), 0),
      })
    }
    activity[p.name] = days
    p.activity = days.slice(-14).map(d => d.sessions)
  }

  // ── branches: current, merged, open PR, stale worktree ──
  const branches: Record<string, ProjectBranch[]> = {
    odin: [
      {
        name: 'main',
        headSha: 'a1b2c3d4e5f6',
        ahead: 0,
        behind: 0,
        merged: true,
        lastCommitAt: ago(2 * HOUR),
        worktreePath: `${root}/odin`,
        current: true,
        sessionIds: [s.idle, s.failed],
        pull: null,
      },
      {
        name: 'odin/remove-pi-c4e8a90d',
        headSha: 'b2c3d4e5f6a1',
        ahead: 0,
        behind: 12,
        merged: true,
        lastCommitAt: ago(4 * DAY),
        worktreePath: '/home/me/.odin/worktrees/odin/odin-remove-pi-c4e8a90d',
        current: false,
        sessionIds: [s.ended],
        pull: {
          number: 40,
          url: 'https://github.com/nurciuoli/odin/pull/40',
          state: 'closed',
          merged: true,
        },
      },
      {
        name: 'odin/permission-prompt-7b2d4e81',
        headSha: 'c3d4e5f6a1b2',
        ahead: 4,
        behind: 1,
        merged: false,
        lastCommitAt: ago(30 * MIN),
        worktreePath: '/home/me/.odin/worktrees/odin/odin-permission-prompt-7b2d4e81',
        current: false,
        sessionIds: [s.waiting],
        pull: {
          number: 42,
          url: 'https://github.com/nurciuoli/odin/pull/42',
          state: 'open',
          merged: false,
        },
      },
      {
        name: 'odin/keep-runner-1a2b3c4d',
        headSha: 'd4e5f6a1b2c3',
        ahead: 3,
        behind: 20,
        merged: false,
        lastCommitAt: ago(3 * DAY),
        worktreePath: '/home/me/.odin/worktrees/odin/odin-keep-runner',
        current: false,
        sessionIds: [s.forkFork, s.fork],
        pull: {
          number: 41,
          url: 'https://github.com/nurciuoli/odin/pull/41',
          state: 'closed',
          merged: false,
        },
      },
    ],
    harbor: [
      {
        name: 'main',
        headSha: '9a8b7c6d5e4f',
        ahead: 0,
        behind: 0,
        merged: true,
        lastCommitAt: ago(5 * DAY),
        worktreePath: null,
        current: true,
        sessionIds: [],
        pull: null,
      },
    ],
  }

  // A fork carries its parent's conversation as it was, then its own question and answer.
  transcripts[s.aside] = [
    // only what was stored when it forked (6 minutes ago)
    ...structuredClone(transcripts[s.running] ?? []).filter(e => !e.at || e.at <= ago(6 * MIN)),
    u('side-1', 'Does the thread keep scroll position on new entries?', ago(6 * MIN)),
    a(
      'side-2',
      'Yes. SessionThread only follows the bottom while you are already there; scrolled up, new entries add a "Jump to latest" button instead of moving the view.',
      ago(5 * MIN),
      'claude-haiku-5-5',
    ),
  ]

  return {
    projects,
    sessions,
    transcripts,
    pending,
    todos,
    library,
    libraryFiles,
    libraryVersions,
    versionFiles,
    installations,
    projectFiles,
    artifacts,
    artifactVersions,
    artifactHtml: {
      '1/1': ARTIFACT_HTML,
      '2/1': CHECKLIST_HTML(1),
      '2/2': CHECKLIST_HTML(2),
      '3/1': DEPENDENCY_HTML,
    },
    tracking: { odin: true, rick: false, harbor: false },
    activity,
    branches,
    models: MODELS,
    settings: {
      settings: {
        defaultModel: null,
        defaultPermissionMode: 'default',
        defaultWorktree: false,
        notifyOnWaiting: true,
        notifyOnFinished: true,
        launcherShortcut: 'CommandOrControl+Shift+Space',
        editorCommand: 'code',
        toolPaths: {},
      },
      pricing: { ...DEFAULT_PRICING },
      github: { configured: true, source: 'gh' },
      harnesses: [
        {
          id: 'opencode',
          name: 'OpenCode',
          available: true,
          note: 'Embedded native SDK',
          capabilities: {
            permissionModes: ['default'],
            permissionScopes: ['once', 'project'],
            native: {
              agents: true,
              variants: true,
              permissionRules: true,
              actions: [
                'compact',
                'revert',
                'unrevert',
                'commitRevert',
                'command',
                'shell',
                'updatePlugins',
                'reload',
              ],
            },
          },
        },
        {
          id: 'claude',
          name: 'Claude',
          available: true,
          note: 'Auth comes from your Claude Code login or ANTHROPIC_API_KEY.',
        },
        {
          id: 'codex',
          name: 'Codex',
          available: true,
          note: 'Uses the existing Codex installation and login.',
          capabilities: {
            permissionModes: ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'],
            permissionScopes: ['once', 'session'],
            settingsOnNextTurn: true,
          },
        },
        {
          id: 'grok',
          name: 'Grok',
          available: true,
          note: 'Uses the existing Grok Build installation and login',
          capabilities: {
            permissionModes: [
              'default',
              'acceptEdits',
              'plan',
              'dontAsk',
              'bypassPermissions',
              'auto',
            ],
            permissionScopes: ['once', 'session'],
          },
        },
        {
          id: 'antigravity',
          name: 'Antigravity',
          available: true,
          note: 'Uses existing Antigravity installation and login',
          capabilities: {
            permissionModes: [
              'default',
              'acceptEdits',
              'plan',
              'dontAsk',
              'bypassPermissions',
              'auto',
            ],
            permissionScopes: ['once', 'session', 'project'],
            additionalDirectories: true,
            instructions: true,
            attachments: true,
          },
        },
      ],
      libraryPath: '/home/me/.odin/library',
    },
  }
}

/** The fixture session ids by role, for tests and screenshots. */
export const FIXTURE_SESSION_IDS = {
  running: fakeUuid('s-running'),
  waiting: fakeUuid('s-waiting'),
  idle: fakeUuid('s-idle'),
  ended: fakeUuid('s-ended'),
  failed: fakeUuid('s-failed'),
  fork: fakeUuid('s-fork'),
  external: fakeUuid('s-external'),
  aside: fakeUuid('s-aside'),
}
