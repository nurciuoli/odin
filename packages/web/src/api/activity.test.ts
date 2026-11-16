// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { taskKey, type TaskActivity } from '@odin/shared/harness'
import { createHttpApi } from './http'
import { createMockApi } from './mock'
import { createFixtures, FIXTURE_SESSION_IDS } from './fixtures'

const task: TaskActivity = {
  taskId: 'agent/1',
  runId: 'run 2',
  kind: 'agent',
  label: 'Review',
  state: 'completed',
  toolUseId: null,
  parentToolUseId: null,
  childSessionId: 'child',
  startedAt: null,
  completedAt: null,
  observedAt: null,
}

it('encodes task run identities in the read-only history route', async () => {
  const fetcher = vi.fn(
    async (_url: string | URL | Request) =>
      new Response(JSON.stringify({ status: 'available', transcript: [] })),
  )
  const api = createHttpApi({ fetch: fetcher })
  await api.getSessionTask('parent/1', taskKey(task))
  expect(fetcher.mock.calls[0]?.[0]).toBe(
    `/api/sessions/parent%2F1/tasks/${encodeURIComponent(taskKey(task))}`,
  )
})

it('mock history reads only tasks associated with their parent', async () => {
  const fixtures = createFixtures()
  const parent = FIXTURE_SESSION_IDS.running
  fixtures.transcripts[parent]!.push({
    kind: 'task',
    id: taskKey(task),
    task,
    at: null,
    parentToolUseId: null,
  })
  fixtures.transcripts.child = [
    {
      kind: 'assistant',
      id: 'reply',
      text: 'Reviewed',
      model: null,
      at: null,
      parentToolUseId: null,
    },
  ]
  const api = createMockApi({ fixtures })
  expect(await api.getSessionTask(parent, taskKey(task))).toEqual({
    status: 'available',
    transcript: fixtures.transcripts.child,
  })
  await expect(api.getSessionTask(FIXTURE_SESSION_IDS.idle, taskKey(task))).rejects.toMatchObject({
    status: 404,
  })
})
