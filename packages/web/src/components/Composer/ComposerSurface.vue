<script setup lang="ts">
withDefaults(defineProps<{ joined?: boolean }>(), { joined: false })
</script>
<template>
  <div class="iu-composer-surface" :class="{ 'iu-composer-surface--joined': joined }">
    <div v-if="joined" class="iu-composer-surface__activity"><slot name="activity" /></div>
    <slot />
  </div>
</template>
<style>
.iu-composer-surface {
  min-width: 0;
  width: 100%;
  box-sizing: border-box;
}
.iu-composer-surface--joined .iu-composer-surface__activity {
  border: 1px solid var(--iu-border);
  border-bottom-color: var(--iu-border-quiet);
  border-radius: var(--iu-radius-lg) var(--iu-radius-lg) 0 0;
  background: var(--iu-surface);
}
.iu-composer-surface--joined:focus-within .iu-composer-surface__activity {
  border-color: var(--iu-border-strong);
  border-bottom-color: var(--iu-border-quiet);
}
.iu-composer-surface__activity {
  min-width: 0;
}
.iu-composer-surface--joined .iu-composer--embedded .iu-composer__frame {
  border-top: 0;
  border-radius: 0 0 var(--iu-radius-lg) var(--iu-radius-lg);
}
.iu-composer-surface--joined:focus-within .iu-composer--embedded .iu-composer__frame {
  border-color: var(--iu-border-strong);
}
</style>
