<script setup lang="ts">
// The MCP servers tab of the Library: the library's servers with whether each can start (signed in, secrets set), a Connect button for the
// ones that use OAuth, and the secrets vault their specs refer to.
import { computed, ref, watch } from 'vue'
import type { McpOAuthStatus, SecretsResponse } from '@odin/shared/api'
import { useApi } from '@/api'
import { IuBadge } from '@/components/Badge'
import { IuButton } from '@/components/Button'
import { IuCallout } from '@/components/Callout'
import { IuDialog } from '@/components/Modal'
import { IuSwitch } from '@/components/Fields'
import { IuIcon } from '@/components/Icon'
import { IuMenu } from '@/components/Menu'
import { IuEmpty, IuErrorState, IuSkeleton } from '@/components/States'
import { IuTable, type Column } from '@/components/Table'
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

type Row = McpRow & { used: number | null }
const columns: Column<Row>[] = [
  { key: 'name', header: 'Server', sortable: true, width: '22%' },
  { key: 'target', header: 'Connects to' },
  { key: 'auth', header: 'Sign-in', width: '24%' },
  { key: 'used', header: 'Used in', width: '110px' },
  { key: 'enabled', header: 'Enabled', width: '90px' },
  { key: 'actions', header: '', align: 'end', width: '240px' },
]

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
const secretColumns: Column<SecretRow>[] = [
  { key: 'name', header: 'Name', width: '30%' },
  { key: 'usedBy', header: 'Used by' },
  { key: 'updatedAt', header: 'Updated', width: '120px' },
  { key: 'actions', header: '', align: 'end', width: '180px' },
]
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
      <section class="mcp__section" aria-labelledby="mcp-servers">
        <h2 id="mcp-servers" class="mcp__h">Servers</h2>
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
        <IuTable
          v-else
          v-model:selected="selected"
          selectable="multi"
          :columns="columns"
          :rows="rows"
          :row-key="r => r.id"
        >
          <template #cell:name="{ row }">
            <RouterLink
              class="mcp__name"
              :to="{ name: 'library-asset', params: { kind: 'mcp', id: row.id } }"
              >{{ row.name }}</RouterLink
            >
            <IuBadge v-if="!row.enabled" size="xs" intent="neutral">Disabled</IuBadge>
            <span v-if="row.description" class="mcp__sub">{{ row.description }}</span>
          </template>
          <template #cell:target="{ row }">
            <IuBadge variant="tag" size="xs">{{
              row.transport === 'stdio' ? 'local' : row.transport
            }}</IuBadge>
            <code class="mcp__target">{{ row.target }}</code>
          </template>
          <template #cell:auth="{ row }">
            <IuBadge v-if="row.auth.kind === 'error'" intent="danger" size="xs">Has errors</IuBadge>
            <template v-else-if="row.auth.kind === 'oauth'">
              <span v-if="oauthState(row) === 'loading'" class="mcp__sub">Checking…</span>
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
            <span v-else-if="row.auth.kind === 'local'" class="mcp__sub">Runs on this machine</span>
            <span v-else class="mcp__sub">No sign-in</span>
          </template>
          <template #cell:used="{ row }">
            <span v-if="row.used === null" class="mcp__sub">…</span>
            <span v-else-if="row.used === 0" class="mcp__sub">Not installed</span>
            <span v-else>{{ plural(row.used, 'project') }}</span>
          </template>
          <template #cell:enabled="{ row }">
            <IuSwitch
              size="sm"
              :model-value="row.enabled"
              :aria-label="`Enable ${row.name}`"
              @update:model-value="emit('toggle', row.id, $event)"
            />
          </template>
          <template #cell:actions="{ row }">
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
          </template>
        </IuTable>
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
        <IuTable
          v-else-if="secretRows.length"
          :columns="secretColumns"
          :rows="secretRows"
          :row-key="r => r.name"
        >
          <template #cell:name="{ row }">
            <code>{{ row.name }}</code>
            <IuBadge v-if="row.missing" class="mcp__badge" intent="warning" size="xs"
              >Not set</IuBadge
            >
          </template>
          <template #cell:usedBy="{ row }">
            <span v-if="row.usedBy.length">{{ row.usedBy.join(', ') }}</span>
            <span v-else class="mcp__sub">No server uses it</span>
          </template>
          <template #cell:updatedAt="{ row }">
            <template v-if="row.updatedAt">{{ relativeTime(row.updatedAt) }}</template>
          </template>
          <template #cell:actions="{ row }">
            <IuButton size="sm" variant="ghost" @click="editing = { name: row.name }">{{
              row.missing ? 'Set value' : 'Replace'
            }}</IuButton>
            <IuButton v-if="!row.missing" size="sm" variant="ghost" @click="removing = row.name"
              >Delete</IuButton
            >
          </template>
        </IuTable>
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
  gap: 24px;
  padding-top: 16px;
}
.mcp__section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.mcp__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.mcp__h {
  margin: 0;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-semibold);
}
.mcp__note {
  margin: 0;
  color: var(--iu-text-2);
  font-size: var(--iu-font-size-13);
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
  gap: 4px;
}
.mcp__badge {
  margin-left: 8px;
}
.mcp__sub {
  display: block;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
.mcp__target {
  margin-left: 8px;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-2);
  overflow-wrap: anywhere;
}
</style>
