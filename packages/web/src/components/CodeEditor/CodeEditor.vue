<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Compartment, EditorState, Transaction } from '@codemirror/state'
import { EditorView, drawSelection, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { python } from '@codemirror/lang-python'
import { markdown } from '@codemirror/lang-markdown'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'

const props = withDefaults(
  defineProps<{ language?: 'python' | 'markdown'; readonly?: boolean; label?: string }>(),
  { language: 'python', readonly: false, label: 'Code cell' },
)
const model = defineModel<string>({ required: true })
const emit = defineEmits<{ run: [] }>()
const host = ref<HTMLElement>()
const permissions = new Compartment()
const languageCompartment = new Compartment()
const attributes = new Compartment()
let view: EditorView | undefined
const editing = () => [
  EditorState.readOnly.of(props.readonly),
  EditorView.editable.of(!props.readonly),
]
const syntax = () => (props.language === 'markdown' ? markdown() : python())
onMounted(() => {
  view = new EditorView({
    parent: host.value,
    state: EditorState.create({
      doc: model.value,
      extensions: [
        EditorState.lineSeparator.of('\n'),
        languageCompartment.of(syntax()),
        syntaxHighlighting(defaultHighlightStyle),
        history(),
        drawSelection(),
        lineNumbers(),
        EditorView.lineWrapping,
        permissions.of(editing()),
        attributes.of(EditorView.contentAttributes.of({ 'aria-label': props.label })),
        keymap.of([
          {
            key: 'Shift-Enter',
            run: () => {
              if (!props.readonly) emit('run')
              return true
            },
          },
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of(update => {
          if (update.docChanged) model.value = update.state.sliceDoc()
        }),
      ],
    }),
  })
})
watch(
  () => props.readonly,
  () => view?.dispatch({ effects: permissions.reconfigure(editing()) }),
)
watch(
  () => props.language,
  () => view?.dispatch({ effects: languageCompartment.reconfigure(syntax()) }),
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
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: value },
    annotations: Transaction.addToHistory.of(false),
  })
})
onBeforeUnmount(() => view?.destroy())
</script>
<template><div ref="host" class="iu-code-editor" /></template>
<style>
.iu-code-editor {
  min-width: 0;
  color: var(--iu-text);
  background: var(--iu-ground);
}
.iu-code-editor .cm-editor {
  font-size: var(--iu-font-size-13);
}
.iu-code-editor .cm-scroller {
  font-family: var(--iu-font-mono);
  line-height: var(--iu-leading-code);
}
.iu-code-editor .cm-content {
  padding: 12px 8px;
  min-height: 60px;
  caret-color: var(--iu-accent);
}
.iu-code-editor .cm-gutters {
  background: var(--iu-well);
  color: var(--iu-text-muted);
  border-right: 1px solid var(--iu-border-quiet);
}
.iu-code-editor .cm-editor.cm-focused {
  outline: none;
}
.iu-code-editor:focus-within {
  outline: 1px solid var(--iu-accent);
  outline-offset: -1px;
}
.iu-code-editor .cm-content:focus-visible {
  outline: none;
}
.iu-code-editor .cm-cursor {
  border-left-color: var(--iu-accent);
}
.iu-code-editor .cm-selectionBackground,
.iu-code-editor .cm-focused .cm-selectionBackground {
  background: var(--iu-person-wash);
}
@media (prefers-reduced-motion: reduce) {
  .iu-code-editor .cm-cursorLayer {
    animation: none !important;
  }
}
</style>
