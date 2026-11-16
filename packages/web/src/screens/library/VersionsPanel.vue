<script setup lang="ts">
// Every version an asset has had, and a line diff between any two of them.
import { computed, ref, watch } from 'vue'
import type { AssetDetail, AssetFiles } from '@odin/shared/api'
import { useApi } from '@/api'
import { IuBadge } from '@/components/Badge'
import { diffLines, IuDiff } from '@/components/CodeBlock'
import { IuCallout } from '@/components/Callout'
import { IuSkeleton } from '@/components/States'
import SelectField from '@/screens/shared/SelectField.vue'
import { plural, relativeTime, shortHash } from '@/screens/shared/format'

const props = defineProps<{ detail: AssetDetail }>()

const api = useApi()
const from = ref('')
const to = ref('')
const loading = ref(false)
const error = ref<string | null>(null)
const diffs = ref<{ file: string; hunks: ReturnType<typeof diffLines>; changed: boolean }[]>([])

const versions = computed(() => props.detail.versions)
const current = computed(() => props.detail.asset.version)
const options = computed(() =>
  versions.value.map(v => ({
    id: v.version,
    label: `${shortHash(v.version)} · ${relativeTime(v.firstSeenAt)}${v.version === current.value ? ' · current' : ''}`,
  })),
)

// Default: the version before the current one against the current one.
watch(
  () => [current.value, versions.value.length],
  () => {
    const list = versions.value
    to.value = current.value
    from.value = list.find(v => v.version !== current.value)?.version ?? current.value
  },
  { immediate: true },
)

let token = 0
async function compare() {
  const mine = ++token
  if (!from.value || !to.value) return
  loading.value = true
  error.value = null
  try {
    const [a, b]: AssetFiles[] = await Promise.all([
      api.getAssetVersion(props.detail.asset.kind, props.detail.asset.id, from.value),
      api.getAssetVersion(props.detail.asset.kind, props.detail.asset.id, to.value),
    ])
    if (mine !== token) return
    const names = [...new Set([...Object.keys(a!), ...Object.keys(b!)])].sort()
    diffs.value = names.map(file => {
      const hunks = diffLines(a![file] ?? '', b![file] ?? '')
      return {
        file,
        hunks,
        changed: (a![file] ?? '') !== (b![file] ?? ''),
      }
    })
  } catch (e) {
    if (mine !== token) return
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (mine === token) loading.value = false
  }
}
watch([from, to], () => void compare(), { immediate: true })
const same = computed(() => from.value === to.value || diffs.value.every(d => !d.changed))
</script>

<template>
  <div class="versions">
    <ol class="versions__list" aria-label="Versions">
      <li v-for="v in versions" :key="v.version" class="versions__row">
        <code class="versions__hash">{{ shortHash(v.version) }}</code>
        <IuBadge v-if="v.version === current" intent="accent" size="xs">Current</IuBadge>
        <span class="versions__meta">first seen {{ relativeTime(v.firstSeenAt) }}</span>
        <span
          v-if="detail.asset.kind === 'agent' || detail.asset.kind === 'template'"
          class="versions__meta"
        >
          {{ plural(v.sessionCount, 'session') }}
        </span>
      </li>
    </ol>

    <section class="versions__compare" aria-label="Compare versions">
      <div class="versions__pickers">
        <SelectField v-model="from" label="From" :options="options" />
        <SelectField v-model="to" label="To" :options="options" />
      </div>
      <IuSkeleton v-if="loading && !diffs.length" shape="text" :rows="6" />
      <IuCallout v-else-if="error" intent="danger" variant="inline" live
        >Couldn't load that comparison: {{ error }}</IuCallout
      >
      <p v-else-if="same" class="versions__same">These two versions are identical.</p>
      <template v-else>
        <template v-for="d in diffs" :key="d.file">
          <IuDiff v-if="d.changed" :hunks="d.hunks" :filename="d.file" />
        </template>
      </template>
    </section>
  </div>
</template>

<style>
.versions {
  display: flex;
  flex-direction: column;
  gap: 24px;
}
.versions__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.versions__row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid var(--iu-border-quiet);
  font-size: var(--iu-font-size-13);
}
.versions__hash {
  font-family: var(--iu-font-mono);
}
.versions__meta {
  color: var(--iu-text-muted);
}
.versions__compare {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.versions__pickers {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 320px));
  gap: 14px;
}
.versions__same {
  margin: 0;
  color: var(--iu-text-muted);
  font-size: var(--iu-font-size-13);
}
</style>
