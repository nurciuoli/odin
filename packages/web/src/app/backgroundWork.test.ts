// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { countWork, describeWork, workTotal } from './backgroundWork'

describe('background work', () => {
  it('counts only running tasks, by kind', () => {
    const w = countWork([
      { kind: 'agent', state: 'running' },
      { kind: 'agent', state: 'running' },
      { kind: 'agent', state: 'completed' },
      { kind: 'command', state: 'running' },
      { kind: 'command', state: 'stopped' },
    ])
    expect(w).toEqual({ agents: 2, commands: 1 })
    expect(workTotal(w)).toBe(3)
  })
  it('says what runs', () => {
    expect(describeWork({ agents: 2, commands: 0 })).toBe('2 agents running')
    expect(describeWork({ agents: 1, commands: 0 })).toBe('1 agent running')
    expect(describeWork({ agents: 0, commands: 1 })).toBe('1 background command running')
    expect(describeWork({ agents: 1, commands: 2 })).toBe('1 agent and 2 commands running')
    expect(describeWork({ agents: 0, commands: 0 })).toBe('')
  })
})
