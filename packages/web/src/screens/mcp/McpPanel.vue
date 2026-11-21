<script setup lang="ts">
// The MCP servers section of the Library: the library's servers with whether each can start (signed in, secrets set), a Connect button for the
// ones that use OAuth, and the secrets vault their specs refer to.
import { computed, ref, watch } from 'vue'
import type { McpOAuthStatus, SecretsResponse } from '@odin/shared/api'
import { useApi } from '@/api'
import { IuBadge } from '@/components/Badge'
import { IuButton } from '@/components/Button'
import { IuCallout } from '@/components/Callout'
import { IuDialog } from '@/components/Modal'
import { IuCheckbox, IuSwitch } from '@/components/Fields'
import { IuIcon } from '@/components/Icon'
import { IuMenu } from '@/components/Menu'
import { IuEmpty, IuErrorState, IuSkeleton } from '@/components/States'
import { useToast } from '@/components/Toast'
import { plural, relativeTime } from '@/screens/shared/format'
import { useResource, useServerEvents } from '@/screens/shared/useResource'
import { assetMenu, type RowAction } from '@/screens/library/libraryActions'
import { mcpRows, needsAttention, oauthIds, type McpRow } from './mcpModel'
import { useMcpSignIn } from './useMcpSignIn'
import SecretModal from './SecretModal.vue'

const props = defineProps<{ installs: Record<string, number> | null }>()
const selected = defineModel<Set<string | number>>('selected', { default: () => new Set() })
const emit = defineEmits<{
  action: [id: string, action: RowAction]
  toggle: [id: string, enabled: boolean]
}>()

const api = useApi()
const { toast } = useToast()

const lib = useResource(() => api.listLibrary('mcp'))
const vault = useResource<SecretsResponse>(() => api.listSecrets())
void lib.load()
void vault.load()
useServerEvents(
  e => {
    if (e.type === 'library.updated') void refresh()
  },
  () => void refresh(),
)

const signIn = useMcpSignIn()
async function refresh() {
  await Promise.all([lib.load(), vault.load()])
  await signIn.load(oauthIds(rows.value))
}

const rows = computed(() =>
  mcpRows(lib.data.value ?? [], vault.data.value, signIn.status.value).map(r => ({
    ...r,
    used: props.installs ? (props.installs[`mcp/${r.id}`] ?? 0) : null,
  })),
)
// sign-in states arrive after the library, one request per OAuth server
watch(
  () => oauthIds(rows.value).join(','),
  key => void signIn.load(key ? key.split(',') : []),
  { immediate: true },
)

const attention = computed(() => rows.value.filter(needsAttention).length)

const allSelected = computed(
  () => rows.value.length > 0 && rows.value.every(r => selected.value.has(r.id)),
)
const someSelected = computed(
  () => rows.value.some(r => selected.value.has(r.id)) && !allSelected.value,
)
function toggleAll(on: boolean) {
  selected.value = on ? new Set(rows.value.map(r => r.id)) : new Set()
}
function toggleRow(id: string, on: boolean) {
  const next = new Set(selected.value)
  if (on) next.add(id)
  else next.delete(id)
  selected.value = next
}

function oauthState(row: McpRow): McpOAuthStatus | 'loading' | 'unknown' | null {
  return row.auth.kind === 'oauth' ? row.auth.status : null
}

// ── secrets ─────────────────────────────────────────────────────────────────
type SecretRow = {
  name: string
  usedBy: string[]
  updatedAt: string | null
  missing: boolean
  actions: null
}
const secretRows = computed<SecretRow[]>(() => {
  const v = vault.data.value
  if (!v) return []
  return [
    ...v.missing.map(m => ({
      name: m.name,
      usedBy: m.usedBy,
      updatedAt: null,
      missing: true,
      actions: null,
    })),
    ...v.secrets.map(s => ({
      name: s.name,
      usedBy: s.usedBy,
      updatedAt: s.updatedAt,
      missing: false,
      actions: null,
    })),
  ]
})
const editing = ref<{ name?: string } | null>(null)
const editOpen = computed({
  get: () => editing.value !== null,
  set: v => {
    if (!v) editing.value = null
  },
})
function saved(name: string) {
  toast({ title: `Saved ${name}`, intent: 'success' })
  void refresh()
}

