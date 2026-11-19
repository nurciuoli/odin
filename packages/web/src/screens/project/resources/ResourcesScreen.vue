<script setup lang="ts">
// A project's resources: agent context, library installs (with drift), its subagents, and its docs.
import { computed } from 'vue'
import { hasDesktop, openPath } from '@/app/desktop'
import { IuBadge } from '@/components/Badge'
import { IuButton } from '@/components/Button'
import { IuEmpty } from '@/components/States'
import { useToast } from '@/components/Toast'
import { useProject } from '../useProject'
import ProjectContextPanel from './ProjectContextPanel.vue'
import ProjectLibraryScreen from './ProjectLibraryScreen.vue'

const { detail } = useProject()
const { toast } = useToast()
const desktop = hasDesktop()

const join = (file: string) => `${detail.value.path.replace(/\/$/, '')}/${file}`
// STATUS.md is known to exist when the project read it; the others are where Odin would look.
const docs = computed(() =>
  [
    { file: 'AGENTS.md', note: 'Instructions for agents' },
    detail.value.status !== null ? { file: 'docs/STATUS.md', note: 'Where things stand' } : null,
    { file: 'PROJECT.md', note: detail.value.manifestError ? 'Has problems' : 'Project manifest' },
  ].filter((d): d is { file: string; note: string } => d !== null),
)

async function open(file: string) {
  if (!(await openPath(join(file), 'editor')))
    toast({ title: "Couldn't open the file", intent: 'danger' })
}
</script>

<template>
  <div class="resources">
    <section aria-labelledby="resources-context" class="resources__section">
      <h2 id="resources-context" class="resources__heading">Agent context</h2>
      <ProjectContextPanel />
    </section>

    <section aria-labelledby="resources-library" class="resources__section">
      <h2 id="resources-library" class="resources__heading">Library</h2>
      <ProjectLibraryScreen />
    </section>

    <section aria-labelledby="resources-agents" class="resources__section">
      <h2 id="resources-agents" class="resources__heading">Agents</h2>
      <IuEmpty
        v-if="!detail.agents.length"
        title="No agents"
        body="Subagents in this project's .claude/agents/ show up here."
      />
      <ul v-else class="resources__list" aria-label="Agents">
        <li v-for="a in detail.agents" :key="a.id" class="resources__row">
          <span class="resources__name">{{ a.name }}</span>
          <IuBadge v-if="a.model" variant="tag" size="xs">{{ a.model }}</IuBadge>
          <IuBadge v-if="a.libraryId" variant="tag" size="xs" intent="info">From library</IuBadge>
          <IuBadge v-if="a.error" intent="warning">Problem</IuBadge>
          <p class="resources__text">{{ a.error ?? a.description }}</p>
          <code class="resources__code">{{ a.path }}</code>
        </li>
      </ul>
    </section>

    <section aria-labelledby="resources-docs" class="resources__section">
      <h2 id="resources-docs" class="resources__heading">Docs</h2>
      <ul class="resources__list" aria-label="Docs">
        <li v-for="d in docs" :key="d.file" class="resources__row">
          <IuButton v-if="desktop" variant="link" size="sm" @click="open(d.file)">{{
            d.file
          }}</IuButton>
          <span v-else class="resources__name">{{ d.file }}</span>
          <span class="resources__text">{{ d.note }}</span>
          <code class="resources__code">{{ join(d.file) }}</code>
        </li>
      </ul>
    </section>
  </div>
</template>

<style>
.resources {
  display: flex;
  flex-direction: column;
  gap: 24px;
  padding-top: 8px;
}
.resources__section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.resources__heading {
  margin: 0;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-semibold);
}
.resources__list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.resources__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--iu-border-quiet);
}
.resources__name {
  font-weight: var(--iu-font-weight-medium);
}
.resources__text {
  margin: 0;
  flex-basis: 100%;
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-2);
}
.resources__code {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
</style>
