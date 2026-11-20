<script setup lang="ts">
// One table of sessions with the row actions (open, fork, rename, tag, pin, archive, delete). History shows every
// project's; a project's Sessions tab shows its own (`showProject` off). The parent owns the list: after a change
// this emits `changed` and the parent refetches (the sessions store also nudges it on `session.updated`).
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { Session, SessionState } from '@odin/shared/api'
import { useApi } from '@/api'
import { useProjects } from '@/app/projects'
import { IuBadge } from '@/components/Badge'
import { IuButton } from '@/components/Button'
import { IuDialog } from '@/components/Modal'
import { IuField } from '@/components/Fields'
import { IuIcon } from '@/components/Icon'
import { IuMenu, type MenuItem } from '@/components/Menu'
import { IuFlock } from '@/components/Spinner'
import { IuTable, type Column } from '@/components/Table'
import { useToast } from '@/components/Toast'
import { statusIntent } from '@/styles/status'
import { formatCost, formatTokens, relativeTime, SESSION_DISPLAY } from './format'

const props = withDefaults(
  defineProps<{
    sessions: Session[]
    loading?: boolean
    showProject?: boolean
    /**
     * A project's own table: the Projects column lists each session's other projects (its `projects[]` minus this
     * one) as links, instead of every project as text.
     */
    otherProjectsOf?: string
    /** A narrow panel: session, state, cost and actions only, no minimum width. */
    compact?: boolean
  }>(),
  { loading: false, showProject: true, otherProjectsOf: undefined, compact: false },
)
const emit = defineEmits<{ changed: [] }>()

const api = useApi()
const router = useRouter()
const projects = useProjects()
const { toast } = useToast()

type Row = {
  id: string
  title: string
  project: string
  state: SessionState
  model: string
  agent: string
  template: string
  updatedAt: string
  cost: number | null
  tokensOut: number
  actions: string
}

// In-progress rows show the flock where the others show the badge's dot. The label beside it says the state.

const titleOf = (name: string) => projects.projects.value.find(p => p.name === name)?.title ?? name

// pinned first, then newest; the table's own column sort replaces this when asked
const rows = computed<Row[]>(() =>
  props.sessions
    .slice()
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt))
    .map(s => ({
      id: s.id,
      title: s.title,
      project: (s.projects ?? [s.project]).map(titleOf).join(', '),
      state: s.state,
      model: s.model ?? '',
      agent: s.agent ?? '',
      template: s.templateId ?? '',
      updatedAt: s.updatedAt,
      cost: s.metrics.costUsd,
      tokensOut: s.metrics.tokens.output,
      actions: '',
    })),
)
const byId = computed(() => new Map(props.sessions.map(s => [s.id, s])))

const columns = computed<Column<Row>[]>(() => {
  const cols: Column<Row>[] = [
    { key: 'title', header: 'Session', sortable: true },
    { key: 'project', header: 'Projects', sortable: true, width: '160px' },
    { key: 'state', header: 'State', sortable: true, width: '136px' },
    { key: 'model', header: 'Model', sortable: true, width: '150px' },
    { key: 'updatedAt', header: 'Updated', sortable: true, width: '110px' },
    { key: 'cost', header: 'Cost', sortable: true, numeric: true, align: 'end', width: '80px' },
    {
      key: 'tokensOut',
      header: 'Tokens out',
      sortable: true,
      numeric: true,
      align: 'end',
      width: '100px',
    },
    { key: 'actions', header: '', width: '48px' },
  ]
  if (props.compact)
    return cols.filter(c => ['title', 'state', 'cost', 'actions'].includes(c.key as string))
  if (props.otherProjectsOf)
    return cols.map(c => (c.key === 'project' ? { ...c, header: 'Also in', sortable: false } : c))
  return props.showProject ? cols : cols.filter(c => c.key !== 'project')
})

// ── row actions ─────────────────────────────────────────────────────────────
function menuFor(s: Session): MenuItem[] {
  return [
    { id: 'open', label: 'Open', icon: 'arrowRight' },
    { id: 'fork', label: 'Fork', icon: 'gitBranch' },
    { id: 'rename', label: 'Rename…', icon: 'pencil' },
    { id: 'tags', label: 'Edit tags…', icon: 'tag' },
    { id: 'pin', label: s.pinned ? 'Unpin' : 'Pin' },
    { id: 'archive', label: s.archived ? 'Unarchive' : 'Archive' },
    { type: 'separator' },
    { id: 'delete', label: 'Delete…', icon: 'trash', destructive: true },
  ]
}

