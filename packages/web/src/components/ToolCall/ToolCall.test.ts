import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { IuToolCall, type ToolCallView } from './index'
import { toolPath, toolSummary } from './summary'
import { terminalShell, terminalView } from './terminal'

afterEach(() => vi.unstubAllGlobals())

describe('terminal presentation', () => {
  it('recognizes only a leading shell executable and preserves command source', () => {
    const command =
      '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command \'Get-Content a\''
    expect(terminalShell(command)).toBe('PowerShell')
    expect(terminalShell('echo powershell.exe')).toBeUndefined()
    expect(terminalShell('pwsh -Command "x"')).toBe('PowerShell')
    expect(terminalShell('cmd.exe /c echo hi')).toBe('Cmd')
    expect(terminalView({ name: 'Bash', input: { command } })?.command).toBe(command)
    expect(terminalView({ name: 'Bash', input: { command } })?.summary).toBe('Command')
  })
  it('uses supplied descriptions and original source lines rather than soft wrapping', () => {
    expect(
      terminalView({ name: 'Bash', input: { command: 'a\r\n  b\r\n', description: 'Run checks' } }),
    ).toMatchObject({ lines: 3, summary: 'Run checks' })
    expect(terminalView({ name: 'Bash', input: { command: 'x'.repeat(500) } })?.lines).toBe(1)
    expect(terminalView({ name: 'Bash', input: { command: 'a\nb' } })?.summary).toBe(
      'Multiline script',
    )
    expect(
      terminalView({
        name: 'run_terminal_command',
        input: { command: 'npm test\nnpm run build', description: 'Run the checks' },
      })?.summary,
    ).toBe('Run the checks')
    expect(
      terminalView({
        name: 'Execute `npm test\nnpm run build`',
        input: { description: 'npm test npm run build' },
      })?.summary,
    ).toBe('Multiline script')
  })
})

const sum = (name: string, input: Record<string, unknown>) => toolSummary({ name, input })

