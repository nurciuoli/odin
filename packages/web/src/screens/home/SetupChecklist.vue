<script setup lang="ts">
// First-run checklist: what this machine still needs (GET /api/readiness). Hidden once nothing needs doing;
// optional features (GitHub) alone never show it.
import { computed } from 'vue'
import type { ReadinessCheck } from '@odin/shared/api'
import { useApi } from '@/api'
import { IuCallout } from '@/components/Callout'
import { useResource, useServerEvents } from '@/screens/shared/useResource'

const api = useApi()
const readiness = useResource(() => api.getReadiness())
void readiness.load()
useServerEvents(event => {
  if (event.type === 'project.updated' || event.type === 'project.removed') void readiness.load()
})

const STATE_LABEL: Record<ReadinessCheck['state'], string> = {
  ok: 'Ready',
  missing: 'Needed',
  warn: 'Check',
  optional: 'Optional',
  todo: 'Next step',
}

const open = computed(() => (readiness.data.value?.checks ?? []).filter(c => c.state !== 'ok'))
const shown = computed(() => open.value.some(c => c.state !== 'optional'))
const blocked = computed(() => readiness.data.value?.ready === false)
</script>

<template>
  <IuCallout
    v-if="shown"
    class="setup-checklist"
    :intent="blocked ? 'danger' : 'info'"
    :title="blocked ? 'Odin needs a few things before it can run sessions' : 'Finish setting up'"
  >
    <ul class="setup-checklist__list">
      <li v-for="check in open" :key="check.id" class="setup-checklist__item">
        <span class="setup-checklist__state">{{ STATE_LABEL[check.state] }}</span>
        <span class="setup-checklist__label">{{ check.label }}</span>
        <span class="setup-checklist__detail">{{ check.detail }}</span>
        <span v-if="check.fix" class="setup-checklist__fix">{{ check.fix }}</span>
      </li>
    </ul>
  </IuCallout>
</template>

<style scoped>
.setup-checklist {
  margin-bottom: 16px;
}
.setup-checklist__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 8px;
}
.setup-checklist__item {
  display: grid;
  grid-template-columns: auto 1fr;
  column-gap: 8px;
  font-size: var(--iu-font-size-13);
}
.setup-checklist__state {
  font-weight: var(--iu-font-weight-semibold);
}
.setup-checklist__label {
  font-weight: var(--iu-font-weight-medium);
}
.setup-checklist__detail,
.setup-checklist__fix {
  grid-column: 2;
  color: var(--iu-text-muted);
}
</style>
