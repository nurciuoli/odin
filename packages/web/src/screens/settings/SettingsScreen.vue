<script setup lang="ts">
// Odin's own settings, saved as you go: defaults for new sessions, harnesses and tool paths, notifications, the
// desktop shell, the pricing table, and what Odin is connected to.
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import type { ModelInfo, PermissionMode, SettingsResponse, ToolName } from '@odin/shared/api'
import { TOOL_NAMES } from '@odin/shared/api'
import { getDesktop, type ShortcutStatus } from '@/app/desktop'
import { useApi } from '@/api'
import { IuButton } from '@/components/Button'
import { IuEyebrow } from '@/components/Eyebrow'
import { IuField, IuSwitch } from '@/components/Fields'
import { IuIcon } from '@/components/Icon'
import { IuSelect } from '@/components/Select'
import { IuErrorState, IuSkeleton } from '@/components/States'
import { PERMISSION_MODE_LABELS } from '@/screens/shared/format'
import { useResource } from '@/screens/shared/useResource'
import {
  DEFAULT_SHORTCUT,
  emptyPriceRow,
  formFromSettings,
  toolPathWarning,
  toolPathsForm,
  validateToolPaths,
  PRICE_FIELDS,
  settingsRequest,
  validatePricing,
  type AppForm,
} from './settingsModel'

interface Choice {
  id: string
  label: string
}

/** How long a text or number field must sit idle before it is saved (leaving the field saves at once). */
const DEBOUNCE_MS = 800

const api = useApi()

const res = useResource<SettingsResponse>(() => api.getSettings())
void res.load()

const models = ref<ModelInfo[]>([])
api
  .listModels()
  .then(m => (models.value = m))
  .catch(() => {
    // the default-model picker just offers "account default"
  })

const form = reactive<AppForm>({
  defaultHarness: 'claude',
  harnessDefaults: {},
  defaultModel: '',
  defaultPermissionMode: 'default',
  defaultWorktree: false,
  notifyOnWaiting: true,
  notifyOnFinished: true,
  shortcutOn: true,
  launcherShortcut: DEFAULT_SHORTCUT,
  editorCommand: 'code',
  toolPaths: toolPathsForm({}),
  pricing: [],
})
// the first load fills the form; later saves re-sync it only when nothing is waiting to be saved
watch(
  () => res.data.value,
  (r, before) => {
    if (r && !before) Object.assign(form, formFromSettings(r))
  },
  { immediate: true },
)

const modelOptions = computed<Choice[]>(() => [
  { id: '', label: 'Account default' },
  ...models.value
    .filter(m => m.value !== 'default')
    .map(m => ({ id: m.value, label: m.displayName })),
])
const modeOptions: Choice[] = (Object.keys(PERMISSION_MODE_LABELS) as PermissionMode[]).map(id => ({
  id,
  label: PERMISSION_MODE_LABELS[id],
}))
const harnessOptions = computed<Choice[]>(() =>
  (res.data.value?.harnesses ?? []).map(h => ({ id: h.id, label: h.name })),
)
const pick = (options: Choice[], id: string | undefined): Choice[] =>
  options.filter(o => o.id === id)

// What is wrong with the form. A field shows its error once it has been left (or a save was tried).
const touched = reactive<Record<string, boolean>>({})
const pricingErrors = computed(() => validatePricing(form.pricing))
const toolErrors = computed(() => validateToolPaths(form.toolPaths))
const editorError = computed(() =>
  form.editorCommand.trim() ? undefined : 'Name a command, for example code or cursor.',
)
const hasErrors = computed(
  () =>
    Object.keys(pricingErrors.value).length > 0 ||
    Object.keys(toolErrors.value).length > 0 ||
    !!editorError.value,
)
const shown = (key: string, error: string | undefined) => (touched[key] ? error : undefined)
function revealErrors() {
  for (const t of TOOL_NAMES) if (toolErrors.value[t]) touched[`tool:${t}`] = true
  if (editorError.value) touched.editor = true
  for (const i of Object.keys(pricingErrors.value)) touched[`price:${i}`] = true
}

