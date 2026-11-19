<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { statusLabel } from '@/styles/status'
import IuStatusDot from '@/components/StatusDot/StatusDot.vue'
import IuIcon from '@/components/Icon/Icon.vue'
import IuCodeBlock from '@/components/CodeBlock/CodeBlock.vue'
import IuDiff from '@/components/CodeBlock/Diff.vue'
import { diffLines } from '@/components/CodeBlock/diffLines'
import IuTerminalOutput from '@/components/TerminalOutput/TerminalOutput.vue'
import IuFilePath from '@/components/FilePath/FilePath.vue'
import { useCopy } from '@/composables/useCopy'
import { terminalView } from './terminal'
import { presentTool, toolPath, toolSummary, toolTitle } from './summary'
import type { ToolCallView } from './types'

defineOptions({ name: 'IuToolCall' })

const props = withDefaults(
  defineProps<{
    call: ToolCallView
    defaultOpen?: boolean
    /** Directory file paths are shown relative to (the session's cwd or worktree); nested calls inherit it. */
    root?: string | null
    previewable?: boolean
    terminalSummary?: string
    commandPreviews?: Record<string, string>
    /** Render only the body (diff, command and output, input): a host that owns the head, like a rail step. */
    bare?: boolean
  }>(),
  { defaultOpen: false, root: null, previewable: false, terminalSummary: undefined, bare: false },
)

const emit = defineEmits<{ 'open-command': [id?: string] }>()

// initial state only; the toggle owns it afterwards
// eslint-disable-next-line vue/no-setup-props-reactivity-loss
const open = ref(props.defaultOpen)
const childrenOpen = ref(true)
const outputOpen = ref(true)
const wrap = ref(true)
const { copied, copy } = useCopy()
const bodyId = `${useId()}-body`
const outputId = `${useId()}-output`

const shown = computed(() => presentTool(props.call))
const terminal = computed(() => terminalView(shown.value))
const title = computed(() => terminal.value?.shell ?? toolTitle(shown.value.name))
const summary = computed(() =>
  terminal.value
    ? props.terminalSummary || terminal.value.summary
    : toolSummary(shown.value, props.root),
)
const path = computed(() => toolPath(shown.value))
const failed = computed(() => props.call.status === 'failed')

const str = (v: unknown) => (typeof v === 'string' ? v : '')

// Edit/Write/MultiEdit show as a diff of the change; other input as JSON
const diff = computed(() => {
  const { name, input } = shown.value
  if (name === 'Edit') return diffLines(str(input.old_string), str(input.new_string))
  if (name === 'Write') return diffLines('', str(input.content))
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    return input.edits.flatMap((e: Record<string, unknown>) =>
      diffLines(str(e?.old_string), str(e?.new_string)),
    )
  }
  return undefined
})
const command = computed(() => terminal.value?.command ?? '')
const inputText = computed(() => JSON.stringify(props.call.input, null, 2) ?? '')
const showInput = computed(() => !terminal.value && !diff.value && inputText.value !== '{}')
const children = computed(() => props.call.children ?? [])
</script>