const removing = ref<string | null>(null)
const removeOpen = computed({
  get: () => removing.value !== null,
  set: v => {
    if (!v) removing.value = null
  },
})
async function remove() {
  const name = removing.value
  if (!name) return
  try {
    await api.deleteSecret(name)
    toast({ title: `Deleted ${name}`, intent: 'success' })
    removing.value = null
    await refresh()
  } catch (e) {
    toast({
      title: `Couldn't delete ${name}`,
      description: e instanceof Error ? e.message : String(e),
      intent: 'danger',
    })
  }
}
</script>

<template>
  <div class="mcp">
    <IuSkeleton v-if="lib.phase.value === 'loading'" shape="table" :rows="5" />
    <IuErrorState
      v-else-if="lib.phase.value === 'error'"
      title="Couldn't load MCP servers"
      :body="lib.error.value?.message ?? 'Unknown error'"
      :trace-id="`mcp.load.${lib.error.value?.status ?? 0}`"
      @retry="refresh()"
    />
    <template v-else>
      <section class="mcp__section">
        <IuCallout v-if="attention" intent="warning" variant="inline">
          {{ plural(attention, 'server') }}
          won't start a session until you finish setting
          {{ attention === 1 ? 'it' : 'them' }} up.
        </IuCallout>
        <IuCallout v-if="signIn.signingIn.value" intent="info" variant="inline" live>
          Finish signing in to {{ signIn.signingIn.value.name }} in the browser tab that opened.
          <a :href="signIn.signingIn.value.url" target="_blank" rel="noopener noreferrer"
            >Open the sign-in page</a
          >
          if it didn't.
        </IuCallout>
        <IuEmpty
          v-if="!rows.length"
          title="No MCP servers yet"
          body="Add one with New MCP server. Remote servers can sign in with OAuth, and any server can keep tokens in the secrets below."
        />
        <div v-else class="mcp__list">
          <div class="mcp__list-head">
            <span class="mcp__check">
              <IuCheckbox
                :model-value="allSelected"
                :indeterminate="someSelected"
                aria-label="Select all MCP servers"
                @update:model-value="toggleAll"
              />
            </span>
            <span>Server</span>
            <span />
            <span />
            <span />
          </div>
          <div v-for="row in rows" :key="row.id" class="mcp__item">
            <span class="mcp__check">
              <IuCheckbox
                :model-value="selected.has(row.id)"
                :aria-label="`Select ${row.name}`"
                @update:model-value="on => toggleRow(row.id, on)"
              />
            </span>
            <div class="mcp__identity">
              <div class="mcp__name-row">
                <RouterLink
                  class="mcp__name"
                  :to="{ name: 'library-asset', params: { kind: 'mcp', id: row.id } }"
                  >{{ row.name }}</RouterLink
                >
                <IuBadge v-if="!row.enabled" size="xs" intent="neutral">Disabled</IuBadge>
                <IuBadge v-if="row.auth.kind === 'error'" intent="danger" size="xs"
                  >Has errors</IuBadge
                >
                <template v-else-if="row.auth.kind === 'oauth'">
                  <span v-if="oauthState(row) === 'loading'" class="mcp__hint">Checking…</span>
                  <IuBadge v-else-if="oauthState(row) === 'unknown'" intent="neutral" size="xs"
                    >Can't tell</IuBadge
                  >
                  <IuBadge
                    v-else-if="(oauthState(row) as McpOAuthStatus).state === 'connected'"
                    intent="positive"
                    dot
                    size="xs"
                    >Signed in</IuBadge
                  >
                  <IuBadge v-else intent="warning" size="xs">Needs sign-in</IuBadge>
                </template>
                <template v-else-if="row.auth.kind === 'secrets'">
                  <IuBadge v-if="row.missing.length" intent="warning" size="xs"
                    >Missing {{ row.missing.join(', ') }}</IuBadge
                  >
                  <IuBadge v-else intent="positive" dot size="xs">Secrets set</IuBadge>
                </template>
                <span v-else-if="row.auth.kind === 'local'" class="mcp__hint">Local</span>
              </div>
              <span v-if="row.description" class="mcp__sub">{{ row.description }}</span>
              <span class="mcp__target-line">
                <IuBadge variant="tag" size="xs">{{
                  row.transport === 'stdio' ? 'local' : row.transport
                }}</IuBadge>
                <code class="mcp__target">{{ row.target }}</code>
              </span>
            </div>
            <span class="mcp__meta">
              <span v-if="row.used === null">…</span>
              <span v-else-if="row.used === 0">Not installed</span>
              <span v-else>{{ plural(row.used, 'project') }}</span>
            </span>
            <IuSwitch
              size="sm"
              :model-value="row.enabled"
              :aria-label="`Enable ${row.name}`"
              @update:model-value="emit('toggle', row.id, $event)"
            />
            <div class="mcp__actions">
              <template v-if="row.enabled && row.oauth">
                <IuButton
                  size="sm"
                  :variant="
                    typeof oauthState(row) === 'object' &&
                    (oauthState(row) as McpOAuthStatus).state === 'connected'
                      ? 'ghost'
                      : 'primary'
                  "
                  :loading="signIn.signingIn.value?.id === row.id"
                  @click="signIn.connect(row.id, row.name)"
                >
                  {{
                    typeof oauthState(row) === 'object' &&
                    (oauthState(row) as McpOAuthStatus).state === 'connected'
                      ? 'Sign in again'
                      : 'Sign in'
                  }}
                </IuButton>
                <IuButton
                  v-if="
                    typeof oauthState(row) === 'object' &&
                    (oauthState(row) as McpOAuthStatus).state === 'connected'
                  "
                  size="sm"
                  variant="ghost"
                  @click="signIn.disconnect(row.id, row.name)"
                  >Sign out</IuButton
                >
              </template>
              <IuMenu
                :items="assetMenu('mcp', row.enabled)"
                fixed
                @select="emit('action', row.id, $event as RowAction)"
              >
                <template #trigger="{ toggle }">
                  <IuButton
                    variant="ghost"
                    size="sm"
                    icon-only
                    :aria-label="`More actions for ${row.name}`"
                    @click="toggle"
                  >
                    <template #icon><IuIcon name="more" /></template>
                  </IuButton>
                </template>
              </IuMenu>
            </div>
          </div>
        </div>
      </section>

      <section class="mcp__section" aria-labelledby="mcp-secrets">
        <div class="mcp__row">
          <h2 id="mcp-secrets" class="mcp__h">Secrets</h2>
          <IuButton size="sm" variant="secondary" @click="editing = {}">Add secret</IuButton>
        </div>
        <p class="mcp__note">
          A server's arguments, environment, URL and headers can use
          <code>${secret:NAME}</code>. Odin fills in the value when a session starts, and never
          writes it to the library, the project or a log.
        </p>
        <IuErrorState
          v-if="vault.phase.value === 'error'"
          title="Couldn't load secrets"
          :body="vault.error.value?.message ?? 'Unknown error'"
          :trace-id="`secrets.load.${vault.error.value?.status ?? 0}`"
          @retry="vault.load()"
        />
        <IuEmpty
          v-else-if="vault.phase.value === 'ready' && !secretRows.length"
          title="No secrets yet"
          body="Add one when a server needs a token or key."
        />
        <div v-else-if="secretRows.length" class="mcp__secrets" role="table">
          <div class="mcp__secret-head" role="row">
            <span role="columnheader">Name</span>
            <span role="columnheader">Used by</span>
            <span role="columnheader">Updated</span>
            <span role="columnheader" />
          </div>
          <div v-for="row in secretRows" :key="row.name" class="mcp__secret" role="row">
            <span role="cell">
              <code>{{ row.name }}</code>
              <IuBadge v-if="row.missing" class="mcp__badge" intent="warning" size="xs"
                >Not set</IuBadge
              >
            </span>
            <span role="cell">
              <span v-if="row.usedBy.length">{{ row.usedBy.join(', ') }}</span>
              <span v-else class="mcp__sub">No server uses it</span>
            </span>
            <span class="mcp__used" role="cell">
              <template v-if="row.updatedAt">{{ relativeTime(row.updatedAt) }}</template>
            </span>
            <span class="mcp__more" role="cell">
              <IuButton size="sm" variant="ghost" @click="editing = { name: row.name }">{{
                row.missing ? 'Set value' : 'Replace'
              }}</IuButton>
              <IuButton v-if="!row.missing" size="sm" variant="ghost" @click="removing = row.name"
                >Delete</IuButton
              >
            </span>
          </div>
        </div>
      </section>
    </template>

    <SecretModal v-model:open="editOpen" :existing="editing?.name" @saved="saved" />

    <IuDialog v-model:open="removeOpen" size="sm">
      <template #header>
        <h2 class="mcp__h">Delete {{ removing }}?</h2>
      </template>
      <p class="mcp__note">
        Servers that use it won't start a session until you set it again. This can't be undone.
      </p>
      <template #footer>
        <IuButton variant="secondary" size="sm" @click="removing = null">Cancel</IuButton>
        <IuButton variant="danger" size="sm" @click="remove">Delete</IuButton>
      </template>
    </IuDialog>
  </div>
