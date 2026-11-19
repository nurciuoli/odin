// Lab only: a long mock session and the turn model the overlays read.
import type { TranscriptEntry } from '@odin/shared/harness'

const T0 = Date.parse('2026-11-18T09:12:00Z')
const at = (min: number) => new Date(T0 + min * 60_000).toISOString()
const u = (id: string, text: string, m: number): TranscriptEntry => ({ kind: 'user', id, text, at: at(m), parentToolUseId: null })
const a = (id: string, text: string, m: number): TranscriptEntry => ({ kind: 'assistant', id, text, model: 'claude-opus-5-5', at: at(m), parentToolUseId: null })
const t = (id: string, name: string, input: Record<string, unknown>, result: string | null, m: number, ok = true, parent: string | null = null): TranscriptEntry => ({
  kind: 'tool', id, name, input, ...(result === null ? {} : { result: { ok, text: result, truncated: false } }), at: at(m), parentToolUseId: parent,
})

export const transcript: TranscriptEntry[] = [
  u('u1', 'Add a retry policy to the GitHub sync client. Back off exponentially and stop on 4xx.', 0),
  t('u1a', 'Read', { file_path: 'packages/core/src/sync/github.ts' }, '// GitHub client…', 1),
  t('u1b', 'Grep', { pattern: 'fetchJson', path: 'packages/core/src' }, 'sync/github.ts:41', 1),
  a('u1c', 'The client calls `fetchJson` in four places. I will wrap it once in `withRetry` so every call gets the policy, and keep the 4xx cut-off there.', 2),
  t('u1d', 'Edit', { file_path: 'packages/core/src/sync/retry.ts', old_string: '', new_string: 'export async function withRetry…' }, 'Created', 4),
  t('u1e', 'Edit', { file_path: 'packages/core/src/sync/github.ts', old_string: 'fetchJson(', new_string: 'withRetry(() => fetchJson(' }, 'Edited', 5),
  a('u1f', 'Done: `withRetry` waits 250ms, 500ms, 1s, 2s with jitter, gives up after five tries, and never retries a 4xx.', 6),

  u('u2', 'Add tests, and make the delays injectable so they do not sleep.', 9),
  t('u2a', 'Edit', { file_path: 'packages/core/src/sync/retry.test.ts', old_string: '', new_string: 'test("backs off"…' }, 'Created', 11),
  t('u2b', 'Bash', { command: 'yarn workspace @odin/core test sync', description: 'Run sync tests' }, '✗ retries 5xx: expected 4 calls, got 5', 13, false),
  t('u2c', 'Edit', { file_path: 'packages/core/src/sync/retry.ts', old_string: '<= max', new_string: '< max' }, 'Edited', 14),
  t('u2d', 'Bash', { command: 'yarn workspace @odin/core test sync', description: 'Run sync tests' }, '✓ 14 tests', 15),
  a('u2e', 'Tests pass. The off-by-one was in the loop bound: five tries means four waits.', 16),

  u('u3', 'Does the web app show sync errors anywhere? I want a toast when it gives up.', 22),
  t('u3a', 'Agent', { description: 'Find where sync errors surface in web', subagent_type: 'Explore' }, 'Errors only reach the project Settings tab as a red line; there is no toast hook.', 24),
  t('u3b', 'Grep', { pattern: 'syncError', path: 'packages/web/src' }, 'screens/project/ProjectSettings.vue:88', 24, true, 'u3a'),
  a('u3c', 'Sync failures only show on the project Settings tab. A toast needs an SSE event first: `sync.failed`. That is a contract change in shared.', 27),

  u('u4', 'Go ahead, but keep the event payload tiny: project id and a reason string.', 33),
  t('u4a', 'Edit', { file_path: 'packages/shared/src/events.ts', old_string: 'type SseEvent =', new_string: "type SseEvent = | { type: 'sync.failed'; project: string; reason: string }" }, 'Edited', 35),
  t('u4b', 'Edit', { file_path: 'docs/contracts.md', old_string: '### sync', new_string: '### sync\n`sync.failed`' }, 'Edited', 36),
  t('u4c', 'Bash', { command: 'yarn typecheck', description: 'Type-check all packages' }, '✓ shared ✓ core ✓ web', 38),
  a('u4d', 'Event is in shared and documented. Core emits it when `withRetry` gives up; I have not touched web yet.', 40),

  u('u5', 'Now the toast. Quiet, one line, and it should link to the project settings.', 47),
  t('u5a', 'Edit', { file_path: 'packages/web/src/app/syncToast.ts', old_string: '', new_string: 'export function useSyncToast…' }, 'Created', 49),
  t('u5b', 'Edit', { file_path: 'packages/web/src/App.vue', old_string: '<RouterView', new_string: 'useSyncToast()\n<RouterView' }, 'Edited', 50),
  t('u5c', 'Bash', { command: 'yarn workspace @odin/web test', description: 'Run web tests' }, '✓ 231 tests', 53),
  t('u5d', 'Bash', { command: 'yarn workspace @odin/web shots /projects', description: 'Screenshot Projects' }, 'Wrote .shots/projects.png', 55),
  a('u5e', 'Toast is wired. It reads “Sync stopped for odin: GitHub returned 502” and its action opens Settings.', 57),

  u('u6', 'The reason string leaks the full URL. Trim it to the status and the host.', 64),
  t('u6a', 'Edit', { file_path: 'packages/core/src/sync/retry.ts', old_string: 'err.message', new_string: 'describeFailure(err)' }, 'Edited', 66),
  t('u6b', 'Bash', { command: 'yarn test', description: 'Run all tests' }, '✗ 2 failed: sync/retry.test.ts', 70, false),
  t('u6c', 'Edit', { file_path: 'packages/core/src/sync/retry.test.ts', old_string: 'api.github.com/repos', new_string: 'api.github.com' }, 'Edited', 71),
  t('u6d', 'Bash', { command: 'yarn test', description: 'Run all tests' }, '✓ 482 tests', 74),
  a('u6e', 'Trimmed: the reason now reads `502 from api.github.com`. Tests updated to match.', 75),

  u('u7', 'Great. Write the changelog fragment and summarise what changed for the PR body.', 82),
  t('u7a', 'Edit', { file_path: 'changes/feat-sync-retry.md', old_string: '', new_string: '- Sync retries with backoff and tells you when it gives up.' }, 'Created', 83),
  a('u7b', 'Fragment added. For the PR body: retry policy in core, new `sync.failed` event (contract), a quiet toast in web, reason string trimmed to status and host.', 85),
]

