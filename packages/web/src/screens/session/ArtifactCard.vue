<script setup lang="ts">
// Where a tool call posted an artifact, the thread shows this compact card; the artifact itself lives in the
// artifact column. The card's button shows that artifact (at this post's version) there.
import { IuButton } from '@/components/Button'
import { IuCard } from '@/components/Card'
import { IuIcon } from '@/components/Icon'
import type { ArtifactRef } from './sessionView'

withDefaults(
  defineProps<{
    artifact: ArtifactRef
    /** This artifact is the one on show in the column. */
    current?: boolean
  }>(),
  { current: false },
)

const emit = defineEmits<{ open: [id: number, version: number] }>()
</script>

<template>
  <IuCard class="artifact-card" elevation="raised" density="compact" :selected="current" signature>
    <div class="artifact-card__row">
      <span class="artifact-card__icon" aria-hidden="true"><IuIcon name="file" :size="16" /></span>
      <span class="artifact-card__text">
        <span class="artifact-card__title">{{ artifact.title }}</span>
        <span class="artifact-card__meta">Artifact · v{{ artifact.version }}</span>
      </span>
      <IuButton
        variant="secondary"
        size="sm"
        :aria-label="`Show ${artifact.title}, version ${artifact.version}, in the artifact panel`"
        :aria-pressed="current || undefined"
        @click="emit('open', artifact.id, artifact.version)"
      >
        <template #icon><IuIcon name="panelRightOpen" :size="14" /></template>
        {{ current ? 'Showing' : 'Show' }}
      </IuButton>
    </div>
  </IuCard>
</template>

<style>
.artifact-card {
  max-width: 420px;
  margin-top: 8px;
}
.artifact-card__row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.artifact-card__icon {
  flex: none;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: var(--iu-radius-sm);
  background: var(--iu-gold-wash);
  color: var(--iu-gold);
}
.artifact-card__text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.artifact-card__title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--iu-font-size-13);
  font-weight: var(--iu-font-weight-medium);
  color: var(--iu-text);
}
.artifact-card__meta {
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
</style>
