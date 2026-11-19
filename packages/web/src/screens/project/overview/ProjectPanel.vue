<script setup lang="ts">
// Identity and links: folder, session span, the repo and its state (git only), commands with copy, related
// projects and agents. Every fact comes from the project detail and the session list.
import { computed } from 'vue'
import type { ProjectDetail } from '@odin/shared/api'
import { IuBadge } from '@/components/Badge'
import { IuButton } from '@/components/Button'
import { IuIcon } from '@/components/Icon'
import { IuProperty, IuPropertyList } from '@/components/PropertyList'
import { useToast } from '@/components/Toast'
import { relativeTime } from '@/screens/shared/format'
import OverviewPanel from './OverviewPanel.vue'
import type { RelatedProject } from './related'

const props = defineProps<{
  detail: ProjectDetail
  git: boolean
  related: RelatedProject[]
  titleOf: (name: string) => string
}>()
const { toast } = useToast()

const COMMANDS = [
  { key: 'install', label: 'Install' },
  { key: 'check', label: 'Check' },
  { key: 'build', label: 'Build' },
] as const
const commands = computed(() =>
  COMMANDS.flatMap(c => {
    const cmd = props.detail.settings.commands[c.key]?.trim()
    return cmd ? [{ ...c, cmd }] : []
  }),
)
const repoUrl = computed(() =>
  props.detail.repo ? `https://github.com/${props.detail.repo}` : null,
)
const longDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : 'None yet'

async function copy(label: string, cmd: string) {
  try {
    await navigator.clipboard.writeText(cmd)
    toast({ title: `Copied the ${label.toLowerCase()} command` })
  } catch {
    toast({ title: "Couldn't copy to the clipboard", intent: 'danger' })
  }
}
</script>

<template>
  <OverviewPanel id="overview-project" title="Project">
    <IuPropertyList label-width="96px" class="ov-project__facts">
      <IuProperty label="Folder" mono
        ><span class="ov-project__wrap">{{ detail.path }}</span></IuProperty
      >
      <IuProperty label="First session" :value="longDate(detail.firstSessionAt)" />
      <IuProperty
        label="Last session"
        :value="detail.lastSessionAt ? relativeTime(detail.lastSessionAt) : 'None yet'"
      />
      <IuProperty v-if="git && repoUrl" label="Remote">
        <a :href="repoUrl" target="_blank" rel="noopener noreferrer" class="ov-project__link"
          >{{ detail.repo }} <IuIcon name="external" :size="14"
        /></a>
      </IuProperty>
      <IuProperty v-if="git && detail.git.branch" label="Branch">
        <span class="ov-project__chips">
          <IuBadge variant="tag"
            ><code class="ov-project__code">{{ detail.git.branch }}</code
            ><code v-if="detail.git.headSha" class="ov-project__code" :title="detail.git.headSha">
              · {{ detail.git.headSha.slice(0, 7) }}</code
            ></IuBadge
          >
          <IuBadge
            v-if="detail.git.ahead > 0"
            variant="tag"
            :aria-label="`${detail.git.ahead} commits ahead`"
            >↑{{ detail.git.ahead }} ahead</IuBadge
          >
          <IuBadge
            v-if="detail.git.behind > 0"
            variant="tag"
            :aria-label="`${detail.git.behind} commits behind`"
            >↓{{ detail.git.behind }} behind</IuBadge
          >
          <IuBadge v-if="detail.git.dirty" intent="warning">Uncommitted changes</IuBadge>
        </span>
      </IuProperty>
    </IuPropertyList>

    <div v-if="commands.length" class="ov-project__group">
      <h3 class="ov-project__label">Commands</h3>
      <ul class="ov-project__commands">
        <li v-for="c in commands" :key="c.key" class="ov-project__command">
          <span class="ov-project__command-name">{{ c.label }}</span>
          <code class="ov-project__code ov-project__command-text" :title="c.cmd">{{ c.cmd }}</code>
          <IuButton
            size="sm"
            variant="ghost"
            :aria-label="`Copy the ${c.label.toLowerCase()} command`"
            @click="copy(c.label, c.cmd)"
            >Copy</IuButton
          >
        </li>
      </ul>
    </div>

    <IuPropertyList v-if="related.length || detail.agents.length" label-width="96px">
      <IuProperty v-if="related.length" label="Also works with">
        <span class="ov-project__chips">
          <RouterLink
            v-for="r in related"
            :key="r.name"
            :to="{ name: 'project-overview', params: { name: r.name } }"
            class="ov-project__chip"
            :title="`${r.count} shared session${r.count === 1 ? '' : 's'}`"
            >{{ titleOf(r.name) }}</RouterLink
          >
        </span>
      </IuProperty>
      <IuProperty v-if="detail.agents.length" label="Agents">
        <span class="ov-project__chips">
          <IuBadge v-for="a in detail.agents" :key="a.id" variant="tag" :title="a.description">{{
            a.name
          }}</IuBadge>
        </span>
      </IuProperty>
    </IuPropertyList>
  </OverviewPanel>
</template>

<style>
.ov-project__wrap {
  overflow-wrap: anywhere;
  min-width: 0;
}
.ov-project__link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--iu-text);
  font-weight: var(--iu-font-weight-medium);
  overflow-wrap: anywhere;
}
.ov-project__link:focus-visible,
.ov-project__chip:focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: var(--iu-focus-offset);
}
.ov-project__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
  min-width: 0;
}
.ov-project__chip {
  display: inline-flex;
  align-items: center;
  padding: 1px 8px;
  border: 1px solid var(--iu-border-quiet);
  border-radius: var(--iu-radius-md);
  color: var(--iu-text);
  font-size: var(--iu-font-size-12);
}
.ov-project__code {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
}
.ov-project__group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 12px;
  border-top: 1px solid var(--iu-border-quiet);
}
.ov-project__label {
  margin: 0;
  font-size: var(--iu-font-size-12);
  font-weight: var(--iu-font-weight-regular);
  color: var(--iu-text-muted);
}
.ov-project__commands {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.ov-project__command {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.ov-project__command-name {
  flex: none;
  width: 52px;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-2);
}
.ov-project__command-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
