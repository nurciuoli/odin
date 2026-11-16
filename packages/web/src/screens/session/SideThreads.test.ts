import { describe, expect, it } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import type { Session } from '@odin/shared/api'
import type { TranscriptEntry } from '@odin/shared/harness'
import { API_KEY } from '@/api'
import { FIXTURE_SESSION_IDS } from '@/api/fixtures'
import { createMockApi } from '@/api/mock'
import {
  lastReply,
  parseSideCommand,
  quote,
  sideEntries,
  sortSideThreads,
  upsertSideThread,
  useSideThreads,
} from './SideThreads'

const user = (id: string, text: string, at: string | null): TranscriptEntry => ({
  kind: 'user',
  id,
  text,
  at,
  parentToolUseId: null,
})
const assistant = (
  id: string,
  text: string,
  parentToolUseId: string | null = null,
): TranscriptEntry => ({
  kind: 'assistant',
  id,
  text,
  model: null,
  at: null,
  parentToolUseId,
})
const session = (id: string, o: Partial<Session> = {}) =>
  ({ id, parentId: 'p', aside: true, createdAt: '2026-01-01T00:00:00.000Z', ...o }) as Session

describe('side threads model', () => {
  it('reads /btw as a side question', () => {
    expect(parseSideCommand('/btw why is this slow?')).toBe('why is this slow?')
    expect(parseSideCommand('  /btw   two\nlines ')).toBe('two\nlines')
    expect(parseSideCommand('/btw')).toBeNull()
    expect(parseSideCommand('/btw   ')).toBeNull()
    expect(parseSideCommand('/btwx no')).toBeNull()
    expect(parseSideCommand('say /btw hi')).toBeNull()
  })

  it('keeps the newest first, adds, replaces, and drops promoted or foreign sessions', () => {
    const a = session('a', { createdAt: '2026-01-01T00:00:00.000Z' })
    const b = session('b', { createdAt: '2026-01-02T00:00:00.000Z' })
    expect(sortSideThreads([a, b]).map(s => s.id)).toEqual(['b', 'a'])
    let list = upsertSideThread([], a, 'p')
    list = upsertSideThread(list, b, 'p')
    expect(list.map(s => s.id)).toEqual(['b', 'a'])
    list = upsertSideThread(list, { ...a, title: 'renamed' }, 'p')
    expect(list.find(s => s.id === 'a')?.title).toBe('renamed')
    list = upsertSideThread(list, { ...b, aside: false }, 'p')
    expect(list.map(s => s.id)).toEqual(['a'])
    const same = upsertSideThread(list, session('c', { parentId: 'other' }), 'p')
    expect(same).toBe(list)
  })

  it('starts the side conversation at the first message after the fork', () => {
    const transcript = [
      user('u1', 'parent question', '2026-01-01T00:00:00.000Z'),
      assistant('a1', 'parent answer'),
      user('u2', 'side question', '2026-01-01T00:10:00.000Z'),
      assistant('a2', 'side answer'),
    ]
    const at = (createdAt: string, title = 'Renamed') => ({ createdAt, title })
    expect(sideEntries(transcript, at('2026-01-01T00:09:59.900Z')).map(e => e.id)).toEqual([
      'u2',
      'a2',
    ])
    // no timestamps to go by: everything
    expect(sideEntries(transcript, at('not a date'))).toEqual(transcript)
    expect(sideEntries([user('u', 'x', null)], at('2026-01-01T00:00:00.000Z'))).toHaveLength(1)
    // the default title names the question, even when a parent message's clock reads later than the fork's
    const late = [user('p', 'parent, late clock', '2026-01-01T00:11:00.000Z'), ...transcript]
    expect(
      sideEntries(late, at('2026-01-01T00:10:00.000Z', 'Side: side question')).map(e => e.id),
    ).toEqual(['u2', 'a2'])
    expect(sideEntries(late, at('2026-01-01T00:10:00.000Z')).map(e => e.id)[0]).toBe('p')
    // copied entries that keep their ids are the parent's, whatever the clocks say
    expect(
      sideEntries(late, at('2026-01-01T00:10:00.000Z'), new Set(['p', 'u1', 'a1'])).map(e => e.id),
    ).toEqual(['u2', 'a2'])
  })

  it("quotes the last turn's top-level reply", () => {
    expect(lastReply([user('u', 'q', null)])).toBeNull()
    expect(
      lastReply([
        user('u1', 'q1', null),
        assistant('a1', 'old'),
        user('u2', 'q2', null),
        assistant('a2', 'First part.'),
        assistant('sub', 'from a subagent', 'tool-1'),
        assistant('a3', 'Second part.'),
      ]),
    ).toBe('First part.\n\nSecond part.')
    expect(quote('Line one\n\nLine two\n')).toBe('> Line one\n>\n> Line two')
  })
})

describe('useSideThreads', () => {
  async function harness(parentId: string) {
    const api = createMockApi()
    const id = ref(parentId)
    let store!: ReturnType<typeof useSideThreads>
    const Host = defineComponent({
      setup() {
        store = useSideThreads(id)
        return () => h('div')
      },
    })
    const wrapper = mount(Host, { global: { provide: { [API_KEY as symbol]: api } } })
    await flushPromises()
    return { api, id, store, wrapper }
  }

  it("lists the session's side threads and follows forks, promotion and deletion", async () => {
    const { api, store, wrapper } = await harness(FIXTURE_SESSION_IDS.running)
    expect(store.phase.value).toBe('ready')
    expect(store.threads.value.map(s => s.id)).toEqual([FIXTURE_SESSION_IDS.aside])

    const side = await api.forkSession(FIXTURE_SESSION_IDS.running, {
      aside: true,
      prompt: { text: 'Why?' },
    })
    await flushPromises()
    expect(store.threads.value[0]?.id).toBe(side.id)

    await api.updateSession(side.id, { aside: false })
    await flushPromises()
    expect(store.threads.value.map(s => s.id)).toEqual([FIXTURE_SESSION_IDS.aside])

    await api.deleteSession(FIXTURE_SESSION_IDS.aside)
    await flushPromises()
    expect(store.threads.value).toEqual([])
    wrapper.unmount()
  })

  it('leaves ordinary forks out and reloads for another session', async () => {
    const { api, id, store, wrapper } = await harness(FIXTURE_SESSION_IDS.idle)
    await api.forkSession(FIXTURE_SESSION_IDS.idle, { prompt: { text: 'a plain fork' } })
    await flushPromises()
    expect(store.threads.value).toEqual([])
    id.value = FIXTURE_SESSION_IDS.running
    await flushPromises()
    expect(store.threads.value.map(s => s.id)).toEqual([FIXTURE_SESSION_IDS.aside])
    wrapper.unmount()
  })

  it('reports a failed list', async () => {
    const api = createMockApi()
    api.listSessions = () => Promise.reject(new Error('offline'))
    let store!: ReturnType<typeof useSideThreads>
    const Host = defineComponent({
      setup() {
        store = useSideThreads(ref('x'))
        return () => h('div')
      },
    })
    const wrapper = mount(Host, { global: { provide: { [API_KEY as symbol]: api } } })
    await flushPromises()
    expect(store.phase.value).toBe('error')
    expect(store.error.value).toBe('offline')
    wrapper.unmount()
  })
})
