<script setup lang="ts">
// DESIGN MOCKUP (not wired to the API): the UX sweep proposals, on inline mock data. Views: library, library-mcp,
// library-delete, files, files-move, files-rename. Route: /ux/:view, optional ?open=menu|none.
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { IuBadge } from '@/components/Badge'
import { IuButton } from '@/components/Button'
import { IuCallout } from '@/components/Callout'
import { IuCheckbox, IuSwitch } from '@/components/Fields'
import { IuIcon } from '@/components/Icon'
import { IuMenu, type MenuItem } from '@/components/Menu'
import { IuDialog as IuModal } from '@/components/Modal'
import { IuPageHeader } from '@/components/PageHeader'
import { IuTabs } from '@/components/Tabs'

const route = useRoute()
const view = computed(() => String(route.params.view ?? 'library'))

const kinds = [
  ['instruction', 'Instructions', 4],
  ['skill', 'Skills', 9],
  ['agent', 'Subagents', 3],
  ['command', 'Commands', 5],
  ['mcp', 'MCP servers', 4],
  ['settings', 'Settings', 2],
  ['plugin', 'Plugins', 2],
] as const
const tabs = kinds.map(([id, label, badge]) => ({ id, label, badge }))
const kind = ref(view.value === 'library-mcp' ? 'mcp' : 'skill')

type Item = { id: string; name: string; desc: string; used: string; updated: string; on: boolean }
const skills = ref<Item[]>([
  { id: 'pr-review', name: 'PR review', desc: 'Review a diff for correctness and risk', used: '3 projects', updated: '2d ago', on: true },
  { id: 'release-notes', name: 'Release notes', desc: 'Draft notes from merged PRs', used: '1 project', updated: '5d ago', on: true },
  { id: 'sql-explain', name: 'SQL explain', desc: 'Explain and tune a query plan', used: '2 projects', updated: '2w ago', on: false },
  { id: 'notebook-clean', name: 'Notebook clean-up', desc: 'Strip outputs and fix kernel metadata', used: '2 projects', updated: '3w ago', on: true },
])
type Mcp = Item & { transport: string; target: string; auth: string; tone: 'positive' | 'warning' | 'neutral' }
const mcps = ref<Mcp[]>([
  { id: 'github', name: 'GitHub', desc: 'Issues, PRs and code search', used: '4 projects', updated: '1d ago', on: true, transport: 'http', target: 'api.githubcopilot.com/mcp', auth: 'Connected', tone: 'positive' },
  { id: 'linear', name: 'Linear', desc: 'Tickets and cycles', used: '2 projects', updated: '4d ago', on: true, transport: 'http', target: 'mcp.linear.app/sse', auth: 'Sign in needed', tone: 'warning' },
  { id: 'postgres', name: 'Postgres', desc: 'Read-only query access', used: '1 project', updated: '1w ago', on: true, transport: 'local', target: 'npx @mcp/postgres', auth: 'Needs DATABASE_URL', tone: 'warning' },
  { id: 'filesystem', name: 'Filesystem', desc: 'Scoped file access', used: 'Not installed', updated: '3w ago', on: false, transport: 'local', target: 'npx @mcp/filesystem', auth: 'No auth', tone: 'neutral' },
])

const rowMenu = (on: boolean, kindName: string): MenuItem[] => [
  { id: 'edit', label: 'Edit', icon: 'pencil' },
  { id: 'install', label: 'Install in project…', icon: 'plus' },
  { id: 'toggle', label: on ? 'Disable' : 'Enable', icon: on ? 'pause' : 'play', description: on ? `Stops new sessions using this ${kindName}` : undefined },
  { id: 'dup', label: 'Duplicate', icon: 'copy' },
  { id: 'export', label: 'Export…', icon: 'external' },
  { type: 'separator' },
  { id: 'delete', label: 'Delete…', icon: 'trash', destructive: true },
]

const picked = ref(new Set<string>(view.value === 'library' ? ['release-notes', 'sql-explain'] : []))
const toggleRow = (id: string) => {
  const next = new Set(picked.value)
  next.has(id) ? next.delete(id) : next.add(id)
  picked.value = next
}
const deleting = ref(false)

