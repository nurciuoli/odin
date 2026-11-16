<script setup lang="ts">
// A file path on one line: relative to `root` when given, forward slashes, the full path as a tooltip. When it
// doesn't fit, the directory part gives way (ellipsis in the middle of the path) so the file name stays visible.
import { computed } from 'vue'
import { relativePath, splitPath } from './relativePath'

defineOptions({ name: 'IuFilePath' })

const props = withDefaults(
  defineProps<{
    path: string
    /** Show the path relative to this directory (a session's cwd or worktree). */
    root?: string | null
    /** Mute the directory part so the file name reads first. */
    muteDir?: boolean
  }>(),
  { root: null, muteDir: true },
)

const shown = computed(() => relativePath(props.path, props.root))
const parts = computed(() => splitPath(shown.value))
</script>

<template>
  <span class="iu-file-path" :class="{ 'iu-file-path--mute-dir': muteDir }" :title="path">
    <span v-if="parts.dir" class="iu-file-path__dir">{{ parts.dir }}</span>
    <span class="iu-file-path__base">{{ parts.base }}</span>
  </span>
</template>

<style>
.iu-file-path {
  display: inline-flex;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  white-space: nowrap;
  vertical-align: bottom;
}

/* the directory shrinks first; the file name only once the directory is gone */
.iu-file-path__dir {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.iu-file-path__base {
  flex: 0 0 auto;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}

.iu-file-path--mute-dir .iu-file-path__dir {
  color: var(--iu-text-muted);
}
</style>