// Autosave: one request at a time; an edit made during a save is picked up by one more run afterwards.
const changes = computed(() => (res.data.value ? settingsRequest(form, res.data.value) : null))
const saving = ref(false)
const waiting = ref(false)
const saveError = ref<string | null>(null)
let timer: ReturnType<typeof setTimeout> | null = null
let runAgain = false

function clearTimer() {
  if (timer) clearTimeout(timer)
  timer = null
  waiting.value = false
}

function saveLater() {
  if (saving.value) return
  clearTimer()
  if (!changes.value) return
  waiting.value = true
  timer = setTimeout(() => void save(), DEBOUNCE_MS)
}

async function save(): Promise<void> {
  clearTimer()
  if (!res.data.value) return
  if (saving.value) {
    runAgain = true
    return
  }
  const req = changes.value
  if (!req) return
  if (hasErrors.value) {
    revealErrors()
    return
  }
  saving.value = true
  saveError.value = null
  try {
    const next = await api.updateSettings(req)
    res.data.value = next
    if (!settingsRequest(form, next)) Object.assign(form, formFromSettings(next))
  } catch (e) {
    saveError.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
  if (runAgain) {
    runAgain = false
    await save()
  } else if (!saveError.value && changes.value && !hasErrors.value) {
    saveLater()
  }
}

/** Switches and selects: change the field and save straight away. */
function setNow<K extends keyof AppForm>(key: K, value: AppForm[K]) {
  form[key] = value
  void save()
}
/** A field was left: show its error, if any, and save. */
function leave(key: string) {
  touched[key] = true
  void save()
}

watch(form, () => {
  saveLater()
})

let observer: IntersectionObserver | null = null
// leaving the screen must not drop an edit that is waiting
onBeforeUnmount(() => {
  const pending = timer !== null
  clearTimer()
  if (pending && !hasErrors.value) void save()
  observer?.disconnect()
})

const statusText = computed(() => {
  if (saveError.value) return saveError.value
  if (saving.value || waiting.value) return 'Saving…'
  if (changes.value && hasErrors.value) return 'Not saved: fix the highlighted fields'
  return 'Saved'
})
const statusKind = computed(() => {
  if (saveError.value) return 'error'
  if (saving.value || waiting.value) return 'busy'
  return changes.value && hasErrors.value ? 'error' : 'ok'
})

// The Electron shell, when there is one. Every bridge method is optional, so each control checks its own.
const desktop = getDesktop()
const loginItem = ref<boolean | null>(null)
const loginError = ref<string | null>(null)
if (typeof desktop?.getLoginItem === 'function')
  desktop
    .getLoginItem()
    .then(on => (loginItem.value = on))
    .catch(() => (loginError.value = "Couldn't read the start-at-login setting."))
async function setLogin(on: boolean) {
  if (typeof desktop?.setLoginItem !== 'function') return
  const before = loginItem.value
  loginItem.value = on
  loginError.value = null
  try {
    await desktop.setLoginItem(on)
  } catch (e) {
    loginItem.value = before
    loginError.value = e instanceof Error ? e.message : String(e)
  }
}

const shortcut = ref<ShortcutStatus | null>(null)
async function loadShortcut() {
  if (typeof desktop?.shortcutStatus !== 'function') return
  try {
    shortcut.value = await desktop.shortcutStatus()
  } catch {
    shortcut.value = null
  }
}
void loadShortcut()
// the shell re-registers after a save; ask again once the new value is in
watch(
  () => res.data.value?.settings.launcherShortcut,
  () => void loadShortcut(),
)
const shortcutText = computed(() => {
  const s = shortcut.value
  if (!s || !s.accelerator || !s.registered) return undefined
  return `Registered: ${s.accelerator}.`
})

const logError = ref<string | null>(null)
async function openLog() {
  if (typeof desktop?.openLog !== 'function') return
  logError.value = null
  try {
    await desktop.openLog()
  } catch (e) {
    logError.value = e instanceof Error ? e.message : String(e)
  }
}

// Harnesses: one row per tool, found or not, with its settings behind a disclosure.
const TOOL_LABELS: Record<ToolName, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  grok: 'Grok',
  opencode: 'OpenCode',
  antigravity: 'Antigravity',
  gh: 'GitHub CLI',
  git: 'Git',
}
/** What each harness check found (the resolved path is in its note). gh and git have no check. */
function harnessOf(tool: ToolName) {
  return res.data.value?.harnesses.find(x => x.id === tool)
}
const hasHarnessSettings = (t: ToolName) => t === 'claude' || t === 'codex' || t === 'grok'
const isDefault = (t: ToolName) => (form.defaultHarness ?? 'claude') === t

