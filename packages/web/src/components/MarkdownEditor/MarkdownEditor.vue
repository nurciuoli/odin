<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Compartment, EditorState, Transaction } from '@codemirror/state'
import { EditorView, drawSelection, keymap, placeholder } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown, markdownKeymap } from '@codemirror/lang-markdown'
import { livePreview } from './livePreview'

const props = withDefaults(
  defineProps<{
    mode?: 'live' | 'source'
    readonly?: boolean
    label?: string
  }>(),
  { mode: 'live', readonly: false, label: 'Markdown document' },
)
const model = defineModel<string>({ required: true })
const emit = defineEmits<{ selection: [text: string] }>()
const host = ref<HTMLElement>()
const presentation = new Compartment()
const permissions = new Compartment()
const attributes = new Compartment()
let view: EditorView | undefined

function editingPermissions() {
  return [EditorState.readOnly.of(props.readonly), EditorView.editable.of(!props.readonly)]
}

onMounted(() => {
  view = new EditorView({
    parent: host.value,
    state: EditorState.create({
      doc: model.value,
      extensions: [
        // A literal LF separator also retains CR bytes in mixed-line-ending documents.
        // Saving a small edit must not normalize every other line in the file.
        EditorState.lineSeparator.of('\n'),
        markdown(),
        history(),
        drawSelection(),
        keymap.of([...markdownKeymap, ...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        placeholder('Start writing…'),
        presentation.of(props.mode === 'live' ? livePreview : []),
        permissions.of(editingPermissions()),
        attributes.of(EditorView.contentAttributes.of({ 'aria-label': props.label })),
        EditorView.updateListener.of(update => {
          if (update.docChanged) model.value = update.state.sliceDoc()
          if (update.selectionSet || update.docChanged) {
            const range = update.state.selection.main
            emit('selection', update.state.sliceDoc(range.from, range.to))
          }
        }),
      ],
    }),
  })
})

watch(
  () => props.mode,
  mode => view?.dispatch({ effects: presentation.reconfigure(mode === 'live' ? livePreview : []) }),
)
watch(
  () => props.readonly,
  () => view?.dispatch({ effects: permissions.reconfigure(editingPermissions()) }),
)
watch(
  () => props.label,
  label =>
    view?.dispatch({
      effects: attributes.reconfigure(EditorView.contentAttributes.of({ 'aria-label': label })),
    }),
)
watch(model, value => {
  if (!view || value === view.state.sliceDoc()) return
  // Only callers deciding to reload/resolve a conflict replace the model externally.
  const head = Math.min(view.state.selection.main.head, value.length)
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: value },
    selection: { anchor: head },
    annotations: Transaction.addToHistory.of(false),
  })
})
onBeforeUnmount(() => view?.destroy())
</script>

<template>
  <div ref="host" class="iu-markdown-editor" :data-mode="mode" :data-readonly="readonly" />
</template>

<style>
.iu-markdown-editor {
  min-width: 0;
  min-height: 240px;
  color: var(--iu-text);
  background: var(--iu-ground);
}
.iu-markdown-editor .cm-editor {
  min-height: 240px;
  font-size: var(--iu-font-size-14);
}
.iu-markdown-editor .cm-scroller {
  font-family: var(--iu-font-sans);
  line-height: var(--iu-leading-code);
}
.iu-markdown-editor[data-mode='source'] .cm-scroller {
  font-family: var(--iu-font-mono);
}
.iu-markdown-editor .cm-content {
  padding: 20px 16px 48px;
  caret-color: var(--iu-accent);
}
.iu-markdown-editor .cm-editor.cm-focused {
  outline: none;
}
.iu-markdown-editor:focus-within {
  outline: var(--iu-focus-ring);
  outline-offset: calc(var(--iu-focus-offset) * -1);
}
.iu-markdown-editor .cm-content:focus-visible {
  outline: none;
}
.iu-markdown-editor .cm-cursor {
  border-left-color: var(--iu-accent);
}
.iu-markdown-editor .cm-selectionBackground,
.iu-markdown-editor .cm-focused .cm-selectionBackground {
  background: var(--iu-person-wash);
}
.iu-markdown-editor .cm-placeholder {
  color: var(--iu-text-muted);
}
.iu-markdown-editor__heading-1,
.iu-markdown-editor__heading-2 {
  font-size: var(--iu-font-size-24);
  font-weight: var(--iu-font-weight-semibold);
  line-height: var(--iu-leading-snug);
  padding-top: 12px;
  padding-bottom: 8px;
}
.iu-markdown-editor__heading-3,
.iu-markdown-editor__heading-4,
.iu-markdown-editor__heading-5,
.iu-markdown-editor__heading-6 {
  font-weight: var(--iu-font-weight-semibold);
  padding-top: 8px;
}
.iu-markdown-editor__bullet {
  color: var(--iu-text-muted);
  padding-right: 2px;
}
.iu-markdown-editor__strong {
  font-weight: var(--iu-font-weight-semibold);
}
.iu-markdown-editor__emphasis {
  font-style: italic;
}
.iu-markdown-editor__code,
.iu-markdown-editor__code-line {
  font-family: var(--iu-font-mono);
  background: var(--iu-well);
}
.iu-markdown-editor__code {
  border-radius: var(--iu-radius-xs);
}
.iu-markdown-editor__link {
  color: var(--iu-accent);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.iu-markdown-editor__quote {
  color: var(--iu-text-2);
  font-style: italic;
}
@media (prefers-reduced-motion: reduce) {
  .iu-markdown-editor .cm-cursorLayer {
    animation: none !important;
  }
}
</style>
