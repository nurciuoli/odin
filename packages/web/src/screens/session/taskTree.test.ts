import { describe, expect, it } from 'vitest'
import type { TaskActivity } from '@odin/shared/harness'
import { buildTaskTree, limitRows, placeTree, spanLabel, TREE_START_WINDOW_MS } from './taskTree'

const at = (s: number) => new Date(Date.UTC(2026, 10, 18, 12, 0, s)).toISOString()
const NOW = Date.parse(at(60))
function task(p: Partial<TaskActivity> & { taskId: string }): TaskActivity {
  return {
    runId: null,
    kind: 'agent',
    label: p.taskId,
    state: 'running',
    toolUseId: p.taskId,
    parentToolUseId: null,
    childSessionId: null,
    startedAt: at(0),
    completedAt: null,
    observedAt: null,
    ...p,
  }
}

describe('buildTaskTree', () => {
  it('nests a task under the one that started it, children right below their parent', () => {
    const nodes = buildTaskTree(
      [
        task({ taskId: 'a', startedAt: at(0) }),
        task({ taskId: 'b', startedAt: at(5) }),
        task({ taskId: 'a1', startedAt: at(10), parentToolUseId: 'a', kind: 'command' }),
      ],
      NOW,
    )
    expect(nodes.map(n => [n.label, n.depth])).toEqual([
      ['a', 0],
      ['a1', 1],
      ['b', 0],
    ])
    expect(nodes[1].parent).toBe(nodes[0].id)
  })

  it('keeps tasks whose parent is unknown or cyclic instead of losing them', () => {
    const nodes = buildTaskTree(
      [
        task({ taskId: 'x', parentToolUseId: 'y' }),
        task({ taskId: 'y', parentToolUseId: 'x' }),
        task({ taskId: 'z', parentToolUseId: 'missing' }),
      ],
      NOW,
    )
    expect(nodes.map(n => n.label).sort()).toEqual(['x', 'y', 'z'])
  })

  it('maps task states to the graph states', () => {
    const states = buildTaskTree(
      (['running', 'completed', 'failed', 'stopped', 'unknown'] as const).map(state =>
        task({ taskId: state, state }),
      ),
      NOW,
    ).map(n => n.state)
    expect(states.sort()).toEqual(['done', 'failed', 'running', 'stopped', 'unknown'])
  })
})

describe('placeTree', () => {
  it('makes a branch as long as its work, and never shorter than the minimum', () => {
    const nodes = buildTaskTree(
      [
        task({ taskId: 'long', startedAt: at(0), state: 'completed', completedAt: at(50) }),
        task({ taskId: 'blip', startedAt: at(10), state: 'completed', completedAt: at(10.1) }),
      ],
      NOW,
    )
    const { placed } = placeTree(nodes, NOW, { width: 100, row: 10, min: 6, pad: 0 })
    const len = (id: string) => {
      const p = placed.find(x => x.node.label === id)!
      return p.x1 - p.x0
    }
    expect(len('long')).toBeGreaterThan(len('blip'))
    expect(len('blip')).toBe(6)
  })

  it('draws a new run on a five-minute window so the head moves across', () => {
    const nodes = buildTaskTree([task({ taskId: 'a', startedAt: at(0) })], Date.parse(at(30)))
    const { trunkEnd } = placeTree(nodes, Date.parse(at(30)), {
      width: 300,
      row: 10,
      min: 4,
      pad: 0,
    })
    // 30s of the five-minute window, not the full width.
    expect(trunkEnd).toBeCloseTo((30 / (TREE_START_WINDOW_MS / 1000)) * 300)
    expect(trunkEnd).toBeLessThan(60)
  })

  it('fits the whole run once it is longer than five minutes', () => {
    const end = Date.parse(at(600))
    const nodes = buildTaskTree(
      [task({ taskId: 'a', startedAt: at(0), state: 'completed', completedAt: at(600) })],
      end,
    )
    const { trunkEnd } = placeTree(nodes, end, { width: 300, row: 10, min: 4, pad: 0 })
    expect(trunkEnd).toBeCloseTo(300)
  })

  it('forks a child from its parent lane and a root from the trunk', () => {
    const nodes = buildTaskTree(
      [task({ taskId: 'a' }), task({ taskId: 'b', parentToolUseId: 'a' })],
      NOW,
    )
    const { placed } = placeTree(nodes, NOW, { width: 100, row: 10, min: 4, pad: 0 })
    expect(placed[0].fromY).toBe(5)
    expect(placed[1].fromY).toBe(placed[0].y)
  })
})

describe('labels', () => {
  it('limits to the most recent rows and counts the rest', () => {
    const nodes = buildTaskTree(
      Array.from({ length: 5 }, (_, i) => task({ taskId: `t${i}`, startedAt: at(i) })),
      NOW,
    )
    const { shown, hidden } = limitRows(nodes, 3)
    expect(shown.map(n => n.label)).toEqual(['t2', 't3', 't4'])
    expect(hidden).toBe(2)
  })

  it('writes elapsed time in seconds, minutes, hours', () => {
    const n = buildTaskTree([task({ taskId: 'a', startedAt: at(0) })], NOW)[0]
    expect(spanLabel(n, NOW)).toBe('1m 0s')
    expect(spanLabel(n, Date.parse(at(9)))).toBe('9s')
    expect(spanLabel(n, Date.parse(at(3700)))).toBe('1h 1m')
  })
})
