<script setup lang="ts">
// IuPlan — the agent's step checklist. Marker and label colour both carry the
// state (shape + ink), and every row has a visually hidden status word so the
// list reads correctly without the dots.
import { computed } from 'vue'
import IuMeter from '@/components/Meter/Meter.vue'
import IuSpinner from '@/components/Spinner/Spinner.vue'
import IuStatusDot from '@/components/StatusDot/StatusDot.vue'
import { statusLabel } from '@/styles/status'
import type { PlanStep } from '@/components/Chat/types'

const props = withDefaults(
  defineProps<{
    steps: PlanStep[]
    summary?: boolean
    compact?: boolean
  }>(),
  { summary: true, compact: false },
)

const done = computed(() => props.steps.filter(s => s.status === 'ok').length)

// detail is supporting copy: full view shows it for every step that has it;
// compact keeps only what needs attention right now (running, failed)
function showDetail(step: PlanStep): boolean {
  if (!step.detail) return false
  return !props.compact || step.status === 'running' || step.status === 'failed'
}
</script>

<template>
  <div class="iu-plan" :class="{ 'is-compact': compact }">
    <IuMeter
      v-if="summary"
      class="iu-plan__summary"
      layout="caption"
      size="sm"
      aria-label="Plan progress"
      :value="done"
      :max="steps.length"
      :value-label="`${done} / ${steps.length}`"
    />
    <ol class="iu-plan__steps">
      <li v-for="s in steps" :key="s.id" class="iu-plan__step" :data-status="s.status">
        <span class="iu-plan__marker">
          <IuSpinner v-if="s.status === 'running'" :size="11" />
          <IuStatusDot v-else :status="s.status" :size="7" decorative />
        </span>
        <span class="iu-plan__body">
          <span class="iu-plan__label">
            <span class="iu-plan__sr">{{ statusLabel[s.status] }}: </span>{{ s.label }}
          </span>
          <span v-if="showDetail(s)" class="iu-plan__detail">{{ s.detail }}</span>
        </span>
      </li>
    </ol>
  </div>
</template>

<style>
.iu-plan {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.iu-plan__summary {
  margin-bottom: 12px;
}

.iu-plan__steps {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.iu-plan.is-compact .iu-plan__steps {
  gap: 3px;
}

.iu-plan__step {
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr);
  column-gap: 9px;
  align-items: start;
}

/* 14px box; the top offset centres it on the 17.5px label line */
.iu-plan__marker {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  margin-top: 1.75px;
}

.iu-plan__body {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.iu-plan__label {
  font-size: var(--iu-font-size-12-5);
  line-height: var(--iu-leading-snug);
  color: var(--iu-text-2);
  overflow-wrap: anywhere;
}

.iu-plan__step[data-status='ok'] .iu-plan__label {
  color: var(--iu-text-muted);
}
.iu-plan__step[data-status='running'] .iu-plan__label {
  color: var(--iu-text);
  font-weight: var(--iu-font-weight-medium);
}
.iu-plan__step[data-status='awaiting'] .iu-plan__label,
.iu-plan__step[data-status='failed'] .iu-plan__label {
  color: var(--iu-text);
}
.iu-plan__step[data-status='cancelled'] .iu-plan__label {
  color: var(--iu-text-muted);
}

.iu-plan__detail {
  margin-top: 2px;
  font-size: var(--iu-font-size-11-5);
  line-height: var(--iu-leading-snug);
  color: var(--iu-text-muted);
}

/* visually hidden, still read by assistive tech */
.iu-plan__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
}
</style>
