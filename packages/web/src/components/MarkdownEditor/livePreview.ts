import { syntaxTree } from '@codemirror/language'
import type { EditorState, Range } from '@codemirror/state'
import { Decoration, type DecorationSet, ViewPlugin } from '@codemirror/view'

/** Reveal every line touched by a selection, including a collapsed caret. */
export function editingLine(state: EditorState, from: number, to: number): boolean {
  const first = state.doc.lineAt(from).number
  const last = state.doc.lineAt(to).number
  return state.selection.ranges.some(range => {
    const start = state.doc.lineAt(range.from).number
    const end = state.doc.lineAt(range.to).number
    return start <= last && end >= first
  })
}

/** Decorations never modify the document or interpret Markdown as HTML. */
export function previewDecorations(
  state: EditorState,
  viewport = { from: 0, to: state.doc.length },
): DecorationSet {
  const ranges: Range<Decoration>[] = []
  const mark = (from: number, to: number, className: string) => {
    if (to > from) ranges.push(Decoration.mark({ class: className }).range(from, to))
  }
  const hide = (from: number, to: number) => {
    if (to > from && !editingLine(state, from, to))
      ranges.push(Decoration.replace({}).range(from, to))
  }
  syntaxTree(state).iterate({
    from: viewport.from,
    to: viewport.to,
    enter(node) {
      const { name, from, to } = node
      const heading = /^ATXHeading([1-6])$/.exec(name)
      if (heading) {
        ranges.push(
          Decoration.line({ class: `iu-markdown-editor__heading-${heading[1]}` }).range(
            state.doc.lineAt(from).from,
          ),
        )
      }
      if (name === 'HeaderMark') {
        const after = state.sliceDoc(to, Math.min(to + 1, state.doc.length))
        hide(from, to + (after === ' ' ? 1 : 0))
      } else if (name === 'StrongEmphasis') {
        mark(from, to, 'iu-markdown-editor__strong')
      } else if (name === 'Emphasis') {
        mark(from, to, 'iu-markdown-editor__emphasis')
      } else if (name === 'InlineCode') {
        mark(from, to, 'iu-markdown-editor__code')
      } else if (name === 'EmphasisMark' || name === 'CodeMark') {
        hide(from, to)
      } else if (name === 'Link') {
        mark(from, to, 'iu-markdown-editor__link')
        // Only inline links have a destination to conceal. Reference links remain literal.
        const value = state.sliceDoc(from, to)
        const labelEnd = value.lastIndexOf('](')
        if (labelEnd > 0 && value.startsWith('[') && value.endsWith(')')) {
          hide(from, from + 1)
          hide(from + labelEnd, to)
        }
        return false
      } else if (name === 'FencedCode' || name === 'CodeBlock') {
        const first = state.doc.lineAt(from).number
        const last = state.doc.lineAt(to).number
        for (let line = first; line <= last; line++) {
          ranges.push(
            Decoration.line({ class: 'iu-markdown-editor__code-line' }).range(
              state.doc.line(line).from,
            ),
          )
        }
        return false
      } else if (name === 'Blockquote') {
        mark(from, to, 'iu-markdown-editor__quote')
      }
    },
  })
  return Decoration.set(ranges, true)
}

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: import('@codemirror/view').EditorView) {
      this.decorations = previewDecorations(view.state, view.viewport)
    }
    update(update: import('@codemirror/view').ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = previewDecorations(update.state, update.view.viewport)
      }
    }
  },
  { decorations: value => value.decorations },
)