export interface Turn {
  n: number
  id: string
  prompt: string
  at: string
  min: number
  steps: number
  files: string[]
  failed: number
  agents: number
  reply: string
  /** a fork point: a place the user might rewind to */
  checkpoint: boolean
  tags: ('edit' | 'fail' | 'agent' | 'contract')[]
}

export function turns(): Turn[] {
  const out: Turn[] = []
  let cur: Turn | null = null
  let last = ''
  for (const e of transcript) {
    if (e.kind === 'user') {
      cur = { n: out.length + 1, id: e.id, prompt: e.text, at: e.at ?? '', min: (Date.parse(e.at ?? '') - T0) / 60000, steps: 0, files: [], failed: 0, agents: 0, reply: '', checkpoint: true, tags: [] }
      out.push(cur)
    } else if (cur && e.kind === 'tool') {
      cur.steps++
      if (e.name === 'Edit') {
        const f = String((e.input as { file_path?: string }).file_path ?? '')
        if (f && !cur.files.includes(f)) cur.files.push(f)
        if (/shared|contracts/.test(f) && !cur.tags.includes('contract')) cur.tags.push('contract')
      }
      if (e.result && !e.result.ok) cur.failed++
      if (e.name === 'Agent') cur.agents++
    } else if (cur && e.kind === 'assistant') cur.reply = e.text
    last = e.id
  }
  void last
  for (const t of out) {
    if (t.files.length) t.tags.unshift('edit')
    if (t.failed) t.tags.push('fail')
    if (t.agents) t.tags.push('agent')
  }
  return out
}
export const base = (f: string) => f.split('/').slice(-1)[0]!
export const clock = (iso: string) => iso.slice(11, 16)
export const strip = (s: string) => s.replace(/`/g, '')
