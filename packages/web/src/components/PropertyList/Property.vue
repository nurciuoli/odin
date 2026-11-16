<script setup lang="ts">
defineProps<{
  label: string
  value?: string
  mono?: boolean
}>()
</script>

<template>
  <div class="iu-prop">
    <dt class="iu-prop__label">
      <slot name="label">{{ label }}</slot>
    </dt>
    <dd class="iu-prop__value" :class="{ 'iu-prop__value--mono': mono }">
      <slot>{{ value }}</slot>
    </dd>
  </div>
</template>

<style>
.iu-prop {
  display: flex;
  gap: 10px;
  align-items: center;
  min-width: 0;
}
.iu-props--stacked .iu-prop {
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
}

.iu-prop__label,
.iu-prop__value {
  margin: 0;
  font-size: var(--iu-font-size-12-5);
  line-height: 18px;
}
.iu-prop__label {
  width: var(--iu-props-label-w, 80px);
  flex: none;
  min-width: 0;
  color: var(--iu-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.iu-props--stacked .iu-prop__label {
  width: auto;
  max-width: 100%;
}

.iu-prop__value {
  min-width: 0;
  color: var(--iu-text);
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  overflow-wrap: anywhere;
}
.iu-prop__value--mono {
  font-family: var(--iu-font-mono);
}
.iu-props--stacked .iu-prop__value {
  max-width: 100%;
}
</style>
