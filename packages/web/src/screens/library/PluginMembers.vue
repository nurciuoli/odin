<script setup lang="ts">
// A plugin's members at a glance: the files it carries itself and the library assets it includes.
import { computed } from 'vue'
import type { AssetDetail, PluginInclude, PluginOwnMember, PluginSpec } from '@odin/shared/api'
import { IuBadge } from '@/components/Badge'
import { shortHash } from '@/screens/shared/format'
import { KIND_INFO } from './assetForm'

const props = defineProps<{ detail: AssetDetail }>()

const meta = computed(
  () => props.detail.asset.meta as Partial<PluginSpec> & { own?: PluginOwnMember[] },
)
const own = computed(() => meta.value.own ?? [])
const includes = computed<PluginInclude[]>(() => meta.value.includes ?? [])
</script>

<template>
  <section class="plugin-members" aria-label="Members">
    <div>
      <h3 class="plugin-members__h">In the plugin</h3>
      <p v-if="!own.length" class="plugin-members__none">No files of its own.</p>
      <ul v-else class="plugin-members__list">
        <li v-for="m in own" :key="`${m.kind}/${m.id}`">
          <span class="plugin-members__kind">{{ KIND_INFO[m.kind].label }}</span>
          <code>{{ m.id }}</code>
          <IuBadge v-if="m.error" intent="danger" size="xs">Has errors</IuBadge>
        </li>
      </ul>
    </div>
    <div>
      <h3 class="plugin-members__h">From the library</h3>
      <p v-if="!includes.length" class="plugin-members__none">Nothing included.</p>
      <ul v-else class="plugin-members__list">
        <li v-for="m in includes" :key="`${m.kind}/${m.id}`">
          <span class="plugin-members__kind">{{ KIND_INFO[m.kind].label }}</span>
          <RouterLink :to="{ name: 'library-asset', params: { kind: m.kind, id: m.id } }">{{
            m.id
          }}</RouterLink>
          <span class="plugin-members__pin">{{
            m.version ? `pinned ${shortHash(m.version)}` : 'follows the current version'
          }}</span>
        </li>
      </ul>
    </div>
    <p v-if="meta.source && meta.source.type === 'git'" class="plugin-members__source">
      Imported from <code>{{ meta.source.url }}</code
      ><template v-if="meta.source.rev">
        at <code>{{ meta.source.rev }}</code></template
      >
    </p>
  </section>
</template>

<style>
.plugin-members {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 16px 32px;
  font-size: var(--iu-font-size-13);
}
.plugin-members__h {
  margin: 0 0 6px;
  font-size: var(--iu-font-size-13);
  font-weight: var(--iu-font-weight-semibold);
}
.plugin-members__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.plugin-members__list li {
  display: flex;
  align-items: center;
  gap: 8px;
}
.plugin-members__kind {
  min-width: 96px;
  color: var(--iu-text-muted);
}
.plugin-members__none,
.plugin-members__pin,
.plugin-members__source {
  margin: 0;
  color: var(--iu-text-muted);
}
.plugin-members__source {
  grid-column: 1 / -1;
}
</style>
