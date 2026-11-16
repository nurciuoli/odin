import { afterEach, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { API_KEY } from '@/api'
import type { TaskActivity } from '@odin/shared/harness'
import TaskPreview from './TaskPreview.vue'

afterEach(() => vi.useRealTimers())
const task: TaskActivity = {
  taskId: 'child',
  runId: 'one',
  kind: 'agent',
  label: 'Review',
  state: 'running',
  toolUseId: null,
  parentToolUseId: null,
  childSessionId: 'child',
  startedAt: null,
  completedAt: null,
  observedAt: null,
}

it('refreshes the selected running child without overlapping requests and stops while hidden', async () => {
  vi.useFakeTimers()
  let resolve!: (value: unknown) => void
  const getSessionTask = vi.fn().mockResolvedValue({ status: 'available', transcript: [] })
  const wrapper = mount(TaskPreview, {
    props: { task, sessionId: 'parent', parentTitle: 'Parent', harness: 'codex' },
    global: {
      provide: { [API_KEY as symbol]: { getSessionTask } },
      stubs: { SessionThread: true },
    },
  })
  await flushPromises()
  getSessionTask.mockImplementationOnce(
    () =>
      new Promise(r => {
        resolve = r
      }),
  )
  await vi.advanceTimersByTimeAsync(3000)
  expect(getSessionTask).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(6000)
  expect(getSessionTask).toHaveBeenCalledTimes(2)
  resolve({ status: 'available', transcript: [] })
  await flushPromises()
  await wrapper.setProps({ active: false })
  await vi.advanceTimersByTimeAsync(6000)
  expect(getSessionTask).toHaveBeenCalledTimes(2)
  await wrapper.setProps({ active: true })
  await flushPromises()
  expect(getSessionTask).toHaveBeenCalledTimes(3)
  await wrapper.setProps({ task: { ...task, state: 'completed' } })
  await flushPromises()
  // One last read recovers the terminal reply; completed agents are no longer polled.
  expect(getSessionTask).toHaveBeenCalledTimes(4)
  await vi.advanceTimersByTimeAsync(6000)
  expect(getSessionTask).toHaveBeenCalledTimes(4)
  wrapper.unmount()
  expect(vi.getTimerCount()).toBe(0)
})
