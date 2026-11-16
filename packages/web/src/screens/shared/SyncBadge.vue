<script setup lang="ts">
import { computed } from 'vue'
import type { SyncStatus } from '@odin/shared/api'
import { IuBadge } from '@/components/Badge'
import { statusIntent } from '@/styles/status'
import { relativeTime, SYNC_DISPLAY } from './format'

const props = defineProps<{ sync: SyncStatus }>()

const display = computed(() => SYNC_DISPLAY[props.sync.state])
// the state is in the words; the tooltip adds when it last ran, or why it failed
const title = computed(() => {
  if (props.sync.state === 'error' && props.sync.error) return props.sync.error
  return props.sync.lastSyncAt ? `Last synced ${relativeTime(props.sync.lastSyncAt)}` : undefined
})
</script>

<template>
  <IuBadge :intent="statusIntent[display.status]" dot :title="title">{{ display.label }}</IuBadge>
</template>
