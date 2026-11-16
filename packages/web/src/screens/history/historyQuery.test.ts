// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { Session } from '@odin/shared/api'
import { createMockApi } from '@/api/mock'
import {
  applyClauses,
  filterFields,
  queryFromState,
  sameQuery,
  stateFromQuery,
} from './historyQuery'

describe('History URL state', () => {
  it('round-trips query → state → query', () => {
    const query = {
      q: 'slow',
      archived: '1',
      f: [
        'state:is:failed,idle',
        'updated:inLast:7 days',
        'tag:empty:true',
        'updated:after:2026-10-01',
      ],
    }
    const state = stateFromQuery(query)
    expect(state.q).toBe('slow')
    expect(state.archived).toBe(true)
    expect(state.clauses).toEqual([
      { key: 'state', op: 'is', value: ['failed', 'idle'] },
      { key: 'updated', op: 'inLast', value: { n: 7, unit: 'days' } },
      { key: 'tag', op: 'empty', value: true },
      { key: 'updated', op: 'after', value: '2026-10-01' },
    ])
    expect(sameQuery(queryFromState(state), query)).toBe(true)
  })

  it('drops junk and unfinished clauses', () => {
    const state = stateFromQuery({ f: ['nope:is:x', 'state:wat:x', 'state', 'updated:inLast:abc'] })
    expect(state.clauses).toEqual([])
    expect(
      queryFromState({
        q: '',
        archived: false,
        clauses: [{ key: 'state', op: 'is', value: null }],
      }),
    ).toEqual({})
  })
})

describe('History filtering', () => {
  async function all(): Promise<Session[]> {
    return createMockApi().listSessions({ archived: false })
  }

  it('filters by state, project, and isNot', async () => {
    const sessions = await all()
    const failed = applyClauses(sessions, [{ key: 'state', op: 'is', value: ['failed'] }])
    expect(failed.length).toBeGreaterThan(0)
    expect(failed.every(s => s.state === 'failed')).toBe(true)
    const notOdin = applyClauses(sessions, [{ key: 'project', op: 'isNot', value: ['odin'] }])
    expect(notOdin.every(s => s.project !== 'odin')).toBe(true)
  })

  it('filters by date and ignores pending clauses', async () => {
    const sessions = await all()
    const now = Date.now()
    const recent = applyClauses(
      sessions,
      [{ key: 'updated', op: 'inLast', value: { n: 1, unit: 'hours' } }],
      now,
    )
    expect(recent.every(s => now - Date.parse(s.updatedAt) <= 3_600_000)).toBe(true)
    expect(applyClauses(sessions, [{ key: 'state', op: 'is', value: null }])).toHaveLength(
      sessions.length,
    )
  })

  it('offers options from the data', async () => {
    const sessions = await all()
    const fields = filterFields(sessions, [{ name: 'odin', title: 'Odin' }])
    expect(fields.map(f => f.key)).toEqual([
      'project',
      'state',
      'tag',
      'model',
      'origin',
      'updated',
    ])
    expect(fields.find(f => f.key === 'model')!.options!.length).toBeGreaterThan(0)
  })
})