const expanded = reactive<Partial<Record<ToolName, boolean>>>({})
const isOpen = (t: ToolName) => !!expanded[t] || !!toolErrors.value[t]
const toggleOpen = (t: ToolName) => (expanded[t] = !isOpen(t))

function modesFor(t: ToolName): Choice[] {
  const caps = harnessOf(t)?.capabilities
  return modeOptions.filter(m => !caps || caps.permissionModes.includes(m.id as PermissionMode))
}
function defaultsModel(t: ToolName): string {
  return form.harnessDefaults?.[t]?.model ?? ''
}
function defaultsMode(t: ToolName): PermissionMode {
  return t === 'claude'
    ? form.defaultPermissionMode
    : (form.harnessDefaults?.[t]?.permissionMode ?? 'default')
}
function setDefaultsModel(t: ToolName, value: string) {
  form.harnessDefaults = {
    ...form.harnessDefaults,
    [t]: {
      permissionMode: form.harnessDefaults?.[t]?.permissionMode ?? 'default',
      model: value.trim() || null,
    },
  }
}
function setDefaultsMode(t: ToolName, mode: PermissionMode | undefined) {
  if (!mode) return
  if (t === 'claude') return setNow('defaultPermissionMode', mode)
  form.harnessDefaults = {
    ...form.harnessDefaults,
    [t]: { model: form.harnessDefaults?.[t]?.model ?? null, permissionMode: mode },
  }
  void save()
}

const addRow = () => form.pricing.push(emptyPriceRow())
function removeRow(i: number) {
  form.pricing.splice(i, 1)
  for (const k of Object.keys(touched)) if (k.startsWith('price:')) delete touched[k]
  void save()
}
const PRICE_LABELS: Record<(typeof PRICE_FIELDS)[number], string> = {
  input: 'Input',
  output: 'Output',
  cacheRead: 'Cache read',
  cacheWrite: 'Cache write',
}
const PRICE_HEADS: Record<(typeof PRICE_FIELDS)[number], string> = {
  input: 'In',
  output: 'Out',
  cacheRead: 'Read',
  cacheWrite: 'Write',
}

const githubText = computed(() => {
  const g = res.data.value?.github
  if (!g?.configured)
    return 'No token found. Set GITHUB_TOKEN or sign in with the gh CLI to sync issues.'
  return g.source === 'env' ? 'Token from GITHUB_TOKEN' : 'Token from the gh CLI'
})

// Section list with scroll-spy
const sections = computed(() => [
  { id: 'settings-sessions', label: 'New sessions' },
  { id: 'settings-harnesses', label: 'Harnesses' },
  { id: 'settings-notifications', label: 'Notifications' },
  ...(desktop ? [{ id: 'settings-desktop', label: 'Desktop' }] : []),
  { id: 'settings-pricing', label: 'Pricing' },
  { id: 'settings-connections', label: 'Connections' },
])
const active = ref('settings-sessions')
const visible = new Set<string>()

