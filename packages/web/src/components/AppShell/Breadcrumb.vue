<script setup lang="ts">
// IuBreadcrumb.vue — location, not navigation. Truncates from the middle:
// first and last crumb always survive, the rest collapse behind a menu.
// The trailing crumb is always plain text, never a link, and takes mono
// when it names an identifier.
import { computed } from 'vue'
import { useRouter, type RouteLocationRaw } from 'vue-router'
import { IuIcon } from '@/components/Icon'
import { IuMenu, type MenuItem } from '@/components/Menu'

// resolved lazily so the component still works if no router is installed —
// useRouter() returns undefined rather than throwing in that case
const router = useRouter()

export interface Crumb {
  label: string
  to?: RouteLocationRaw
  mono?: boolean
}

const props = withDefaults(
  defineProps<{
    items: Crumb[]
    maxVisible?: number
  }>(),
  { maxVisible: 4 },
)

const isCollapsed = computed(() => props.items.length > Math.max(props.maxVisible, 2))

// how many crumbs (including the last) stay visible after the ellipsis —
// the first crumb always gets its own slot outside this budget
const tailCount = computed(() => Math.max(props.maxVisible - 1, 1))

const hiddenCrumbs = computed<Crumb[]>(() =>
  isCollapsed.value ? props.items.slice(1, props.items.length - tailCount.value) : [],
)

// the crumbs actually rendered as breadcrumb entries — an ellipsis marker
// is spliced in where the collapsed run belongs
const ELLIPSIS = '__iu-breadcrumb-ellipsis__'
const visible = computed<(Crumb | typeof ELLIPSIS)[]>(() => {
  if (!isCollapsed.value) return props.items
  return [props.items[0], ELLIPSIS, ...props.items.slice(props.items.length - tailCount.value)]
})

const overflowMenuItems = computed<MenuItem[]>(() =>
  hiddenCrumbs.value.map((crumb, i) => ({
    type: 'item',
    id: String(i),
    label: crumb.label,
    disabled: !crumb.to,
  })),
)

function isEllipsis(entry: Crumb | typeof ELLIPSIS): entry is typeof ELLIPSIS {
  return entry === ELLIPSIS
}

function onOverflowSelect(id: string) {
  const crumb = hiddenCrumbs.value[Number(id)]
  if (crumb?.to) router?.push(crumb.to)
}
</script>

<template>
  <nav class="iu-breadcrumb" aria-label="Breadcrumb">
    <ol class="iu-breadcrumb__list">
      <template v-for="(entry, i) in visible" :key="i">
        <li class="iu-breadcrumb__item">
          <IuMenu
            v-if="isEllipsis(entry)"
            :items="overflowMenuItems"
            placement="bottom-start"
            @select="onOverflowSelect"
          >
            <template #trigger="{ toggle }">
              <button
                type="button"
                class="iu-breadcrumb__ellipsis"
                aria-label="Show hidden breadcrumbs"
                @click="toggle"
              >
                …
              </button>
            </template>
          </IuMenu>
          <span
            v-else-if="i === visible.length - 1"
            class="iu-breadcrumb__current"
            :class="{ 'is-mono': entry.mono }"
            >{{ entry.label }}</span
          >
          <RouterLink
            v-else-if="entry.to"
            :to="entry.to"
            class="iu-breadcrumb__link"
            :class="{ 'is-mono': entry.mono }"
            >{{ entry.label }}</RouterLink
          >
          <span v-else class="iu-breadcrumb__link is-static" :class="{ 'is-mono': entry.mono }">{{
            entry.label
          }}</span>
        </li>
        <li v-if="i < visible.length - 1" class="iu-breadcrumb__sep" aria-hidden="true">
          <IuIcon name="chevronRight" :size="14" />
        </li>
      </template>
    </ol>
  </nav>
</template>

<style>
.iu-breadcrumb__list {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: var(--iu-font-size-13);
  min-width: 0;
}
.iu-breadcrumb__item {
  display: flex;
  align-items: center;
  min-width: 0;
}
.iu-breadcrumb__sep {
  display: flex;
  align-items: center;
  flex: none;
  color: var(--iu-text-disabled);
}

.iu-breadcrumb__link {
  color: var(--iu-text-muted);
  text-decoration: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.iu-breadcrumb__link:hover {
  color: var(--iu-text);
}
.iu-breadcrumb__link.is-static {
  cursor: default;
}
.iu-breadcrumb__link.is-static:hover {
  color: var(--iu-text-muted);
}

.iu-breadcrumb__current {
  color: var(--iu-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.iu-breadcrumb__link.is-mono,
.iu-breadcrumb__current.is-mono {
  font-family: var(--iu-font-mono);
}

.iu-breadcrumb__ellipsis {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--iu-raised);
  border: 1px solid var(--iu-border);
  border-radius: var(--iu-radius-sm);
  color: var(--iu-text-muted);
  cursor: pointer;
  padding: 1px 6px;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  line-height: var(--iu-leading-relaxed);
}
.iu-breadcrumb__ellipsis:hover {
  color: var(--iu-text);
  border-color: var(--iu-border-strong);
}
</style>
