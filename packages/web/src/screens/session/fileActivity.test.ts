// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { TranscriptEntry } from '@odin/shared/harness'
import { cellSteps, entryCell, entryFile, touchedFiles, workspacePath } from './fileActivity'

const tool = (
  id: string,
  name: string,
  input: Record<string, unknown>,
  result: { ok: boolean; text?: string } | null = { ok: true },
): TranscriptEntry => ({
  kind: 'tool',
  id,
  name,
  input,
  ...(result ? { result: { ok: result.ok, text: result.text ?? '', truncated: false } } : {}),
  at: null,
  parentToolUseId: null,
})
const ctx = { pending: [], running: false, root: '/work/repo' }

describe('touchedFiles', () => {
  it('orders files by last touch, newest first, and keeps every touch newest first', () => {
    const files = touchedFiles(
      [
        tool('1', 'Read', { file_path: '/work/repo/a.ts' }, { ok: true, text: 'x\ny' }),
        tool('2', 'Edit', { file_path: 'b.ts', old_string: 'a', new_string: 'b\nc' }),
        tool('3', 'Edit', { file_path: '/work/repo/a.ts', old_string: 'a', new_string: 'b' }),
        tool('4', 'Grep', { pattern: 'x' }),
      ],
      ctx,
    )
    expect(files.map(f => f.path)).toEqual(['a.ts', 'b.ts'])
    expect(files[0]!.touches.map(t => t.entryId)).toEqual(['3', '1'])
    expect(files[0]!.touches[1]!.meta).toBe('2 lines')
    expect(files[0]!.touches[0]!.verb.done).toBe('Edited')
    expect(files[0]!.changed).toBe(true)
  })

  it('says a failed edit failed and does not count it as a change', () => {
    const [file] = touchedFiles(
      [tool('1', 'Write', { file_path: 'a.ts', content: 'x' }, { ok: false, text: 'nope' })],
      ctx,
    )
    expect(file!.touches[0]!.meta).toBe('failed')
    expect(file!.changed).toBe(false)
  })

  it('marks files outside the working directory as not openable', () => {
    const [file] = touchedFiles([tool('1', 'Read', { file_path: '/etc/hosts' })], ctx)
    expect(file).toMatchObject({ path: '/etc/hosts', inside: false })
    expect(workspacePath('/etc/hosts', '/work/repo')).toBeNull()
    expect(workspacePath('../x.ts', '/work/repo')).toBeNull()
    expect(workspacePath('/work/repo/src/a.ts', '/work/repo')).toBe('src/a.ts')
  })

  it('names the workspace file an entry works on', () => {
    expect(entryFile(tool('1', 'Edit', { file_path: '/work/repo/a.ts' }), '/work/repo')).toBe(
      'a.ts',
    )
    expect(entryFile(tool('2', 'Bash', { command: 'ls' }), '/work/repo')).toBeNull()
  })
})

describe('notebook cells', () => {
  it('finds the cell from the input, or from the receipt for an appended cell', () => {
    expect(
      entryCell(
        tool('1', 'mcp__odin__notebook_execute', { kernel_id: 'k', cell_id: 'c', source: '1' }),
      ),
    ).toEqual({ kernelId: 'k', cellId: 'c' })
    expect(
      entryCell(
        tool(
          '2',
          'notebook_execute',
          { kernel_id: 'k', source: '1' },
          { ok: true, text: '{"cellId":"new"}' },
        ),
      ),
    ).toEqual({ kernelId: 'k', cellId: 'new' })
    expect(entryCell(tool('3', 'notebook_read', { kernel_id: 'k' }))).toBeNull()
  })

  it('keeps the latest step per cell', () => {
    const steps = cellSteps([
      tool('1', 'notebook_execute', { kernel_id: 'k', cell_id: 'c' }),
      tool('2', 'notebook_edit', { kernel_id: 'k', cell_id: 'c' }),
    ])
    expect(steps.get('k/c')).toBe('2')
  })
})