// ── files ──
type F = { name: string; kind: 'folder' | 'file'; size: string; changed: string; tone?: 'positive' | 'warning'; tag?: string }
const files: F[] = [
  { name: 'src', kind: 'folder', size: '—', changed: '2h ago' },
  { name: 'docs', kind: 'folder', size: '—', changed: '3d ago' },
  { name: 'notebooks', kind: 'folder', size: '—', changed: '1w ago' },
  { name: 'README.md', kind: 'file', size: '4.2 KB', changed: '3d ago' },
  { name: 'analysis-draft.md', kind: 'file', size: '1.8 KB', changed: '12m ago', tag: 'Touched by session', tone: 'positive' },
  { name: 'churn-model.ipynb', kind: 'file', size: '212 KB', changed: '1h ago', tag: 'Touched by session', tone: 'positive' },
  { name: 'data.csv', kind: 'file', size: '1.1 MB', changed: '2w ago' },
  { name: 'notes (copy).txt', kind: 'file', size: '640 B', changed: '3w ago' },
]
const fileMenu = (f: F): MenuItem[] => [
  { id: 'open', label: f.kind === 'folder' ? 'Open' : 'Preview', icon: 'file' },
  { id: 'rename', label: 'Rename', icon: 'pencil', shortcut: 'F2' },
  { id: 'move', label: 'Move to…', icon: 'folder', shortcut: '⌘M' },
  { id: 'dup', label: 'Duplicate', icon: 'copy' },
  { id: 'copy', label: 'Copy path', icon: 'link' },
  { id: 'attach', label: 'Attach to a session', icon: 'paperclip' },
  { type: 'separator' },
  { id: 'delete', label: 'Move to trash', icon: 'trash', destructive: true, shortcut: '⌫' },
]
const sel = ref(new Set<string>(view.value === 'files' ? ['notes (copy).txt'] : ['analysis-draft.md']))
const toggleFile = (n: string) => {
  const next = new Set(sel.value)
  next.has(n) ? next.delete(n) : next.add(n)
  sel.value = next
}
const moving = ref(false)
const renaming = ref(false)
// open the dialog a design view is about once mounted (the dialog opens on a change, not at first render)
onMounted(() => {
  deleting.value = view.value === 'library-delete'
  moving.value = view.value === 'files-move'
  renaming.value = view.value === 'files-rename'
})
const newName = ref('analysis-draft.md')
const target = ref('docs/analysis')
const dest = [
  { path: '.', depth: 0 },
  { path: 'src', depth: 1 },
  { path: 'docs', depth: 1 },
  { path: 'docs/analysis', depth: 2 },
  { path: 'docs/plans', depth: 2 },
  { path: 'notebooks', depth: 1 },
]
const isFiles = computed(() => view.value.startsWith('files'))
</script>

