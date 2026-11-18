<script setup lang="ts">
// Results of `!` commands, above the message box. They go to the agent with the next message.
import { IuButton } from '@/components/Button'
import { IuTerminalOutput } from '@/components/TerminalOutput'
import { shellStatus, type ShellRun } from './shellRuns'

defineProps<{ runs: ShellRun[]; running: boolean }>()
const emit = defineEmits<{ dismiss: [id: string]; clear: [] }>()
</script>

<template>
  <section v-if="runs.length || running" class="session-shell" aria-label="Shell commands">
    <header class="session-shell__head">
      <span class="session-shell__note" role="status" aria-live="polite">
        {{
          running
            ? 'Running…'
            : runs.length === 1
              ? 'Sent to the agent with your next message'
              : `${runs.length} commands, sent to the agent with your next message`
        }}
      </span>
      <IuButton v-if="runs.length" variant="ghost" size="sm" @click="emit('clear')"
        >Discard</IuButton
      >
    </header>
    <div v-for="run in runs" :key="run.id" class="session-shell__run">
      <IuTerminalOutput
        :text="run.output || '(no output)'"
        :command="run.command"
        :tone="run.exitCode === 0 ? 'default' : 'error'"
        :truncated="run.truncated"
        max-height="200px"
      />
      <p class="session-shell__status">
        {{ shellStatus(run) }} · {{ (run.durationMs / 1000).toFixed(1) }}s
        <IuButton variant="ghost" size="sm" @click="emit('dismiss', run.id)">Remove</IuButton>
      </p>
    </div>
  </section>
</template>

<style>
.session-shell {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}
.session-shell__head,
.session-shell__status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin: 0;
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}
</style>