const failure = (title: string, e: unknown) =>
  toast({
    title,
    description: e instanceof Error ? e.message : String(e),
    intent: 'danger',
  })

type Dialog = { kind: 'rename' | 'tags' | 'delete'; session: Session }
const dialog = ref<Dialog | null>(null)
const draft = ref('')
const busy = ref(false)
const dialogOpen = computed({
  get: () => dialog.value !== null,
  set: v => {
    if (!v) dialog.value = null
  },
})

async function patch(
  s: Session,
  req: Parameters<typeof api.updateSession>[1],
  failedTitle: string,
) {
  try {
    await api.updateSession(s.id, req)
    emit('changed')
    return true
  } catch (e) {
    failure(failedTitle, e)
    return false
  }
}

async function onAction(s: Session, id: string) {
  if (id === 'open') await router.push({ name: 'session', params: { id: s.id } })
  else if (id === 'fork') {
    try {
      const fork = await api.forkSession(s.id, {})
      emit('changed')
      await router.push({ name: 'session', params: { id: fork.id } })
    } catch (e) {
      failure("Couldn't fork the session", e)
    }
  } else if (id === 'rename') {
    draft.value = s.title
    dialog.value = { kind: 'rename', session: s }
  } else if (id === 'tags') {
    draft.value = s.tags.join(', ')
    dialog.value = { kind: 'tags', session: s }
  } else if (id === 'pin') await patch(s, { pinned: !s.pinned }, "Couldn't change the pin")
  else if (id === 'archive')
    await patch(s, { archived: !s.archived }, "Couldn't change the archive state")
  else if (id === 'delete') dialog.value = { kind: 'delete', session: s }
}

const parsedTags = computed(() => [
  ...new Set(
    draft.value
      .split(',')
      .map(t => t.trim())
      .filter(Boolean),
  ),
])
const canSave = computed(() =>
  dialog.value?.kind === 'rename' ? draft.value.trim().length > 0 : true,
)

