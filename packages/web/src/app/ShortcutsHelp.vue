<script setup lang="ts">
// The `?` cheat sheet: every registered shortcut, grouped, read straight from the registry.
import { computed } from 'vue'
import { IuButton } from '@/components/Button'
import { IuDialog } from '@/components/Modal'
import { keyCaps, keyLabel, useShortcuts } from './shortcuts'

const open = defineModel<boolean>('open', { required: true })
const shortcuts = useShortcuts()

const GROUP_ORDER = ['General', 'Sessions', 'Session']
const groups = computed(() => {
  const by = new Map<string, { id: string; label: string; keys: string }[]>()
  for (const s of shortcuts.value) {
    const list = by.get(s.group) ?? []
    list.push({ id: s.id, label: s.label, keys: s.keys })
    by.set(s.group, list)
  }
  const rank = (g: string) =>
    GROUP_ORDER.includes(g) ? GROUP_ORDER.indexOf(g) : GROUP_ORDER.length
  return [...by.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .map(([name, rows]) => ({ name, rows }))
})
</script>

<template>
  <IuDialog v-model:open="open" size="md">
    <template #header>
      <h2 class="shortcuts-help__title">Keyboard shortcuts</h2>
    </template>
    <div class="shortcuts-help">
      <section v-for="g in groups" :key="g.name" class="shortcuts-help__group">
        <h3 class="shortcuts-help__group-title">{{ g.name }}</h3>
        <dl class="shortcuts-help__list">
          <div v-for="row in g.rows" :key="row.id" class="shortcuts-help__row">
            <dt class="shortcuts-help__label">{{ row.label }}</dt>
            <dd class="shortcuts-help__keys">
              <span class="sr-only">{{ keyLabel(row.keys) }}</span>
              <kbd
                v-for="(cap, i) in keyCaps(row.keys)"
                :key="i"
                class="shortcuts-help__kbd"
                aria-hidden="true"
                >{{ cap }}</kbd
              >
            </dd>
          </div>
        </dl>
      </section>
      <p class="shortcuts-help__note">
        Shortcuts wait while you type, except the ones that switch or start sessions.
      </p>
    </div>
    <template #footer>
      <IuButton variant="secondary" size="sm" @click="open = false">Close</IuButton>
    </template>
  </IuDialog>
</template>

<style>
.shortcuts-help {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-height: 60vh;
  overflow-y: auto;
}
.shortcuts-help__title {
  margin: 0;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-semibold);
}
.shortcuts-help__group-title {
  margin: 0 0 6px;
  font-size: var(--iu-font-size-12);
  font-weight: var(--iu-font-weight-semibold);
  color: var(--iu-text-muted);
}
.shortcuts-help__list {
  margin: 0;
  display: flex;
  flex-direction: column;
}
.shortcuts-help__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 0;
  border-bottom: 1px solid var(--iu-hairline);
}
.shortcuts-help__label {
  font-size: var(--iu-font-size-13);
  color: var(--iu-text);
}
.shortcuts-help__keys {
  margin: 0;
  flex: none;
  display: flex;
  gap: 4px;
}
.shortcuts-help__kbd {
  min-width: 20px;
  padding: 1px 6px;
  text-align: center;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11);
  color: var(--iu-text-2);
  background: var(--iu-surface-sunken);
  border: 1px solid var(--iu-border);
  border-radius: var(--iu-radius-sm);
}
.shortcuts-help__note {
  margin: 0;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
</style>
