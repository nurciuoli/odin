<script setup lang="ts">
// The worktree overview shown on hover over the folder-tree glyph in the Details header.
import { IuIcon } from '@/components/Icon'
import './hovercards.css'

defineProps<{ project: string; path: string; branch: string }>()
</script>

<template>
  <div class="hc">
    <header class="hc__head">
      <IuIcon name="folderTree" :size="14" class="hc__tone--worktree" />
      <span class="hc__title">Worktree</span>
    </header>
    <p class="hc__state">A separate checkout of {{ project }} on its own branch.</p>
    <dl class="hc__props">
      <div>
        <dt><IuIcon name="folder" :size="14" /><span class="hc__sr">Path</span></dt>
        <dd class="hc__mono" :title="path">{{ path }}</dd>
      </div>
      <div>
        <dt><IuIcon name="gitBranch" :size="14" /><span class="hc__sr">Branch</span></dt>
        <dd class="hc__mono">{{ branch }}</dd>
      </div>
    </dl>
  </div>
</template>
