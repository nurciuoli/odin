import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { TaskActivity, TranscriptEntry } from '@odin/shared/harness'
import { taskKey } from '@odin/shared/harness'
import { IuToolCall } from '@/components/ToolCall'
import SessionThread from './SessionThread.vue'
import { buildRows, commandTaskView } from './sessionView'

const task = (patch: Partial<TaskActivity> = {}): TaskActivity => ({
  taskId: 'command',
  runId: 'one',
  kind: 'command',
  label: 'Run targeted tests',
  state: 'running',
  toolUseId: 'launch',
  parentToolUseId: null,
  childSessionId: null,
  startedAt: null,
  completedAt: null,
  observedAt: null,
  ...patch,
})

function rowsFor(command: TaskActivity, nested = false) {
  const entries: TranscriptEntry[] = [
    ...(nested
      ? [
          {
            kind: 'tool' as const,
            id: 'parent',
            name: 'Agent',
            input: {},
            at: null,
            parentToolUseId: null,
          },
        ]
      : []),
    {
      kind: 'tool',
      id: 'launch',
      name: 'Bash',
      input: { command: 'npm test\nexit $LASTEXITCODE', description: 'Run targeted tests' },
      result: { ok: true, text: 'Launched background command', truncated: false },
      at: null,
      parentToolUseId: nested ? 'parent' : null,
    },
    { kind: 'task', id: taskKey(command), task: command, at: null, parentToolUseId: null },
  ]
  return buildRows(entries, { pending: [], streaming: [], running: false, artifacts: [] })
}

describe('unified terminal process rows', () => {
  it.each(['running', 'completed', 'failed', 'stopped', 'unknown'] as const)(
    'uses the %s process lifecycle independently of successful launch',
    state => {
      const rows = rowsFor(task({ state }))
      expect(rows).toHaveLength(1)
      const row = rows[0]!
      if (row.kind !== 'tool') throw new Error('Expected linked tool')
      expect(row.call.status).toBe(
        {
          running: 'running',
          completed: 'ok',
          failed: 'failed',
          stopped: 'cancelled',
          unknown: 'idle',
        }[state],
      )
      expect(row.call.result).toBeUndefined()
      if (state === 'stopped') expect(row.call.statusText).toBe('Stopped')
      if (state === 'unknown') expect(row.call.statusText).toBe('Unknown')
    },
  )

  it('prefers authoritative process output including empty and truncated snapshots', () => {
    const rows = rowsFor(task({ output: { ok: true, text: '', truncated: true } }))
    const row = rows[0]!
    if (row.kind !== 'tool') throw new Error('Expected linked tool')
    expect(row.call.result).toEqual({ text: '', truncated: true })
  })

  it('renders one linked terminal as a rail step with the command and output as its body', async () => {
    const command = task()
    const wrapper = mount(SessionThread, { props: { rows: rowsFor(command), working: false } })
    expect(wrapper.findAll('.iu-rail__step')).toHaveLength(1)
    expect(wrapper.find('.iu-tool-call__preview').exists()).toBe(false)
    expect(wrapper.find('.iu-tool-call__head').exists()).toBe(false)
    expect(wrapper.find('.session-thread__task').exists()).toBe(false)
    const line = wrapper.find('button.iu-rail__line')
    expect(line.attributes('aria-expanded')).toBe('false')
    await line.trigger('click')
    expect(line.attributes('aria-expanded')).toBe('true')
    expect(wrapper.findComponent(IuToolCall).props('bare')).toBe(true)
    expect(wrapper.find('.iu-tool-call__command').text()).toContain('npm test')
    wrapper.unmount()
  })

  it('renders standalone description-only commands without inventing command source', async () => {
    const command = task({ toolUseId: null, state: 'unknown' })
    expect(commandTaskView(command)).toMatchObject({
      name: 'Terminal',
      input: {},
      statusText: 'Unknown',
    })
    const rows = buildRows(
      [{ kind: 'task', id: taskKey(command), task: command, at: null, parentToolUseId: null }],
      { pending: [], streaming: [], running: false, artifacts: [] },
    )
    const wrapper = mount(SessionThread, { props: { rows, working: false } })
    expect(wrapper.find('.iu-rail__target').text()).toBe(command.label)
    expect(wrapper.find('.iu-rail__meta').text()).toBe('Unknown')
    await wrapper.find('button.iu-rail__line').trigger('click')
    expect(wrapper.find('.iu-tool-call__empty').text()).toBe('Command text is unavailable.')
    expect(wrapper.find('.iu-tool-call__preview').exists()).toBe(false)
    wrapper.unmount()
  })

  it('merges nested process status and output into its tool row without a preview action', () => {
    const command = task({
      state: 'failed',
      output: { ok: false, text: 'Error', truncated: false },
    })
    const rows = rowsFor(command, true)
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    if (row.kind !== 'tool') throw new Error('Expected parent tool')
    expect(row.call.children?.[0]).toMatchObject({ status: 'failed', result: { text: 'Error' } })
    const wrapper = mount(SessionThread, { props: { rows, working: false } })
    // an agent's own steps stay out of the thread: they open in the preview pane
    expect(wrapper.find('.iu-rail__kids').exists()).toBe(false)
    expect(wrapper.find('.iu-tool-call__preview').exists()).toBe(false)
    expect(wrapper.find('.session-thread__task').exists()).toBe(false)
    wrapper.unmount()
  })
})

const agentTask = (patch: Partial<TaskActivity> = {}) =>
  task({
    kind: 'agent',
    taskId: 'agent',
    label: 'Explore',
    toolUseId: null,
    state: 'completed',
    ...patch,
  })

