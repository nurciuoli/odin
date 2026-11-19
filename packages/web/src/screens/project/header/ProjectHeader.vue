<script setup lang="ts">
// The project page's header: one compact row (title with sync and uncommitted dots, branch chip, quick actions,
// Start chat) over the tab strip. Folder, repository, branch, sync and working-tree details live in a hover card
// on the title; the branch chip, path and repository copy or open with one click.
import { computed } from 'vue'
import type { ProjectDetail, SyncStatus } from '@odin/shared/api'
import { hasDesktop, openPath, OPEN_TARGETS, type OpenTarget } from '@/app/desktop'
import { IuButton } from '@/components/Button'
import { IuHoverCard } from '@/components/HoverCard'
import { IuIcon } from '@/components/Icon'
import { IuMenu, type MenuItem } from '@/components/Menu'
import { IuStatusDot } from '@/components/StatusDot'
import { IuTabs, type Tab } from '@/components/Tabs'
import { useToast } from '@/components/Toast'
import { useCopy } from '@/composables/useCopy'
import { relativeTime, SYNC_DISPLAY } from '@/screens/shared/format'

const props = defineProps<{
  detail: ProjectDetail
  sync?: SyncStatus
  tabs: Tab[]
  idBase: string
}>()
const section = defineModel<string>({ required: true })

const { toast } = useToast()
const pathCopy = useCopy()
const branchCopy = useCopy()
const desktop = hasDesktop()

const repoUrl = computed(() =>
  props.detail.repo ? `https://github.com/${props.detail.repo}` : null,
)
const git = computed(() => props.detail.git)
const sha = computed(() => git.value.headSha?.slice(0, 7) ?? null)
const dirtyCount = computed(() => props.detail.dirtyFiles.length)
const syncDisplay = computed(() => (props.sync ? SYNC_DISPLAY[props.sync.state] : null))
const syncTitle = computed(() => {
  if (!props.sync || !syncDisplay.value) return ''
  if (props.sync.state === 'error' && props.sync.error) return props.sync.error
  return props.sync.lastSyncAt
    ? `${syncDisplay.value.label} · ${relativeTime(props.sync.lastSyncAt)}`
    : syncDisplay.value.label
})

const openItems: MenuItem[] = [
  ...OPEN_TARGETS.map(t => ({
    id: t.id,
    label: t.label,
    icon: (t.id === 'terminal' ? 'terminal' : t.id === 'files' ? 'folder' : 'pencil') as never,
  })),
  { type: 'separator' },
  { id: 'copy-path', label: 'Copy path', icon: 'copy' as never },
  ...(repoUrl.value ? [{ id: 'repo', label: 'Open repository', icon: 'external' as never }] : []),
]
async function onOpen(id: string) {
  if (id === 'copy-path') return void pathCopy.copy(props.detail.path)
  if (id === 'repo' && repoUrl.value) return void window.open(repoUrl.value, '_blank', 'noopener')
  if (!(await openPath(props.detail.path, id as OpenTarget)))
    toast({ title: "Couldn't open the folder", intent: 'danger' })
}
const startTo = computed(() => ({
  name: 'home',
  query: { launch: '1', project: props.detail.name },
}))
</script>

