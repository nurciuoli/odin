// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  ancestors,
  closeDoc,
  docId,
  emptyDocs,
  fileKind,
  notebookFileName,
  openDoc,
  parseIpynb,
  relativePath,
  replaceDoc,
} from './documents'

describe('document list', () => {
  it('opens once, brings an open document forward, and keeps keys stable', () => {
    let list = openDoc(emptyDocs(), { kind: 'file', path: 'a.md' })
    list = openDoc(list, { kind: 'notebook', kernelId: 'k' })
    const first = list.docs[0]!.key
    expect(list.active).toBe(list.docs[1]!.key)
    list = openDoc(list, { kind: 'file', path: 'a.md' })
    expect(list.docs).toHaveLength(2)
    expect(list.active).toBe(first)
    expect(list.docs[0]!.key).toBe(first)
  })
  it('adds without selecting when asked, but selects into an empty list', () => {
    let list = openDoc(emptyDocs(), { kind: 'file', path: 'a.md' }, false)
    expect(list.active).toBe(list.docs[0]!.key)
    list = openDoc(list, { kind: 'file', path: 'b.md' }, false)
    expect(list.active).toBe(list.docs[0]!.key)
  })
  it('closes the shown document onto its right neighbour, else the left', () => {
    let list = emptyDocs()
    for (const path of ['a', 'b', 'c']) list = openDoc(list, { kind: 'file', path })
    const [a, b, c] = list.docs.map(d => d.key) as [string, string, string]
    list = { ...list, active: b }
    list = closeDoc(list, b)
    expect(list.active).toBe(c)
    list = closeDoc(list, c)
    expect(list.active).toBe(a)
    list = closeDoc(list, a)
    expect(list.active).toBeNull()
  })
  it('lets the new-notebook page become its notebook in place', () => {
    let list = openDoc(emptyDocs(), { kind: 'new-notebook' })
    const key = list.docs[0]!.key
    list = replaceDoc(list, key, { kind: 'notebook', kernelId: 'k' })
    expect(list.docs).toEqual([{ key, ref: { kind: 'notebook', kernelId: 'k' } }])
    expect(docId(list.docs[0]!.ref)).toBe('notebook:k')
  })
})

describe('names', () => {
  it('relates paths to the working directory', () => {
    expect(relativePath('/work/odin/', '/work/odin/src/a.ts')).toBe('src/a.ts')
    expect(relativePath('C:\\work\\odin', 'C:\\work\\odin\\a.md')).toBe('a.md')
    expect(relativePath('/work/odin', 'docs/a.md')).toBe('docs/a.md')
    expect(ancestors('a/b/c.md')).toEqual(['a', 'a/b'])
  })
  it('reads a notebook as the file it is', () => {
    expect(notebookFileName('Analysis')).toBe('Analysis.ipynb')
    expect(notebookFileName('run.IPYNB')).toBe('run.IPYNB')
    expect(fileKind('x/run.ipynb')).toBe('notebook')
    expect(fileKind('d.TSV')).toBe('table')
  })
})

describe('parseIpynb', () => {
  it('reads nbformat 4 cells and their outputs', () => {
    const cells = parseIpynb(
      JSON.stringify({
        cells: [
          { cell_type: 'markdown', source: ['# A\n', 'b'] },
          {
            cell_type: 'code',
            id: 'x',
            execution_count: 3,
            source: 'print(1)',
            outputs: [
              { output_type: 'stream', name: 'stdout', text: ['1\n'] },
              { output_type: 'error', ename: 'E', evalue: 'bad', traceback: ['tb'] },
              { output_type: 'execute_result', data: { 'text/plain': ['1'] } },
              { output_type: 'unknown' },
            ],
          },
          { cell_type: 'raw', source: 'skip' },
        ],
      }),
    )!
    expect(cells).toHaveLength(2)
    expect(cells[0]).toMatchObject({ kind: 'markdown', source: '# A\nb', outputs: [] })
    expect(cells[1]).toMatchObject({ id: 'x', executionCount: 3 })
    expect(cells[1]!.outputs.map(o => o.type)).toEqual(['stream', 'error', 'display'])
  })
  it('is null for text that is not a notebook', () => {
    expect(parseIpynb('nope')).toBeNull()
    expect(parseIpynb('{"a":1}')).toBeNull()
  })
})