</template>

<style>
.mcp {
  display: flex;
  flex-direction: column;
  gap: 36px;
}
.mcp__section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.mcp__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.mcp__h {
  margin: 0;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11);
  font-weight: var(--iu-font-weight-medium);
  letter-spacing: var(--iu-tracking-caps);
  text-transform: uppercase;
  color: var(--iu-text-muted);
}
.mcp__note {
  margin: 0;
  color: var(--iu-text-2);
  font-size: var(--iu-font-size-13);
}
.mcp__list,
.mcp__secrets {
  border-top: 1px solid var(--iu-hairline);
}
.mcp__list-head,
.mcp__item {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr) auto 32px auto;
  align-items: center;
  gap: 8px 10px;
  min-height: 38px;
  border-bottom: 1px solid var(--iu-hairline);
}
.mcp__list-head,
.mcp__secret-head {
  min-height: 0;
  padding: 6px 0;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-10);
  letter-spacing: var(--iu-tracking-caps);
  text-transform: uppercase;
  color: var(--iu-text-muted);
}
.mcp__check {
  display: flex;
  justify-content: center;
}
.mcp__identity {
  min-width: 0;
  padding: 8px 0;
}
.mcp__name-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.mcp__name {
  font-weight: var(--iu-font-weight-medium);
  color: inherit;
}
.mcp__name:hover {
  text-decoration: underline;
}
.mcp__actions {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 4px;
}
.mcp__badge {
  margin-left: 8px;
}
.mcp__sub {
  display: block;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mcp__target-line {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.mcp__target {
  min-width: 0;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mcp__meta {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11-5);
  color: var(--iu-text-muted);
  white-space: nowrap;
}
.mcp__hint {
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
.mcp__used {
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
  text-align: right;
}
.mcp__more {
  display: flex;
  justify-content: flex-end;
}
.mcp__secret-head,
.mcp__secret {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) 72px auto;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  border-bottom: 1px solid var(--iu-hairline);
}
.mcp__secret code {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
}
</style>