describe('the rail in the thread', () => {
  const ctx = { pending: [], streaming: [], running: false, artifacts: [] }
  const entry = (e: Partial<TranscriptEntry> & { kind: string; id: string }) =>
    ({ at: null, parentToolUseId: null, ...e }) as TranscriptEntry
  const read = (id: string) =>
    entry({
      kind: 'tool',
      id,
      name: 'Read',
      input: { file_path: `${id}.ts` },
      result: { ok: true, text: 'a\nb', truncated: false },
    })

  it('puts thinking and tools in one rail that folds once text follows', async () => {
    const entries = [
      entry({ kind: 'thinking', id: 'th', text: 'hmm' }),
      read('r1'),
      read('r2'),
      entry({ kind: 'assistant', id: 'done', text: 'Done', model: null }),
    ]
    const wrapper = mount(SessionThread, {
      props: { rows: buildRows(entries, ctx), entries, working: false },
    })
    expect(wrapper.findAll('.iu-rail')).toHaveLength(1)
    expect(
      wrapper.findAll('.iu-rail > .iu-rail__fold > div > .iu-rail__inner > .iu-rail__step'),
    ).toHaveLength(3)
    const sum = wrapper.find('.iu-rail__sum')
    expect(sum.text()).toContain('Worked')
    expect(sum.attributes('aria-expanded')).toBe('false')
    await sum.trigger('click')
    expect(wrapper.find('.iu-rail__sum').attributes('aria-expanded')).toBe('true')
    wrapper.unmount()
  })

  it('keeps a live run open with no summary', () => {
    const entries = [read('r1'), read('r2')]
    const wrapper = mount(SessionThread, {
      props: { rows: buildRows(entries, ctx), entries, working: true },
    })
    expect(wrapper.find('.iu-rail__sum').exists()).toBe(false)
    wrapper.unmount()
  })

  it('puts the working line at the end of a live run, with the agents that are out', () => {
    const agent = agentTask({ state: 'running' })
    const entries = [
      read('r1'),
      read('r2'),
      entry({ kind: 'task', id: taskKey(agent), task: agent } as never),
    ]
    const wrapper = mount(SessionThread, {
      props: { rows: buildRows(entries, { ...ctx, running: true }), entries, working: true },
    })
    const tail = wrapper.find('.iu-rail .iu-rail__tail')
    expect(tail.attributes('role')).toBe('status')
    expect(tail.text()).toBe('Working…')
    expect(tail.findAll('.iu-flock__agent')).toHaveLength(1)
    // one working line, not two
    expect(wrapper.find('.iu-message__working').exists()).toBe(false)
    wrapper.unmount()
  })

  it('keeps the working line on its own when no run is at the end of the thread', () => {
    const entries = [entry({ kind: 'user', id: 'u', text: 'hi' } as never)]
    const wrapper = mount(SessionThread, {
      props: { rows: buildRows(entries, ctx), entries, working: true },
    })
    expect(wrapper.find('.iu-message__working').text()).toBe('Working…')
    expect(wrapper.find('.iu-rail__tail').exists()).toBe(false)
    wrapper.unmount()
  })

  it('opens an agent and an artifact card from the rail', async () => {
    const agent = agentTask()
    const entries = [
      entry({ kind: 'task', id: taskKey(agent), task: agent } as never),
      entry({
        kind: 'tool',
        id: 'art',
        name: 'mcp__odin__post_artifact',
        input: { title: 'Layout' },
        result: { ok: true, text: 'Posted artifact 3 v2', truncated: false },
      }),
      entry({ kind: 'assistant', id: 'a', text: 'ok', model: null }),
    ]
    const wrapper = mount(SessionThread, {
      props: { rows: buildRows(entries, ctx), entries, working: false },
    })
    // an artifact keeps the run open
    expect(wrapper.find('.iu-rail__sum').attributes('aria-expanded')).toBe('true')
    const open = wrapper.findAll('button').find(b => b.text() === 'Open agent')!
    await open.trigger('click')
    expect(wrapper.emitted('open-task')?.[0]).toEqual([taskKey(agent)])
    const card = wrapper.findComponent({ name: 'ArtifactCard' })
    card.vm.$emit('open', 3, 2)
    expect(wrapper.emitted('open-artifact')?.[0]).toEqual([3, 2])
    wrapper.unmount()
  })
})

describe('opening a step in Files', () => {
  const edit: TranscriptEntry = {
    kind: 'tool',
    id: 'edit-1',
    name: 'Edit',
    input: { file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' },
    result: { ok: true, text: 'Edited', truncated: false },
    at: null,
    parentToolUseId: null,
  }
  const cell: TranscriptEntry = {
    kind: 'tool',
    id: 'cell-1',
    name: 'mcp__odin__notebook_execute',
    input: { kernel_id: 'k1', cell_id: 'c2' },
    result: { ok: true, text: 'Executed', truncated: false },
    at: null,
    parentToolUseId: null,
  }
  const entries = [edit, cell]

  it('opens the file or the cell a step worked on', async () => {
    const wrapper = mount(SessionThread, {
      props: {
        rows: buildRows(entries, { pending: [], streaming: [], running: false, artifacts: [] }),
        entries,
        working: false,
        root: '/repo',
      },
    })
    await wrapper.find('button[aria-label="Open src/a.ts in Files"]').trigger('click')
    expect(wrapper.emitted('open-file')).toEqual([['src/a.ts']])
    await wrapper.find('button[aria-label="Open this notebook cell in Files"]').trigger('click')
    expect(wrapper.emitted('open-cell')).toEqual([[{ kernelId: 'k1', cellId: 'c2' }]])
    wrapper.unmount()
  })
})
