// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { previewDecorations } from './livePreview'

function decorations(doc: string, anchor: number, head = anchor) {
  const state = EditorState.create({
    doc,
    selection: { anchor, head },
    extensions: [EditorState.lineSeparator.of('\n'), markdown()],
  })
  const hidden: string[] = []
  const classes: string[] = []
  previewDecorations(state).between(0, state.doc.length, (from, to, decoration) => {
    if (!decoration.spec.class) hidden.push(state.sliceDoc(from, to))
    else classes.push(decoration.spec.class)
  })
  return { hidden, classes, source: state.sliceDoc() }
}

describe('Markdown live preview', () => {
  it('conceals inactive Markdown delimiters without changing any source bytes', () => {
    const source = '# Heading\r\n\r\n**strong** and *emphasis* and `code`\n\nEnd'
    const result = decorations(source, source.length)
    expect(result.hidden).toEqual(['# ', '**', '**', '*', '*', '`', '`'])
    expect(result.classes).toContain('iu-markdown-editor__heading-1')
    expect(result.source).toBe(source)
  })
  it('reveals syntax on the caret line and all selected lines', () => {
    const source = '# Heading\n\n**strong**\n\nEnd'
    expect(decorations(source, 3).hidden).toEqual(['**', '**'])
    expect(decorations(source, 3, 18).hidden).toEqual([])
  })
  it('does not interpret Markdown inside code fences or raw HTML', () => {
    const source = '```md\n# literal **text**\n```\n<script>alert(1)</script>\n\nEnd'
    const result = decorations(source, source.length)
    expect(result.hidden).toEqual([])
    expect(result.classes).not.toContain('iu-markdown-editor__heading-1')
    expect(result.source).toBe(source)
  })
  it('conceals inline link destinations, retaining reference and image source', () => {
    const source = '[site](https://example.com) [reference][id] ![image](image.png)\n\nEnd'
    expect(decorations(source, source.length).hidden).toEqual(['[', '](https://example.com)'])
    expect(decorations(source, 5).hidden).toEqual([])
  })
})
