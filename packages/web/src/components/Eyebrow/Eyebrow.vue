<script setup lang="ts">
withDefaults(
  defineProps<{
    as?: string
    size?: 'sm' | 'md'
  }>(),
  { as: 'div', size: 'sm' },
)
</script>

<template>
  <component
    :is="as"
    class="iu-eyebrow"
    :class="[`iu-eyebrow--${size}`, { 'iu-eyebrow--split': $slots.trailing }]"
  >
    <template v-if="$slots.trailing">
      <span class="iu-eyebrow__text"><slot /></span>
      <span class="iu-eyebrow__trailing"><slot name="trailing" /></span>
    </template>
    <slot v-else />
  </component>
</template>

<style>
.iu-eyebrow {
  margin: 0;
  font-family: var(--iu-font-mono);
  text-transform: uppercase;
  line-height: var(--iu-leading-snug);
  color: var(--iu-text-muted);
}

.iu-eyebrow--sm {
  font-size: var(--iu-font-size-10);
  letter-spacing: var(--iu-tracking-caps);
}

.iu-eyebrow--md {
  font-size: var(--iu-font-size-11);
  letter-spacing: var(--iu-tracking-caps);
}

/* trailing content sits on the same baseline grid; buttons and counts must not inherit the caps */
.iu-eyebrow--split {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
}

.iu-eyebrow__text {
  min-width: 0;
}

.iu-eyebrow__trailing {
  flex: none;
  text-transform: none;
  letter-spacing: normal;
}
</style>
