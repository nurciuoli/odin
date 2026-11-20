<script setup lang="ts">
// The page header band above the centre column: where you are. Home shows no title. Sessions draw their own header (SessionHeader), so this never shows there.
// A project page teleports its own one-line header (title, branch, quick actions, Start chat) into this band, so the
// breadcrumb and the project title are one line, not two.
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { IuBreadcrumb, IuHeader, type Crumb } from '@/components/AppShell'
import { isAssetKind, KIND_INFO } from '@/screens/library/assetForm'
import { PROJECT_SECTIONS } from './router'
import { useProjects } from './projects'

const route = useRoute()
const store = useProjects()

const projectName = computed(() =>
  typeof route.params.name === 'string' ? route.params.name : null,
)

const crumbs = computed<Crumb[]>(() => {
  const name = projectName.value
  if (name) {
    const title = store.projects.value.find(p => p.name === name)?.title ?? name
    const section = PROJECT_SECTIONS.find(s => s.id === route.meta.section)
    return [
      { label: title, to: { name: 'project-overview', params: { name } } },
      ...(section ? [{ label: section.label }] : []),
    ]
  }
  if (route.name === 'home') return []
  if (route.name === 'library-asset') {
    const kind = typeof route.params.kind === 'string' ? route.params.kind : ''
    const id = typeof route.params.id === 'string' ? route.params.id : ''
    const known = isAssetKind(kind)
    return [
      { label: 'Library', to: { name: 'library' } },
      ...(known
        ? [{ label: KIND_INFO[kind].plural, to: { name: 'library', query: { kind } } }]
        : []),
      { label: id, mono: true },
    ]
  }
  return [{ label: route.meta.crumb ?? 'Home' }]
})
</script>

<template>
  <IuHeader>
    <template #breadcrumb>
      <div v-if="projectName" id="app-header-project" class="app-header-project" />
      <IuBreadcrumb v-else :items="crumbs" />
    </template>
  </IuHeader>
</template>

<style>
.app-header-project {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
}
.app-header-project > * {
  flex: 1;
  min-width: 0;
}
</style>