function observeSections() {
  observer?.disconnect()
  visible.clear()
  if (typeof IntersectionObserver === 'undefined') return
  observer = new IntersectionObserver(
    entries => {
      for (const e of entries) {
        if (e.isIntersecting) visible.add(e.target.id)
        else visible.delete(e.target.id)
      }
      const first = sections.value.find(s => visible.has(s.id))
      if (first) active.value = first.id
    },
    { rootMargin: '-10% 0px -70% 0px' },
  )
  for (const s of sections.value) {
    const el = document.getElementById(s.id)
    if (el) observer.observe(el)
  }
}
watch(
  () => res.phase.value,
  phase => {
    if (phase === 'ready') void nextTick(observeSections)
  },
  { immediate: true },
)

function goTo(id: string) {
  active.value = id
  const reduce =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  document
    .getElementById(id)
    ?.scrollIntoView?.({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
}
</script>

<template>
  <div class="app-settings">
    <IuSkeleton v-if="res.phase.value === 'loading'" shape="card" :rows="3" />
    <IuErrorState
      v-else-if="res.phase.value === 'error'"
      title="Couldn't load the settings"
      :body="res.error.value?.message ?? 'Unknown error'"
      :trace-id="`settings.load.${res.error.value?.status ?? 0}`"
      @retry="res.load()"
    />

    <div v-else-if="res.data.value" class="app-settings__layout">
      <nav class="app-settings__nav" aria-label="Settings sections">
        <h1 class="app-settings__title">Settings</h1>
        <ul class="app-settings__links">
          <li v-for="s in sections" :key="s.id">
            <button
              type="button"
              class="app-settings__link"
              :aria-current="active === s.id ? 'true' : undefined"
              @click="goTo(s.id)"
            >
              {{ s.label }}
            </button>
          </li>
        </ul>
        <p class="app-settings__status" :data-kind="statusKind" role="status" aria-live="polite">
          <span class="app-settings__status-dot" aria-hidden="true" />
          <span>{{ statusText }}</span>
        </p>
      </nav>

      <form class="app-settings__main" novalidate @submit.prevent="save">
        <section id="settings-sessions" class="app-settings__section" aria-labelledby="h-sessions">
          <IuEyebrow id="h-sessions" as="h2" size="md">New sessions</IuEyebrow>
          <div class="app-settings__rows">
            <div class="app-settings__row">
              <span class="app-settings__label">Default harness</span>
              <div class="app-settings__control">
                <IuSelect
                  quiet
                  aria-label="Default harness"
                  :options="harnessOptions"
                  :selected="pick(harnessOptions, form.defaultHarness ?? 'claude')"
                  @update:selected="n => setNow('defaultHarness', n[0]?.id)"
                />
              </div>
            </div>
            <div class="app-settings__row">
              <IuSwitch
                size="sm"
                :model-value="form.defaultWorktree"
                @update:model-value="v => setNow('defaultWorktree', v)"
                >New worktree by default</IuSwitch
              >
            </div>
          </div>
        </section>

        <section
          id="settings-harnesses"
          class="app-settings__section"
          aria-labelledby="h-harnesses"
        >
          <IuEyebrow id="h-harnesses" as="h2" size="md">Harnesses</IuEyebrow>
          <div class="app-settings__rows">
            <div v-for="t in TOOL_NAMES" :key="t" class="app-settings__tool">
              <div class="app-settings__tool-head">
                <span
                  v-if="harnessOf(t)"
                  class="app-settings__dot"
                  :data-found="harnessOf(t)!.available ? 'yes' : 'no'"
                  :title="harnessOf(t)!.available ? 'Found' : 'Not found'"
                >
                  <span class="app-settings__sr">{{
                    harnessOf(t)!.available ? 'Found' : 'Not found'
                  }}</span>
                </span>
                <span v-else class="app-settings__dot" data-found="unknown" aria-hidden="true" />
                <span class="app-settings__tool-name">{{ TOOL_LABELS[t] }}</span>
                <span
                  v-if="harnessOf(t)?.note"
                  class="app-settings__path"
                  :title="harnessOf(t)!.note ?? undefined"
                >
                  <bdi>{{ harnessOf(t)!.note }}</bdi>
                </span>
                <span v-else class="app-settings__path" />
                <span v-if="isDefault(t) && hasHarnessSettings(t)" class="app-settings__default"
                  >Default</span
                >
                <button
                  type="button"
                  class="app-settings__chevron"
                  :aria-expanded="isOpen(t)"
                  :aria-controls="`app-settings-tool-${t}`"
                  :aria-label="`${TOOL_LABELS[t]} settings`"
                  @click="toggleOpen(t)"
                >
                  <IuIcon name="chevronRight" :size="14" />
                </button>
              </div>
              <div v-if="isOpen(t)" :id="`app-settings-tool-${t}`" class="app-settings__tool-body">
                <div class="app-settings__row app-settings__row--nested">
                  <span class="app-settings__label">Executable path</span>
                  <div class="app-settings__control" @focusout="leave(`tool:${t}`)">
                    <IuField
                      v-model="form.toolPaths[t]"
                      :label="`${TOOL_LABELS[t]} executable path`"
                      hide-label
                      quiet
                      align="end"
                      mono
                      :placeholder="`${t} on PATH`"
                      :error="shown(`tool:${t}`, toolErrors[t])"
                    />
                    <p v-if="toolPathWarning(form.toolPaths[t])" class="app-settings__warn">
                      {{ toolPathWarning(form.toolPaths[t]) }}
                    </p>
                  </div>
                </div>
                <template v-if="hasHarnessSettings(t)">
                  <div class="app-settings__row app-settings__row--nested">
                    <span class="app-settings__label">Model</span>
                    <div class="app-settings__control">
                      <IuSelect
                        v-if="t === 'claude'"
                        quiet
                        :aria-label="`${TOOL_LABELS[t]} model`"
                        :options="modelOptions"
                        :selected="pick(modelOptions, form.defaultModel)"
                        @update:selected="n => setNow('defaultModel', n[0]?.id ?? '')"
                      />
                      <div v-else @focusout="leave(`model:${t}`)">
                        <IuField
                          :label="`${TOOL_LABELS[t]} model`"
                          hide-label
                          quiet
                          align="end"
                          placeholder="Account default"
                          :model-value="defaultsModel(t)"
                          @update:model-value="v => setDefaultsModel(t, String(v))"
                        />
                      </div>
                    </div>
                  </div>
                  <div class="app-settings__row app-settings__row--nested">
                    <span class="app-settings__label">Permissions</span>
                    <div class="app-settings__control">
                      <IuSelect
                        quiet
                        :aria-label="`${TOOL_LABELS[t]} permissions`"
                        :options="modesFor(t)"
                        :selected="pick(modesFor(t), defaultsMode(t))"
                        @update:selected="n => setDefaultsMode(t, n[0]?.id as PermissionMode)"
                      />
                    </div>
                  </div>
                </template>
              </div>
            </div>
          </div>
        </section>

        <section
          id="settings-notifications"
          class="app-settings__section"
          aria-labelledby="h-notifications"
        >
          <IuEyebrow id="h-notifications" as="h2" size="md">Notifications</IuEyebrow>
          <div class="app-settings__rows">
            <div class="app-settings__row">
              <IuSwitch
                size="sm"
                :model-value="form.notifyOnWaiting"
                @update:model-value="v => setNow('notifyOnWaiting', v)"
                >A session needs me</IuSwitch
              >
            </div>
            <div class="app-settings__row">
              <IuSwitch
                size="sm"
                :model-value="form.notifyOnFinished"
                @update:model-value="v => setNow('notifyOnFinished', v)"
                >A session finishes</IuSwitch
              >
            </div>
          </div>
        </section>

        <section
          v-if="desktop"
          id="settings-desktop"
          class="app-settings__section"
          aria-labelledby="h-desktop"
        >
          <IuEyebrow id="h-desktop" as="h2" size="md">Desktop</IuEyebrow>
          <div class="app-settings__rows">
            <div v-if="typeof desktop.getLoginItem === 'function'" class="app-settings__row">
              <IuSwitch
                size="sm"
                :model-value="loginItem ?? false"
                :disabled="loginItem === null || typeof desktop.setLoginItem !== 'function'"
                @update:model-value="setLogin"
                >Start at login <span class="app-settings__hint">hidden in the tray</span></IuSwitch
              >
            </div>
            <p v-if="loginError" class="app-settings__error" role="alert">{{ loginError }}</p>
            <div class="app-settings__row">
              <IuSwitch
                size="sm"
                :model-value="form.shortcutOn"
                @update:model-value="v => setNow('shortcutOn', v)"
                >Launcher shortcut</IuSwitch
              >
            </div>
            <div v-if="form.shortcutOn" class="app-settings__row app-settings__row--nested">
              <span class="app-settings__label"
                >Shortcut
                <span v-if="shortcutText" class="app-settings__hint">{{ shortcutText }}</span></span
              >
              <div class="app-settings__control" @focusout="leave('shortcut')">
                <IuField
                  v-model="form.launcherShortcut"
                  label="Shortcut"
                  hide-label
                  quiet
                  align="end"
                  mono
                  :placeholder="DEFAULT_SHORTCUT"
                />
              </div>
            </div>
            <p
              v-if="shortcut && !shortcut.registered && shortcut.accelerator"
              class="app-settings__warn"
            >
              The launcher shortcut isn't working.
              {{ shortcut.error ?? 'The desktop app could not register it' }}. Try another
              combination.
            </p>
            <div class="app-settings__row">
              <span class="app-settings__label"
                >Editor command <span class="app-settings__hint">for Open in editor</span></span
              >
              <div class="app-settings__control" @focusout="leave('editor')">
                <IuField
                  v-model="form.editorCommand"
                  label="Editor command"
                  hide-label
                  quiet
                  align="end"
                  mono
                  placeholder="code"
                  :error="shown('editor', editorError)"
                />
              </div>
            </div>
            <div v-if="typeof desktop.openLog === 'function'" class="app-settings__row">
              <span class="app-settings__label">Log</span>
              <div class="app-settings__control app-settings__control--end">
                <IuButton type="button" variant="ghost" size="sm" @click="openLog"
                  >Open log</IuButton
                >
              </div>
            </div>
            <p v-if="logError" class="app-settings__error" role="alert">{{ logError }}</p>
          </div>
        </section>

        <section id="settings-pricing" class="app-settings__section" aria-labelledby="h-pricing">
          <IuEyebrow id="h-pricing" as="h2" size="md"
            >Pricing <span class="app-settings__hint">· USD per million tokens</span></IuEyebrow
          >
          <div class="app-settings__prices" role="group" aria-label="Model prices">
            <div class="app-settings__price-head" aria-hidden="true">
              <span>Model</span>
              <span v-for="k in PRICE_FIELDS" :key="k">{{ PRICE_HEADS[k] }}</span>
              <span />
            </div>
            <div
              v-for="(row, i) in form.pricing"
              :key="i"
              class="app-settings__price-row"
              @focusout="leave(`price:${i}`)"
            >
              <IuField v-model="row.model" label="Model" hide-label quiet mono size="sm" />
              <IuField
                v-for="k in PRICE_FIELDS"
                :key="k"
                v-model="row[k]"
                :label="`${row.model || 'New model'} ${PRICE_LABELS[k].toLowerCase()} price`"
                hide-label
                quiet
                align="end"
                mono
                size="sm"
                type="number"
              />
              <IuButton
                type="button"
                variant="ghost"
                size="sm"
                icon-only
                :aria-label="`Remove ${row.model || 'row'}`"
                @click="removeRow(i)"
              >
                <template #icon><IuIcon name="trash" :size="14" /></template>
              </IuButton>
              <p
                v-if="shown(`price:${i}`, pricingErrors[i])"
                class="app-settings__error app-settings__price-error"
                role="alert"
              >
                {{ pricingErrors[i] }}
              </p>
            </div>
          </div>
          <div class="app-settings__add">
            <IuButton type="button" variant="ghost" size="sm" @click="addRow">
              <template #icon><IuIcon name="plus" :size="14" /></template>
              Add model
            </IuButton>
          </div>
          <p class="app-settings__hint app-settings__note">
            Models missing here use a harness-reported cost when available.
          </p>
        </section>

        <section
          id="settings-connections"
          class="app-settings__section"
          aria-labelledby="h-connections"
        >
          <IuEyebrow id="h-connections" as="h2" size="md">Connections</IuEyebrow>
          <div class="app-settings__rows">
            <div class="app-settings__row">
              <span class="app-settings__label">GitHub</span>
              <div class="app-settings__control app-settings__value">
                <span
                  class="app-settings__dot"
                  :data-found="res.data.value.github.configured ? 'yes' : 'no'"
                  :title="res.data.value.github.configured ? 'Connected' : 'No token'"
                >
                  <span class="app-settings__sr">{{
                    res.data.value.github.configured ? 'Connected' : 'No token'
                  }}</span>
                </span>
                <span>{{ githubText }}</span>
              </div>
            </div>
            <div class="app-settings__row">
              <span class="app-settings__label">Library</span>
              <div class="app-settings__control app-settings__value app-settings__value--mono">
                <span class="app-settings__path" :title="res.data.value.libraryPath"
                  ><bdi>{{ res.data.value.libraryPath }}</bdi></span
                >
              </div>
            </div>
          </div>
        </section>
      </form>
    </div>

    <p v-if="res.phase.value === 'ready' && !res.data.value" class="app-settings__note">
      Settings are not available.
    </p>
  </div>
</template>

<style>
.app-settings {
  padding: 8px 0 64px;
  min-width: 0;
}
.app-settings__layout {
  display: grid;
  grid-template-columns: minmax(120px, 168px) minmax(0, 640px);
  justify-content: center;
  gap: clamp(20px, 4vw, 56px);
  align-items: start;
}
.app-settings__layout > * {
  min-width: 0;
}
.app-settings__nav {
  position: sticky;
  top: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.app-settings__title {
  margin: 0;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-medium);
  color: var(--iu-text);
}
.app-settings__links {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.app-settings__link {
  position: relative;
  padding: 4px 0 4px 14px;
  border: none;
  background: none;
  font: inherit;
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-muted);
  text-align: left;
  cursor: pointer;
}
.app-settings__link:hover,
.app-settings__link[aria-current='true'] {
  color: var(--iu-text);
}
.app-settings__link[aria-current='true']::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  width: 4px;
  height: 4px;
  margin-top: -2px;
  border-radius: 50%;
  background: var(--iu-accent);
}
.app-settings__link:focus-visible,
.app-settings__chevron:focus-visible {
  outline: 2px solid var(--iu-accent);
  outline-offset: 2px;
  border-radius: var(--iu-radius-sm);
}
.app-settings__status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11);
  color: var(--iu-text-muted);
}
.app-settings__status-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--iu-positive);
}
.app-settings__status[data-kind='busy'] .app-settings__status-dot {
  background: var(--iu-warning);
}
.app-settings__status[data-kind='error'] {
  color: var(--iu-danger);
}
.app-settings__status[data-kind='error'] .app-settings__status-dot {
  background: var(--iu-danger);
}