async function confirm() {
  const d = dialog.value
  if (!d) return
  busy.value = true
  try {
    if (d.kind === 'rename') {
      if (await patch(d.session, { title: draft.value.trim() }, "Couldn't rename the session"))
        dialog.value = null
    } else if (d.kind === 'tags') {
      if (await patch(d.session, { tags: parsedTags.value }, "Couldn't save the tags"))
        dialog.value = null
    } else {
      try {
        await api.deleteSession(d.session.id)
        dialog.value = null
        emit('changed')
      } catch (e) {
        failure("Couldn't delete the session", e)
      }
    }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="sessions-table">
    <IuTable
      :columns="columns"
      :rows="rows"
      :row-key="r => r.id"
      density="compact"
      :min-width="compact ? undefined : '900px'"
      :loading="loading"
      @row-activate="r => router.push({ name: 'session', params: { id: r.id } })"
    >
      <template #cell:title="{ row }">
        <span class="sessions-table__title">
          <RouterLink
            :to="{ name: 'session', params: { id: row.id } }"
            class="sessions-table__link"
          >
            {{ row.title }}
          </RouterLink>
          <IuBadge v-if="byId.get(row.id)?.pinned" variant="tag" size="xs">Pinned</IuBadge>
          <IuBadge v-if="byId.get(row.id)?.archived" variant="tag" size="xs">Archived</IuBadge>
          <IuBadge v-if="byId.get(row.id)?.origin === 'external'" variant="tag" size="xs">
            Terminal
          </IuBadge>
          <IuBadge v-for="t in byId.get(row.id)?.tags ?? []" :key="t" variant="tag" size="xs">
            {{ t }}
          </IuBadge>
        </span>
      </template>
      <template v-if="otherProjectsOf" #cell:project="{ row }">
        <span class="sessions-table__projects">
          <RouterLink
            v-for="p in (byId.get(row.id)?.projects ?? []).filter(n => n !== otherProjectsOf)"
            :key="p"
            :to="{ name: 'project-overview', params: { name: p } }"
            class="sessions-table__project"
            >{{ titleOf(p) }}</RouterLink
          >
        </span>
      </template>
      <template #cell:state="{ row }">
        <IuBadge
          v-if="SESSION_DISPLAY[row.state].flock"
          :intent="statusIntent[SESSION_DISPLAY[row.state].status]"
        >
          <span class="sessions-table__glyph" aria-hidden="true">
            <IuFlock :state="SESSION_DISPLAY[row.state].flock" size="sm" tone="neutral" />
          </span>
          {{ SESSION_DISPLAY[row.state].label }}
        </IuBadge>
        <IuBadge v-else :intent="statusIntent[SESSION_DISPLAY[row.state].status]" dot>
          {{ SESSION_DISPLAY[row.state].label }}
        </IuBadge>
      </template>
      <template #cell:model="{ row }">
        <code v-if="row.model" class="sessions-table__code">{{ row.model }}</code>
      </template>
      <template #cell:agent="{ row }">
        <span v-if="row.agent">{{ row.agent.replace(/^library:/, '') }}</span>
      </template>
      <template #cell:template="{ row }">
        <span v-if="row.template">{{ row.template }}</span>
      </template>
      <template #cell:updatedAt="{ row }">
        <time :datetime="row.updatedAt" :title="row.updatedAt">{{
          relativeTime(row.updatedAt)
        }}</time>
      </template>
      <template #cell:cost="{ row }">{{ formatCost(row.cost) }}</template>
      <template #cell:tokensOut="{ row }">{{ formatTokens(row.tokensOut) }}</template>
      <template #cell:actions="{ row }">
        <IuMenu
          v-if="byId.get(row.id)"
          fixed
          :items="menuFor(byId.get(row.id)!)"
          @select="id => onAction(byId.get(row.id)!, id)"
        >
          <template #trigger="{ toggle, open }">
            <IuButton
              variant="ghost"
              size="sm"
              icon-only
              :aria-label="`Actions for ${row.title}`"
              aria-haspopup="menu"
              :aria-expanded="open ? 'true' : 'false'"
              @click="toggle"
            >
              <template #icon><IuIcon name="more" :size="14" /></template>
            </IuButton>
          </template>
        </IuMenu>
      </template>
      <template #empty><slot name="empty">No sessions</slot></template>
    </IuTable>

    <IuDialog v-model:open="dialogOpen" size="sm">
      <template #header>
        <h2 class="sessions-table__dialog-title">
          <template v-if="dialog?.kind === 'rename'">Rename session</template>
          <template v-else-if="dialog?.kind === 'tags'">Edit tags</template>
          <template v-else>Delete session?</template>
        </h2>
      </template>
      <form id="sessions-table-form" novalidate @submit.prevent="confirm">
        <IuField
          v-if="dialog?.kind === 'rename'"
          :model-value="draft"
          label="Title"
          @update:model-value="v => (draft = String(v))"
        />
        <IuField
          v-else-if="dialog?.kind === 'tags'"
          :model-value="draft"
          label="Tags"
          hint="Separate tags with commas."
          @update:model-value="v => (draft = String(v))"
        />
        <p v-else class="sessions-table__dialog-text">
          “{{ dialog?.session.title }}” is removed from Odin and from Claude's own history. Its
          worktree and branch stay.
        </p>
      </form>
      <template #footer>
        <IuButton type="button" variant="ghost" @click="dialog = null">Cancel</IuButton>
        <IuButton
          type="submit"
          form="sessions-table-form"
          :variant="dialog?.kind === 'delete' ? 'danger' : 'primary'"
          :loading="busy"
          :disabled="!canSave"
        >
          {{ dialog?.kind === 'delete' ? 'Delete' : 'Save' }}
        </IuButton>
      </template>
    </IuDialog>
  </div>
</template>

<style>
/* The flock's slot: as tall as the badge's text line, so a row with a flock is no taller than one with a dot. */
.sessions-table__glyph {
  flex: none;
  display: inline-flex;
  align-items: center;
  width: 20px;
  height: 12px;
}
.sessions-table__title {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.sessions-table__link {
  color: var(--iu-text);
  font-weight: var(--iu-font-weight-medium);
}
.sessions-table__link:focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: var(--iu-focus-offset);
}
.sessions-table__projects {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px 8px;
}
.sessions-table__project:focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: var(--iu-focus-offset);
}
.sessions-table__code {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
}
.sessions-table__dialog-title {
  margin: 0;
  font-size: var(--iu-font-size-16);
  font-weight: var(--iu-font-weight-semibold);
}
.sessions-table__dialog-text {
  margin: 0;
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-2);
}
</style>