<template>
  <!-- LIBRARY -->
  <div v-if="!isFiles" class="ux">
    <IuPageHeader
      title="Library"
      subtitle="Everything your sessions can draw on: instructions, skills, subagents, MCP servers, settings and plugins"
      icon="folder"
    >
      <template #actions>
        <IuButton variant="secondary">Global instructions</IuButton>
        <IuButton variant="ghost">Rescan</IuButton>
        <IuButton variant="primary">{{ kind === 'mcp' ? 'Add MCP server' : 'New skill' }}</IuButton>
      </template>
    </IuPageHeader>

    <IuTabs v-model="kind" :tabs="tabs" :lazy="false" overflow="wrap" :panels="false" id-base="ux" />

    <div class="ux__bar" role="toolbar" aria-label="Bulk actions" v-if="picked.size">
      <strong>{{ picked.size }} selected</strong>
      <IuButton size="sm" variant="secondary"><template #icon><IuIcon name="play" /></template>Enable</IuButton>
      <IuButton size="sm" variant="secondary"><template #icon><IuIcon name="pause" /></template>Disable</IuButton>
      <IuButton size="sm" variant="secondary"><template #icon><IuIcon name="plus" /></template>Install…</IuButton>
      <IuButton size="sm" variant="secondary"><template #icon><IuIcon name="trash" /></template>Delete…</IuButton>
      <IuButton size="sm" variant="ghost" @click="picked = new Set()">Clear</IuButton>
    </div>
    <IuCallout v-else-if="kind === 'mcp'" intent="warning" variant="inline">
      2 servers won't start a session until you finish setting them up.
    </IuCallout>

    <!-- skills-style table -->
    <table v-if="kind !== 'mcp'" class="ux__table">
      <thead>
        <tr>
          <th style="width: 36px"></th>
          <th>Name</th>
          <th>Description</th>
          <th style="width: 120px">Used in</th>
          <th style="width: 100px">Updated</th>
          <th style="width: 90px">Enabled</th>
          <th style="width: 48px"></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="s in skills" :key="s.id" :class="{ 'is-off': !s.on }">
          <td><IuCheckbox :model-value="picked.has(s.id)" :aria-label="`Select ${s.name}`" @update:model-value="toggleRow(s.id)" /></td>
          <td>
            <a class="ux__name">{{ s.name }}</a>
            <IuBadge v-if="!s.on" size="xs" intent="neutral">Disabled</IuBadge>
            <span class="ux__mono">{{ s.id }}</span>
          </td>
          <td class="ux__muted">{{ s.desc }}</td>
          <td class="ux__muted">{{ s.used }}</td>
          <td class="ux__muted">{{ s.updated }}</td>
          <td><IuSwitch v-model="s.on" size="sm" :aria-label="`Enable ${s.name}`" /></td>
          <td>
            <IuMenu :items="rowMenu(s.on, 'skill')" fixed>
              <template #trigger="{ toggle }">
                <IuButton variant="ghost" size="sm" icon-only aria-label="More actions" @click="toggle"><template #icon><IuIcon name="more" /></template></IuButton>
              </template>
            </IuMenu>
          </td>
        </tr>
      </tbody>
    </table>

    <!-- MCP servers: the former /mcp screen, as a Library tab -->
    <template v-else>
      <table class="ux__table">
        <thead>
          <tr>
            <th style="width: 36px"></th>
            <th>Server</th>
            <th>Connection</th>
            <th style="width: 190px">Status</th>
            <th style="width: 110px">Used in</th>
            <th style="width: 90px">Enabled</th>
            <th style="width: 120px"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in mcps" :key="s.id" :class="{ 'is-off': !s.on }">
            <td><IuCheckbox :model-value="picked.has(s.id)" :aria-label="`Select ${s.name}`" @update:model-value="toggleRow(s.id)" /></td>
            <td>
              <a class="ux__name">{{ s.name }}</a>
              <span class="ux__sub">{{ s.desc }}</span>
            </td>
            <td>
              <IuBadge variant="tag" size="xs">{{ s.transport }}</IuBadge>
              <code class="ux__mono ux__inline">{{ s.target }}</code>
            </td>
            <td><IuBadge :intent="s.on ? s.tone : 'neutral'" size="xs" dot>{{ s.on ? s.auth : 'Disabled' }}</IuBadge></td>
            <td class="ux__muted">{{ s.used }}</td>
            <td><IuSwitch v-model="s.on" size="sm" :aria-label="`Enable ${s.name}`" /></td>
            <td><div class="ux__actions">
              <IuButton size="sm" variant="secondary" v-if="s.tone === 'warning' && s.on">{{ s.auth === 'Sign in needed' ? 'Sign in' : 'Set secret' }}</IuButton>
              <IuMenu :items="rowMenu(s.on, 'server')" fixed>
                <template #trigger="{ toggle }">
                  <IuButton variant="ghost" size="sm" icon-only aria-label="More actions" @click="toggle"><template #icon><IuIcon name="more" /></template></IuButton>
                </template>
              </IuMenu>
            </div></td>
          </tr>
        </tbody>
      </table>
      <section class="ux__secrets">
        <header>
          <h2>Secrets</h2>
          <span class="ux__muted">Stored in Odin's vault. Servers refer to them as <code>${secret:NAME}</code>.</span>
          <IuButton size="sm" variant="secondary"><template #icon><IuIcon name="plus" /></template>Add secret</IuButton>
        </header>
        <ul>
          <li><code>GITHUB_TOKEN</code><span class="ux__muted">used by GitHub</span><span class="ux__muted">Set 3d ago</span><IuButton size="sm" variant="ghost">Replace</IuButton><IuButton size="sm" variant="ghost">Remove</IuButton></li>
          <li><code>DATABASE_URL</code><IuBadge intent="warning" size="xs" dot>Not set</IuBadge><span class="ux__muted">used by Postgres</span><IuButton size="sm" variant="secondary">Set value</IuButton></li>
        </ul>
      </section>
    </template>

    <IuModal v-model:open="deleting" size="sm">
      <template #header><strong>Delete “SQL explain”?</strong></template>
      <p class="ux__p">It is installed in <strong>2 projects</strong>. Deleting removes it from the Library and from those projects' next sessions. Files already copied into a project stay where they are.</p>
      <IuCallout intent="info" variant="inline">Just want to pause it? Disable keeps it in the Library and installed, but new sessions skip it.</IuCallout>
      <template #footer>
        <IuButton variant="ghost" @click="deleting = false">Cancel</IuButton>
        <IuButton variant="secondary"><template #icon><IuIcon name="pause" /></template>Disable instead</IuButton>
        <IuButton variant="danger"><template #icon><IuIcon name="trash" /></template>Delete</IuButton>
      </template>
    </IuModal>
  </div>

  <!-- FILES -->
  <div v-else class="ux ux--files">
    <IuPageHeader title="Files" subtitle="odin / docs" icon="folder">
      <template #actions>
        <IuButton variant="secondary"><template #icon><IuIcon name="plus" /></template>New file</IuButton>
        <IuButton variant="secondary"><template #icon><IuIcon name="folder" /></template>New folder</IuButton>
        <IuButton variant="ghost"><template #icon><IuIcon name="paperclip" /></template>Upload</IuButton>
      </template>
    </IuPageHeader>

    <div class="ux__split">
      <div class="ux__list">
        <div class="ux__crumbs"><a>odin</a> / <a>docs</a> / <strong>analysis</strong><span class="ux__muted ux__right">Drag a row onto a folder to move it</span></div>
        <div class="ux__bar" role="toolbar" aria-label="Selection actions" v-if="sel.size">
          <strong>{{ sel.size }} selected</strong>
          <IuButton size="sm" variant="secondary" :disabled="sel.size > 1"><template #icon><IuIcon name="pencil" /></template>Rename</IuButton>
          <IuButton size="sm" variant="secondary"><template #icon><IuIcon name="folder" /></template>Move to…</IuButton>
          <IuButton size="sm" variant="secondary"><template #icon><IuIcon name="copy" /></template>Duplicate</IuButton>
          <IuButton size="sm" variant="secondary"><template #icon><IuIcon name="trash" /></template>Trash</IuButton>
          <IuButton size="sm" variant="ghost" @click="sel = new Set()">Clear</IuButton>
        </div>
        <table class="ux__table">
          <thead>
            <tr><th style="width: 36px"></th><th>Name</th><th style="width: 90px">Size</th><th style="width: 100px">Changed</th><th style="width: 48px"></th></tr>
          </thead>
          <tbody>
            <tr v-for="f in files" :key="f.name" :class="{ 'is-sel': sel.has(f.name) }">
              <td><IuCheckbox :model-value="sel.has(f.name)" :aria-label="`Select ${f.name}`" @update:model-value="toggleFile(f.name)" /></td>
              <td>
                <IuIcon :name="f.kind === 'folder' ? 'folder' : 'file'" />
                <a class="ux__name">{{ f.name }}</a>
                <IuBadge v-if="f.tag" :intent="f.tone" size="xs" dot>{{ f.tag }}</IuBadge>
              </td>
              <td class="ux__muted">{{ f.size }}</td>
              <td class="ux__muted">{{ f.changed }}</td>
              <td>
                <IuMenu :items="fileMenu(f)" fixed>
                  <template #trigger="{ toggle }">
                    <IuButton variant="ghost" size="sm" icon-only aria-label="More actions" @click="toggle"><template #icon><IuIcon name="more" /></template></IuButton>
                  </template>
                </IuMenu>
              </td>
            </tr>
          </tbody>
        </table>
        <div class="ux__toast" role="status">
          Moved <strong>draft-v1.md</strong> to trash · kept 7 days
          <IuButton size="sm" variant="ghost">Undo</IuButton>
        </div>
      </div>

      <aside class="ux__side" aria-label="File preview">
        <header>
          <IuIcon name="file" />
          <strong>analysis-draft.md</strong>
          <span class="ux__muted">1.8 KB · changed 12m ago</span>
        </header>
        <div class="ux__sideactions">
          <IuButton size="sm" variant="secondary" @click="renaming = true"><template #icon><IuIcon name="pencil" /></template>Rename</IuButton>
          <IuButton size="sm" variant="secondary" @click="moving = true"><template #icon><IuIcon name="folder" /></template>Move…</IuButton>
          <IuButton size="sm" variant="secondary"><template #icon><IuIcon name="copy" /></template>Duplicate</IuButton>
          <IuButton size="sm" variant="ghost"><template #icon><IuIcon name="trash" /></template>Trash</IuButton>
        </div>
        <div class="ux__preview">
          <h3># Churn analysis</h3>
          <p class="ux__muted">Draft written by the session. Retention drops sharply after week 6; three cohorts account for most of it…</p>
        </div>
      </aside>
    </div>

    <IuModal v-model:open="moving" size="sm">
      <template #header><strong>Move “analysis-draft.md”</strong></template>
      <p class="ux__muted ux__p">Choose a folder in odin.</p>
      <ul class="ux__tree" role="listbox" aria-label="Destination folder">
        <li v-for="d in dest" :key="d.path" role="option" :aria-selected="target === d.path" :class="{ 'is-on': target === d.path }" :style="{ paddingLeft: 12 + d.depth * 18 + 'px' }" @click="target = d.path">
          <IuIcon name="folder" /> {{ d.path === '.' ? 'odin (project root)' : d.path.split('/').pop() }}
          <IuIcon v-if="target === d.path" name="check" />
        </li>
      </ul>
      <p class="ux__muted ux__p">New location: <code>{{ target === '.' ? '' : target + '/' }}analysis-draft.md</code></p>
      <template #footer>
        <IuButton variant="ghost"><template #icon><IuIcon name="plus" /></template>New folder</IuButton>
        <IuButton variant="ghost" @click="moving = false">Cancel</IuButton>
        <IuButton variant="primary">Move here</IuButton>
      </template>
    </IuModal>

    <IuModal v-model:open="renaming" size="sm">
      <template #header><strong>Rename file</strong></template>
      <label class="ux__label" for="ux-rename">Name</label>
      <input id="ux-rename" v-model="newName" class="ux__input" />
      <IuCallout intent="warning" variant="inline">A running session has this file open. It will keep working, and Odin will point it at the new name.</IuCallout>
      <template #footer>
        <IuButton variant="ghost" @click="renaming = false">Cancel</IuButton>
        <IuButton variant="primary">Rename</IuButton>
      </template>
    </IuModal>
  </div>