.app-settings__main {
  display: flex;
  flex-direction: column;
  gap: 36px;
  min-width: 0;
}
.app-settings__section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  scroll-margin-top: 16px;
}
.app-settings__rows {
  border-top: 1px solid var(--iu-hairline);
}
.app-settings__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 230px);
  align-items: center;
  gap: 16px;
  min-height: 38px;
  border-bottom: 1px solid var(--iu-hairline);
}
/* a switch row is the library's own label-and-switch row */
.app-settings__row > .iu-switch-row {
  grid-column: 1 / -1;
}
.app-settings__row--nested {
  padding-left: 14px;
}
.app-settings__label {
  font-size: var(--iu-font-size-13);
  color: var(--iu-text);
}
.app-settings__hint {
  font-size: var(--iu-font-size-12);
  font-weight: var(--iu-font-weight-regular);
  color: var(--iu-text-muted);
}
.app-settings__note {
  margin: 0;
}
.app-settings__control {
  min-width: 0;
  padding: 4px 0;
}
.app-settings__control--end {
  display: flex;
  justify-content: flex-end;
}
.app-settings__value {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
  text-align: right;
}
.app-settings__value--mono {
  font-family: var(--iu-font-mono);
}
.app-settings__warn,
.app-settings__error {
  margin: 4px 0;
  font-size: var(--iu-font-size-12);
  line-height: var(--iu-leading-snug);
}
.app-settings__warn {
  color: var(--iu-warning);
}
.app-settings__error {
  color: var(--iu-danger);
}

