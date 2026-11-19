<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { IuButton } from '@/components/Button'
import { IuField, IuCheckbox } from '@/components/Fields'
import ComposerChoice from '@/screens/shared/ComposerChoice.vue'
import { visibleField, validateNativeForm, type NativeForm, type NativeValue } from './nativeForm'
const props = withDefaults(defineProps<{ form: NativeForm; busy?: boolean }>(), { busy: false })
const emit = defineEmits<{ answer: [answer: Record<string, NativeValue>]; cancel: [] }>()
const values = reactive<Record<string, NativeValue | undefined>>({})
watch(
  () => props.form,
  form => {
    for (const key of Object.keys(values)) delete values[key]
    Object.assign(
      values,
      Object.fromEntries(
        form.fields.map(f => [
          f.key,
          f.default ?? (f.type === 'boolean' ? false : f.type === 'multiselect' ? [] : ''),
        ]),
      ),
    )
  },
  { immediate: true },
)
const errors = ref<Record<string, string>>({})
const custom = reactive<Record<string, string>>({})
const visible = computed(() => props.form.fields.filter(f => visibleField(f, values)))
function submit() {
  const result = validateNativeForm(props.form, values)
  errors.value = result.errors
  if (!Object.keys(result.errors).length) emit('answer', result.answer)
}
function toggle(key: string, value: string, checked: boolean) {
  const current = Array.isArray(values[key]) ? (values[key] as string[]) : []
  values[key] = checked ? [...new Set([...current, value])] : current.filter(v => v !== value)
}
function addCustom(key: string) {
  const value = custom[key]?.trim()
  if (value) toggle(key, value, true)
  custom[key] = ''
}
function external(url: string | undefined) {
  try {
    const parsed = new URL(url ?? '')
    return ['https:', 'http:'].includes(parsed.protocol) ? parsed.href : undefined
  } catch {
    return undefined
  }
}
</script>
<template>
  <form class="native-form" @submit.prevent="submit">
    <p>{{ form.title }}</p>
    <fieldset v-for="field in visible" :key="field.key" :disabled="busy" class="native-form__field">
      <legend>{{ field.title ?? field.key }}{{ field.required ? ' (required)' : '' }}</legend>
      <p v-if="field.description">{{ field.description }}</p>
      <template v-if="field.type === 'external'">
        <a
          v-if="external(field.url)"
          :href="external(field.url)"
          target="_blank"
          rel="noopener noreferrer"
          >Open {{ field.title ?? 'external form' }}</a
        >
        <p v-else role="alert">This external form does not have a supported URL.</p>
      </template>
      <IuCheckbox
        v-else-if="field.type === 'boolean'"
        :model-value="values[field.key] === true"
        :label="field.title ?? field.key"
        :disabled="busy"
        @update:model-value="values[field.key] = $event"
      />
      <template v-else-if="field.type === 'multiselect'">
        <IuCheckbox
          v-for="option in field.options"
          :key="option.value"
          :label="option.label"
          :model-value="
            Array.isArray(values[field.key]) &&
            (values[field.key] as string[]).includes(option.value)
          "
          :disabled="busy"
          @update:model-value="toggle(field.key, option.value, $event)"
        />
        <template v-if="field.custom">
          <IuField
            v-model="custom[field.key]"
            :label="`Additional ${field.title ?? field.key} choice`"
            :disabled="busy"
          />
          <IuButton
            type="button"
            variant="secondary"
            :disabled="busy || !custom[field.key]?.trim()"
            @click="addCustom(field.key)"
            >Add choice</IuButton
          >
          <p>Selected: {{ (values[field.key] as string[]).join(', ') }}</p>
        </template>
      </template>
      <template v-else-if="field.type === 'string' && field.options?.length">
        <ComposerChoice
          :model-value="String(values[field.key] ?? '')"
          :label="field.title ?? field.key"
          :options="[
            { id: '', label: 'Choose an option' },
            ...field.options.map(o => ({ id: o.value, label: o.label })),
          ]"
          :disabled="busy"
          @update:model-value="values[field.key] = $event"
        />
        <IuField
          v-if="field.custom"
          :model-value="String(values[field.key] ?? '')"
          :label="`Custom ${field.title ?? field.key}`"
          :disabled="busy"
          @update:model-value="values[field.key] = String($event)"
        />
      </template>
      <IuField
        v-else
        :model-value="String(values[field.key] ?? '')"
        :label="field.title ?? field.key"
        :type="field.type === 'number' || field.type === 'integer' ? 'number' : 'text'"
        :placeholder="field.placeholder"
        :error="errors[field.key]"
        :disabled="busy"
        @update:model-value="values[field.key] = $event"
      />
      <p v-if="errors[field.key]" role="alert">{{ errors[field.key] }}</p>
    </fieldset>
    <IuButton type="submit" :disabled="busy">Submit answers</IuButton>
    <IuButton type="button" variant="secondary" :disabled="busy" @click="emit('cancel')"
      >Dismiss form</IuButton
    >
  </form>
</template>
<style scoped>
.native-form {
  display: grid;
  gap: var(--iu-space-2);
}
.native-form__field {
  border: 0;
  padding: 0;
  margin: 0;
  display: grid;
  gap: var(--iu-space-2);
}
.native-form a:focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: var(--iu-focus-offset);
}
</style>