<template>
  <div class="iu-tool-call" :data-status="call.status">
    <div v-if="!bare" class="iu-tool-call__row">
      <button
        type="button"
        class="iu-tool-call__head"
        :aria-expanded="open"
        :aria-controls="bodyId"
        :title="terminal ? summary : undefined"
        @click="open = !open"
      >
        <IuIcon :name="open ? 'chevronDown' : 'chevronRight'" :size="14" />
        <span class="iu-tool-call__name">{{ title }}</span>
        <span v-if="path" class="iu-tool-call__summary"
          ><IuFilePath :path="path" :root="root"
        /></span>
        <span v-else-if="summary" class="iu-tool-call__summary">{{ summary }}</span>
        <span
          v-if="terminal?.lines"
          class="iu-tool-call__lines"
          :title="`${terminal.lines} source lines`"
          >{{ terminal.lines }}L</span
        >
        <span class="iu-tool-call__status">
          <IuStatusDot :status="call.status" :size="7" decorative />
          {{ call.statusText ?? statusLabel[call.status] }}
        </span>
      </button>
      <button
        v-if="terminal && (previewable || commandPreviews?.[call.id])"
        type="button"
        class="iu-tool-call__preview"
        :aria-label="`Open command: ${summary}`"
        @click="emit('open-command', commandPreviews?.[call.id])"
      >
        Open command
      </button>
    </div>

    <div
      v-show="bare || open"
      :id="bodyId"
      class="iu-tool-call__body"
      :class="{ 'iu-tool-call__body--bare': bare }"
    >
      <div v-if="terminal" class="iu-tool-call__terminal">
        <div class="iu-tool-call__toolbar">
          <span
            >{{ bare ? terminal.shell : 'Command'
            }}<template v-if="terminal.lines">
              · {{ terminal.lines }} source {{ terminal.lines === 1 ? 'line' : 'lines' }}</template
            ></span
          >
          <div v-if="command" class="iu-tool-call__actions">
            <button type="button" :aria-pressed="wrap" @click="wrap = !wrap">
              Wrap {{ wrap ? 'on' : 'off' }}
            </button>
            <button type="button" @click="copy(command)">
              {{ copied ? 'Copied' : 'Copy command' }}
            </button>
          </div>
        </div>
        <span class="iu-tool-call__sr" role="status">{{ copied ? 'Command copied' : '' }}</span>
        <pre
          v-if="command"
          class="iu-tool-call__command"
          :class="{ 'iu-tool-call__command--wrap': wrap }"
          tabindex="0"
          aria-label="Full command"
          >{{ command }}</pre
        >
        <p v-else class="iu-tool-call__empty">Command text is unavailable.</p>
        <div class="iu-tool-call__output">
          <button
            type="button"
            class="iu-tool-call__output-toggle"
            :aria-expanded="outputOpen"
            :aria-controls="outputId"
            @click="outputOpen = !outputOpen"
          >
            <IuIcon :name="outputOpen ? 'chevronDown' : 'chevronRight'" :size="14" /> Output
          </button>
          <div v-show="outputOpen" :id="outputId">
            <IuTerminalOutput
              v-if="call.result && (call.result.text || call.result.truncated)"
              :text="call.result.text"
              :truncated="call.result.truncated"
              :tone="failed ? 'error' : 'default'"
              embedded
            />
            <p v-else class="iu-tool-call__empty">
              {{
                call.result
                  ? call.status === 'ok'
                    ? 'Completed with no output.'
                    : 'No output was captured.'
                  : call.status === 'running'
                    ? 'Waiting for output…'
                    : 'Command output is unavailable.'
              }}
            </p>
          </div>
        </div>
      </div>
      <IuDiff v-if="diff" :hunks="diff" :filename="summary || undefined" max-height="260px" />
      <IuCodeBlock v-if="showInput" :code="inputText" language="json" max-height="200px" />
      <IuTerminalOutput
        v-if="!terminal && call.result"
        :text="call.result.text"
        :truncated="call.result.truncated"
        :tone="failed ? 'error' : 'default'"
      />
    </div>

    <div v-if="children.length && !bare" class="iu-tool-call__nested">
      <button
        type="button"
        class="iu-tool-call__toggle"
        :aria-expanded="childrenOpen"
        @click="childrenOpen = !childrenOpen"
      >
        <IuIcon :name="childrenOpen ? 'chevronDown' : 'chevronRight'" :size="14" />
        {{ children.length }} nested {{ children.length === 1 ? 'call' : 'calls' }}
      </button>
      <div v-show="childrenOpen" class="iu-tool-call__children">
        <IuToolCall
          v-for="c in children"
          :key="c.id"
          :call="c"
          :root="root"
          :command-previews="commandPreviews"
          @open-command="emit('open-command', $event)"
        />
      </div>
    </div>
  </div>
</template>