.app-settings__tool {
  border-bottom: 1px solid var(--iu-hairline);
}
.app-settings__tool .app-settings__row:last-child {
  border-bottom: none;
}
.app-settings__tool-head {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 38px;
}
.app-settings__dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--iu-border-strong);
}
.app-settings__dot[data-found='yes'] {
  background: var(--iu-positive);
}
.app-settings__dot[data-found='no'] {
  background: var(--iu-danger);
}
.app-settings__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
}
.app-settings__tool-name {
  flex: none;
  min-width: 96px;
  font-size: var(--iu-font-size-13);
  color: var(--iu-text);
}
.app-settings__path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11-5);
  color: var(--iu-text-muted);
  white-space: nowrap;
  text-overflow: ellipsis;
  /* ellipsis at the start, so the end of a path stays readable */
  direction: rtl;
  text-align: left;
}
.app-settings__default {
  flex: none;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-10);
  letter-spacing: var(--iu-tracking-caps);
  text-transform: uppercase;
  color: var(--iu-accent);
}
.app-settings__chevron {
  display: inline-flex;
  flex: none;
  padding: 4px;
  border: none;
  background: none;
  color: var(--iu-text-muted);
  cursor: pointer;
}
.app-settings__chevron:hover {
  color: var(--iu-text);
}
.app-settings__chevron svg {
  transition: transform 0.12s ease;
}
.app-settings__chevron[aria-expanded='true'] svg {
  transform: rotate(90deg);
}