describe('toolSummary', () => {
  it('summarises each known tool', () => {
    expect(sum('Bash', { command: 'npm  test\n-- --run' })).toBe('npm test -- --run')
    expect(sum('Read', { file_path: '/a/b.ts' })).toBe('/a/b.ts')
    expect(sum('Write', { file_path: '/w.ts', content: 'x' })).toBe('/w.ts')
    expect(sum('Edit', { file_path: '/e.ts' })).toBe('/e.ts')
    expect(sum('Grep', { pattern: 'foo.*' })).toBe('foo.*')
    expect(sum('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts')
    expect(sum('Task', { description: 'Find it', subagent_type: 'explorer' })).toBe(
      'Find it (explorer)',
    )
    expect(sum('Agent', { description: 'Plan' })).toBe('Plan')
    expect(sum('WebFetch', { url: 'https://x.dev' })).toBe('https://x.dev')
    expect(sum('mcp__odin__post_artifact', { title: 't' })).toBe('odin › post_artifact')
    expect(sum('Custom', { n: 1, q: 'first string' })).toBe('first string')
    expect(sum('Custom', {})).toBe('')
    expect(sum('read_file', { target_file: '/repo/src/a.ts' })).toBe('/repo/src/a.ts')
    expect(sum('grep', { pattern: 'tool', path: 'src' })).toBe('tool')
    expect(sum('list_dir', { target_directory: '/repo/src' })).toBe('/repo/src')
    expect(sum('spawn_subagent', { description: 'Review the diff', prompt: 'x'.repeat(400) })).toBe(
      'Review the diff',
    )
    expect(sum('todo_write', { todos: [{}, {}] })).toBe('2 items')
    expect(sum('search_replace', { file_path: 'a.ts', old_string: 'a', new_string: 'b' })).toBe(
      'a.ts',
    )
    expect(sum('Custom', { prompt: 'y'.repeat(120) })).toBe(`${'y'.repeat(79)}…`)
  })
  it('shows file paths relative to a root, and leaves other summaries alone', () => {
    const root = 'C:\\Users\\me\\repo'
    expect(toolSummary({ name: 'Edit', input: { file_path: `${root}\\src\\a.ts` } }, root)).toBe(
      'src/a.ts',
    )
    expect(toolSummary({ name: 'Read', input: { file_path: '/elsewhere/b.ts' } }, '/repo')).toBe(
      '/elsewhere/b.ts',
    )
    expect(toolSummary({ name: 'Bash', input: { command: `cat ${root}\\a` } }, root)).toBe(
      `cat ${root}\\a`,
    )
    expect(toolPath({ name: 'Edit', input: { file_path: '/a.ts' } })).toBe('/a.ts')
    expect(toolPath({ name: 'Grep', input: { path: '/a' } })).toBeUndefined()
  })
})

const call = (over: Partial<ToolCallView> = {}): ToolCallView => ({
  id: 't1',
  name: 'Bash',
  input: { command: 'ls' },
  status: 'ok',
  ...over,
})

describe('IuToolCall', () => {
  it('routes nested command previews by their task identity without duplicating the parent action', async () => {
    const w = mount(IuToolCall, {
      props: {
        commandPreviews: { child: 'command:run-2' },
        call: call({
          name: 'Task',
          input: { description: 'Inspect' },
          children: [call({ id: 'child' })],
        }),
      },
    })
    expect(w.findAll('.iu-tool-call__preview')).toHaveLength(1)
    await w.find('.iu-tool-call__preview').trigger('click')
    expect(w.emitted('open-command')).toEqual([['command:run-2']])
  })
  it('keeps preview action as a sibling and independent of inline disclosure', async () => {
    const w = mount(IuToolCall, {
      props: { previewable: true, terminalSummary: 'Run checks', call: call() },
    })
    const row = w.find('.iu-tool-call__row')
    expect(row.findAll('button')).toHaveLength(2)
    expect(row.text()).toContain('Bash')
    expect(row.text()).toContain('Run checks')
    await w.find('.iu-tool-call__preview').trigger('click')
    expect(w.emitted('open-command')).toHaveLength(1)
    expect(w.find('.iu-tool-call__head').attributes('aria-expanded')).toBe('false')
  })
  it('preserves multiline source when copied or wrapped and keeps output independently collapsible', async () => {
    const command = "python - <<'PY'\n  print('hi')\nPY\n"
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const w = mount(IuToolCall, {
      props: {
        defaultOpen: true,
        call: call({ input: { command }, result: { text: 'hi', truncated: true } }),
      },
    })
    expect(w.find('.iu-tool-call__command').element.textContent).toBe(command)
    expect(w.find('.iu-tool-call__lines').text()).toBe('4L')
    const buttons = w.findAll('.iu-tool-call__actions button')
    await buttons[0]!.trigger('click')
    expect(w.find('.iu-tool-call__command').classes()).not.toContain('iu-tool-call__command--wrap')
    await buttons[1]!.trigger('click')
    expect(writeText).toHaveBeenCalledWith(command)
    await w.find('.iu-tool-call__output-toggle').trigger('click')
    expect(w.find('.iu-tool-call__output-toggle').attributes('aria-expanded')).toBe('false')
    expect(w.find('.iu-tool-call__head').attributes('aria-expanded')).toBe('true')
    expect(w.text()).toContain('Output truncated.')
    await w.setProps({ call: call({ input: { command }, result: { text: 'new output' } }) })
    expect(w.find('.iu-tool-call__output-toggle').attributes('aria-expanded')).toBe('false')
  })
  it('distinguishes empty captured output from unavailable output and command text', () => {
    const empty = mount(IuToolCall, {
      props: { defaultOpen: true, call: call({ result: { text: '' } }) },
    })
    expect(empty.text()).toContain('Completed with no output.')
    expect(empty.find('.iu-terminal-output').exists()).toBe(false)
    const missing = mount(IuToolCall, {
      props: { defaultOpen: true, call: call({ name: 'Terminal', input: {}, status: 'idle' }) },
    })
    expect(missing.text()).toContain('Command text is unavailable.')
    expect(missing.text()).toContain('Command output is unavailable.')
    expect(missing.find('.iu-tool-call__lines').exists()).toBe(false)
  })
  it('shows summary and status as text, expands on click', async () => {
    const w = mount(IuToolCall, { props: { call: call({ result: { text: 'a.txt' } }) } })
    const head = w.find('.iu-tool-call__head')
    expect(head.text()).toContain('ls')
    expect(head.text()).toContain('done')
    expect(head.attributes('aria-expanded')).toBe('false')
    expect(w.find('.iu-tool-call__body').attributes('style') ?? '').toContain('display: none')
    await head.trigger('click')
    expect(head.attributes('aria-expanded')).toBe('true')
    expect(w.find('.iu-tool-call__body').attributes('style') ?? '').not.toContain('display: none')
    expect(w.text()).toContain('a.txt')
  })
  it('opens by default with defaultOpen and uses the error tone when failed', () => {
    const w = mount(IuToolCall, {
      props: { defaultOpen: true, call: call({ status: 'failed', result: { text: 'boom' } }) },
    })
    expect(w.find('.iu-tool-call__head').attributes('aria-expanded')).toBe('true')
    expect(w.find('.iu-terminal-output--error').exists()).toBe(true)
    expect(w.text()).toContain('failed')
  })
  it('renders Edit as a diff', () => {
    const w = mount(IuToolCall, {
      props: {
        defaultOpen: true,
        call: call({
          name: 'Edit',
          input: { file_path: '/a.ts', old_string: 'one\ntwo', new_string: 'one\n2' },
        }),
      },
    })
    expect(w.find('.iu-diff').exists()).toBe(true)
    expect(w.findAll('[data-type="add"]')).toHaveLength(1)
    expect(w.findAll('[data-type="remove"]')).toHaveLength(1)
  })
  it('renders Write as all additions', () => {
    const w = mount(IuToolCall, {
      props: {
        defaultOpen: true,
        call: call({ name: 'Write', input: { file_path: '/n.ts', content: 'a\nb' } }),
      },
    })
    expect(w.findAll('[data-type="add"]')).toHaveLength(2)
  })
  it('nests children and collapses them', async () => {
    const w = mount(IuToolCall, {
      props: {
        call: call({
          name: 'Task',
          input: { description: 'Look' },
          children: [call({ id: 'c1', name: 'Read', input: { file_path: '/x' } })],
        }),
      },
    })
    const toggle = w.find('.iu-tool-call__toggle')
    expect(toggle.text()).toContain('1 nested call')
    expect(w.find('.iu-tool-call__children').attributes('style') ?? '').not.toContain(
      'display: none',
    )
    await toggle.trigger('click')
    expect(w.find('.iu-tool-call__children').attributes('style') ?? '').toContain('display: none')
  })
  it('shows a file path relative to the root, with the full path as a title, in nested calls too', () => {
    const w = mount(IuToolCall, {
      props: {
        root: '/home/me/repo',
        call: call({
          name: 'Task',
          input: { description: 'Look' },
          children: [
            call({ id: 'c1', name: 'Read', input: { file_path: '/home/me/repo/src/x.ts' } }),
          ],
        }),
      },
    })
    const path = w.find('.iu-tool-call__children .iu-file-path')
    expect(path.text()).toBe('src/x.ts')
    expect(path.attributes('title')).toBe('/home/me/repo/src/x.ts')
  })
})

describe('bare', () => {
  it('renders only the body: no head, always open, no nested list', () => {
    const call: ToolCallView = {
      id: 't',
      name: 'Bash',
      input: { command: 'npm test' },
      status: 'ok',
      result: { text: 'passed', truncated: false },
      children: [{ id: 'c', name: 'Read', input: { file_path: 'a.ts' }, status: 'ok' }],
    }
    const w = mount(IuToolCall, { props: { call, bare: true } })
    expect(w.find('.iu-tool-call__head').exists()).toBe(false)
    expect(w.find('.iu-tool-call__nested').exists()).toBe(false)
    expect(w.find('.iu-tool-call__body').isVisible()).toBe(true)
    expect(w.text()).toContain('npm test')
  })
})