</template>

<style>
.ux { display: flex; flex-direction: column; gap: 14px; padding-top: 16px; }
.ux__table { width: 100%; border-collapse: collapse; font-size: var(--iu-font-size-13); }
.ux__table th { text-align: left; font-weight: var(--iu-font-weight-medium); color: var(--iu-text-muted); padding: 8px 10px; border-bottom: 1px solid var(--iu-border); }
.ux__table td { padding: 10px; border-bottom: 1px solid var(--iu-border); vertical-align: middle; }
.ux__table tr.is-off td { opacity: 0.6; }
.ux__table tr.is-off td:last-child, .ux__table tr.is-off td:nth-last-child(2) { opacity: 1; }
.ux__table tr.is-sel td { background: var(--iu-surface-2); }
.ux__name { color: var(--iu-text); font-weight: var(--iu-font-weight-medium); margin: 0 8px 0 6px; cursor: pointer; }
.ux__sub, .ux__mono { display: block; font-size: var(--iu-font-size-12); color: var(--iu-text-muted); }
.ux__mono { font-family: var(--iu-font-mono); }
.ux__inline { display: inline; margin-left: 6px; }
.ux__muted { color: var(--iu-text-2); }
.ux__right { float: right; font-size: var(--iu-font-size-12); }
.ux__actions { display: flex; gap: 6px; align-items: center; justify-content: flex-end; }
.ux__bar { display: flex; gap: 8px; align-items: center; padding: 8px 12px; background: var(--iu-surface-2); border: 1px solid var(--iu-border); border-radius: 8px; font-size: var(--iu-font-size-13); }
.ux__bar strong { margin-right: 8px; }
.ux__secrets { border: 1px solid var(--iu-border); border-radius: 10px; padding: 14px 16px; }
.ux__secrets header { display: flex; gap: 12px; align-items: center; margin-bottom: 8px; }
.ux__secrets h2 { margin: 0; font-size: var(--iu-font-size-14); }
.ux__secrets header .iu-button { margin-left: auto; }
.ux__secrets ul { list-style: none; margin: 0; padding: 0; }
.ux__secrets li { display: flex; gap: 14px; align-items: center; padding: 8px 0; border-top: 1px solid var(--iu-border); font-size: var(--iu-font-size-13); }
.ux__secrets li code { min-width: 150px; }
.ux__secrets li .iu-button:nth-last-child(2) { margin-left: auto; }
.ux__p { margin: 0 0 12px; font-size: var(--iu-font-size-13); }
.ux__split { display: grid; grid-template-columns: 1fr 340px; gap: 20px; align-items: start; }
.ux__list { position: relative; display: flex; flex-direction: column; gap: 12px; }
.ux__crumbs { font-size: var(--iu-font-size-13); }
.ux__crumbs a { color: var(--iu-text-2); cursor: pointer; }
.ux__side { border: 1px solid var(--iu-border); border-radius: 10px; padding: 14px; display: flex; flex-direction: column; gap: 12px; }
.ux__side header { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.ux__side header span { width: 100%; font-size: var(--iu-font-size-12); }
.ux__sideactions { display: flex; flex-wrap: wrap; gap: 6px; }
.ux__preview { border-top: 1px solid var(--iu-border); padding-top: 10px; font-size: var(--iu-font-size-13); }
.ux__preview h3 { margin: 0 0 6px; font-size: var(--iu-font-size-14); }
.ux__toast { align-self: flex-start; padding: 8px 12px; border: 1px solid var(--iu-border); border-radius: 8px; background: var(--iu-surface-2); font-size: var(--iu-font-size-13); display: flex; gap: 10px; align-items: center; }
.ux__tree { list-style: none; margin: 0 0 12px; padding: 4px; border: 1px solid var(--iu-border); border-radius: 8px; }
.ux__tree li { display: flex; gap: 8px; align-items: center; padding: 7px 12px; border-radius: 6px; cursor: pointer; font-size: var(--iu-font-size-13); }
.ux__tree li .iu-icon:last-child { margin-left: auto; }
.ux__tree li.is-on { background: var(--iu-surface-2); font-weight: var(--iu-font-weight-medium); }
.ux__label { display: block; font-size: var(--iu-font-size-12); color: var(--iu-text-2); margin-bottom: 4px; }
.ux__input { width: 100%; box-sizing: border-box; padding: 8px 10px; margin-bottom: 12px; border: 1px solid var(--iu-border); border-radius: 6px; background: var(--iu-surface); color: var(--iu-text); font: inherit; }
</style>