<template>
  <header class="phdr">
    <div class="phdr__row">
      <IuHoverCard placement="bottom-start" :width="340" label="Project details">
        <button type="button" class="phdr__titlebtn" aria-haspopup="true">
          <IuIcon name="folder" :size="16" class="phdr__ico" />
          <h1 class="phdr__title">{{ detail.title }}</h1>
          <IuStatusDot
            v-if="syncDisplay"
            :status="syncDisplay.status"
            :size="7"
            :label="syncTitle"
          />
        </button>
        <template #card>
          <dl class="phdr__card">
            <dt>Folder</dt>
            <dd class="phdr__mono">{{ detail.path }}</dd>
            <template v-if="repoUrl">
              <dt>Repository</dt>
              <dd class="phdr__mono">{{ detail.repo }}</dd>
            </template>
            <template v-if="git.branch">
              <dt>Branch</dt>
              <dd class="phdr__mono">
                {{ git.branch }} {{ sha }}
                <span v-if="git.ahead">↑{{ git.ahead }}</span>
                <span v-if="git.behind">↓{{ git.behind }}</span>
              </dd>
            </template>
            <dt>Sync</dt>
            <dd>{{ syncTitle || '—' }}</dd>
            <template v-if="git.dirty">
              <dt>Working tree</dt>
              <dd>
                {{
                  dirtyCount
                    ? `Uncommitted changes (${dirtyCount} written by Odin)`
                    : 'Uncommitted changes'
                }}
              </dd>
            </template>
          </dl>
        </template>
      </IuHoverCard>
      <button
        v-if="git.branch"
        type="button"
        class="phdr__branch"
        title="Copy branch name"
        @click="branchCopy.copy(git.branch)"
      >
        <IuIcon name="gitBranch" :size="14" />
        <span class="phdr__mono">{{ git.branch }}</span>
        <span v-if="git.ahead || git.behind" class="phdr__ab">
          <template v-if="git.ahead">↑{{ git.ahead }}</template
          ><template v-if="git.behind"> ↓{{ git.behind }}</template>
        </span>
        <span v-if="git.dirty" class="phdr__pip" aria-label="Uncommitted changes" />
      </button>
      <span v-if="detail.missing" class="phdr__warn">Folder missing</span>
      <span class="phdr__spacer" />
      <IuButton
        variant="ghost"
        size="sm"
        icon-only
        :aria-label="pathCopy.copied.value ? 'Copied' : 'Copy path'"
        title="Copy path"
        @click="pathCopy.copy(detail.path)"
      >
        <template #icon
          ><IuIcon :name="pathCopy.copied.value ? 'check' : 'copy'" :size="16"
        /></template>
      </IuButton>
      <IuButton
        v-if="repoUrl"
        as="a"
        :href="repoUrl"
        target="_blank"
        rel="noopener noreferrer"
        variant="ghost"
        size="sm"
        icon-only
        aria-label="Open repository"
        title="Open repository"
      >
        <template #icon><IuIcon name="external" :size="16" /></template>
      </IuButton>
      <IuMenu v-if="desktop" :items="openItems" @select="onOpen">
        <template #trigger="{ toggle }">
          <IuButton variant="ghost" size="sm" aria-haspopup="menu" @click="toggle">
            Open
            <template #trailing><IuIcon name="chevronDown" :size="14" /></template>
          </IuButton>
        </template>
      </IuMenu>
      <IuButton as="RouterLink" :to="startTo" variant="primary" size="sm">Start chat</IuButton>
    </div>
    <IuTabs
      v-model="section"
      :tabs="tabs"
      :panels="false"
      :id-base="idBase"
      aria-label="Project sections"
    />
  </header>
</template>

<style>
.phdr {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.phdr__row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.phdr__title {
  margin: 0;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-semibold);
  line-height: var(--iu-leading-tight);
  color: var(--iu-text-bright);
}
.phdr__spacer {
  flex: 1 1 0;
}
.phdr__mono {
  font-family: var(--iu-font-mono);
}
.phdr__ico {
  color: var(--iu-text-muted);
}
.phdr__warn {
  font-size: var(--iu-font-size-12);
  color: var(--iu-warning);
}
.phdr__ab {
  font-family: var(--iu-font-mono);
}
.phdr__pip {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--iu-warning);
}
.phdr__titlebtn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  margin-left: -8px;
  border: 0;
  border-radius: var(--iu-radius-md);
  background: none;
  color: inherit;
  cursor: default;
}
.phdr__titlebtn:hover,
.phdr__titlebtn:focus-visible {
  background: var(--iu-hover);
}
.phdr__titlebtn:focus-visible,
.phdr__branch:focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: var(--iu-focus-offset);
}
.phdr__branch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border: 1px solid var(--iu-border-quiet);
  border-radius: var(--iu-radius-md);
  background: none;
  color: var(--iu-text-2);
  font-size: var(--iu-font-size-12);
  cursor: pointer;
}
.phdr__branch:hover {
  background: var(--iu-hover);
  color: var(--iu-text-bright);
}
.phdr__card {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 14px;
  margin: 0;
  padding: 10px 12px;
  font-size: var(--iu-font-size-12);
}
.phdr__card dt {
  color: var(--iu-text-muted);
}
.phdr__card dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