.app-settings__prices {
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--iu-hairline);
}
.app-settings__price-head,
.app-settings__price-row {
  display: grid;
  grid-template-columns: minmax(120px, 2fr) repeat(4, minmax(56px, 1fr)) 32px;
  align-items: center;
  gap: 4px;
  border-bottom: 1px solid var(--iu-hairline);
}
.app-settings__price-head {
  padding: 6px 0;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-10);
  letter-spacing: var(--iu-tracking-caps);
  text-transform: uppercase;
  color: var(--iu-text-muted);
}
.app-settings__price-head span:not(:first-child):not(:last-child) {
  padding-right: 8px;
  text-align: right;
}
.app-settings__price-error {
  grid-column: 1 / -1;
  margin: 0 0 6px;
}
.app-settings__add {
  display: flex;
  margin-left: -8px;
}

@media (max-width: 860px) {
  .app-settings__layout {
    grid-template-columns: minmax(0, 1fr);
    gap: 24px;
  }
  .app-settings__nav {
    position: static;
  }
  .app-settings__links {
    flex-direction: row;
    flex-wrap: wrap;
    gap: 4px 16px;
  }
  .app-settings__link {
    padding-left: 0;
  }
  .app-settings__link[aria-current='true']::before {
    display: none;
  }
  .app-settings__link[aria-current='true'] {
    text-decoration: underline;
    text-decoration-color: var(--iu-accent);
    text-underline-offset: 4px;
  }
  .app-settings__row {
    grid-template-columns: minmax(0, 1fr) minmax(0, 180px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .app-settings__chevron svg {
    transition: none;
  }
}
</style>
