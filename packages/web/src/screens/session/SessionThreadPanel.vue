<script setup lang="ts">
// The session's thread in the side column: its root session and forks, the branches and PRs they worked on, and their
// artifacts.
import { computed, shallowRef, watch } from 'vue'
import type { Artifact, Session, SessionDetail } from '@odin/shared/api'
import { useApi } from '@/api'
import { IuBadge } from '@/components/Badge'
import { IuSkeleton } from '@/components/States'
import { THREAD_STATE_LABEL, threadOfSession, upsertSession } from './threadChain'

const props = defineProps<{ session: SessionDetail }>()
const api = useApi()

const sessions = shallowRef<Session[]>([])
const artifacts = shallowRef<Artifact[]>([])
const phase = shallowRef<'loading' | 'ready' | 'error'>('loading')

let latest = 0
async function load(project: string) {
  const id = ++latest
  phase.value = 'loading'
  try {
    const [s, a] = await Promise.all([
      api.listSessions({ project }),
      api.listProjectArtifacts(project).catch((): Artifact[] => []),
    ])
    if (id !== latest) return
    sessions.value = s
    artifacts.value = a
    phase.value = 'ready'
  } catch {
    if (id === latest) phase.value = 'error'
  }
}
watch(
  () => [props.session.project, props.session.parentId] as const,
  ([project]) => void load(project),
  { immediate: true },
)

const thread = computed(() => {
  if (phase.value !== 'ready') return null
  // the open session is always current here, archived or not
  return threadOfSession(
    upsertSession(sessions.value, props.session),
    [...artifacts.value, ...props.session.artifacts],
    props.session.id,
  )
})
const others = computed(
  () => thread.value?.sessions.filter(s => s.session.id !== props.session.id) ?? [],
)
</script>

<template>
  <section class="session-thread" aria-labelledby="side-thread">
    <h2 id="side-thread" class="session-side__title">Thread</h2>
    <IuSkeleton v-if="phase === 'loading'" shape="text" :rows="2" />
    <p v-else-if="phase === 'error' || !thread" class="session-thread__muted">
      Couldn't load this session's thread.
    </p>
    <template v-else>
      <p class="session-thread__head">
        <IuBadge size="xs">{{ THREAD_STATE_LABEL[thread.state] }}</IuBadge>
      </p>
      <ul class="session-thread__chain" aria-label="Thread chain">
        <li v-for="s in others" :key="s.session.id">
          <span v-if="s.depth > 0" class="session-thread__muted" aria-hidden="true">⑂ </span>
          <span v-if="s.depth > 0" class="sr-only">Fork: </span>
          <RouterLink :to="{ name: 'session', params: { id: s.session.id } }">{{
            s.session.title
          }}</RouterLink>
        </li>
        <li v-for="b in thread.branches" :key="`b:${b}`" class="session-thread__mono">
          <span class="sr-only">Branch </span>{{ b }}
        </li>
        <li v-for="p in thread.pulls" :key="`p:${p.number}`">
          <a :href="p.url" target="_blank" rel="noopener noreferrer">PR #{{ p.number }}</a>
          <span class="session-thread__muted"> · {{ p.merged ? 'merged' : p.state }}</span>
        </li>
        <li v-for="a in thread.artifacts" :key="`a:${a.id}`">
          <RouterLink
            :to="{
              name: 'session',
              params: { id: a.sessionId },
              query: { artifact: String(a.id) },
            }"
            >{{ a.title }}</RouterLink
          >
        </li>
      </ul>
    </template>
  </section>
</template>

<style>
.session-thread {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.session-thread__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: var(--iu-font-size-13);
}
.session-thread__chain {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: var(--iu-font-size-12-5);
}
.session-thread__muted {
  margin: 0;
  font-size: var(--iu-font-size-12-5);
  color: var(--iu-text-muted);
}
.session-thread__mono {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11-5);
  color: var(--iu-text-2);
}
</style>