<style>
.iu-tool-call {
  min-width: 0;
  font-size: var(--iu-font-size-13);
  container-type: inline-size;
}

.iu-tool-call__row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.iu-tool-call__row > .iu-tool-call__head {
  flex: 1;
  width: auto;
}
.iu-tool-call__preview {
  flex: none;
  white-space: nowrap;
}
.iu-tool-call__preview,
.iu-tool-call__actions button,
.iu-tool-call__output-toggle {
  border: none;
  background: transparent;
  color: var(--iu-text-muted);
  font: inherit;
  font-size: var(--iu-font-size-11-5);
  padding: 4px 6px;
  border-radius: var(--iu-radius-sm);
  cursor: pointer;
}
.iu-tool-call__preview:hover,
.iu-tool-call__actions button:hover,
.iu-tool-call__output-toggle:hover {
  background: var(--iu-surface);
  color: var(--iu-text);
}
.iu-tool-call__preview:focus-visible,
.iu-tool-call__actions button:focus-visible,
.iu-tool-call__output-toggle:focus-visible,
.iu-tool-call__command:focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: var(--iu-focus-offset);
}
.iu-tool-call__lines {
  flex: none;
  font: var(--iu-font-size-11) / var(--iu-leading-normal) var(--iu-font-mono);
  color: var(--iu-text-muted);
}
.iu-tool-call__terminal {
  overflow: hidden;
  border: 1px solid var(--iu-border);
  border-radius: var(--iu-radius-md);
  background: var(--iu-well);
}
.iu-tool-call__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--iu-hairline);
  color: var(--iu-text-muted);
  font-size: var(--iu-font-size-11);
}
.iu-tool-call__actions {
  display: flex;
  gap: 4px;
}
.iu-tool-call__command {
  margin: 0;
  padding: 12px;
  max-height: 320px;
  overflow: auto;
  white-space: pre;
  font: var(--iu-font-size-12) / var(--iu-leading-code) var(--iu-font-mono);
}
.iu-tool-call__command--wrap {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.iu-tool-call__output {
  border-top: 1px solid var(--iu-hairline);
}
.iu-tool-call__output-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  text-align: left;
  padding: 8px 10px;
}
.iu-tool-call__empty {
  margin: 0;
  padding: 8px 12px 12px;
  color: var(--iu-text-muted);
  font-size: var(--iu-font-size-12);
}
.iu-tool-call__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.iu-tool-call__head,
.iu-tool-call__toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  padding: 4px 6px;
  border: none;
  border-radius: var(--iu-radius-sm);
  background: transparent;
  color: var(--iu-text-2);
  font-family: var(--iu-font-sans);
  font-size: inherit;
  text-align: left;
  cursor: pointer;
}

.iu-tool-call__head:hover,
.iu-tool-call__toggle:hover {
  background: var(--iu-surface);
}

.iu-tool-call__head:focus-visible,
.iu-tool-call__toggle:focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: var(--iu-focus-offset);
}

.iu-tool-call__name {
  flex: none;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  color: var(--iu-text);
}

.iu-tool-call__summary {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}

.iu-tool-call__status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  margin-left: auto;
  font-size: var(--iu-font-size-11-5);
  color: var(--iu-text-muted);
}

.iu-tool-call[data-status='failed'] > .iu-tool-call__row .iu-tool-call__status {
  color: var(--iu-danger);
}

.iu-tool-call__body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 6px 0 6px 28px;
  min-width: 0;
}

.iu-tool-call__body--bare {
  padding: 0;
}

.iu-tool-call__nested {
  padding-left: 14px;
  margin-left: 8px;
  border-left: 1px solid var(--iu-border);
}

.iu-tool-call__toggle {
  width: auto;
  font-size: var(--iu-font-size-11-5);
  color: var(--iu-text-muted);
}

.iu-tool-call__children {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

@container (max-width: 480px) {
  .iu-tool-call__lines {
    display: none;
  }
  .iu-tool-call__row,
  .iu-tool-call__head {
    gap: 5px;
  }
}
</style>
