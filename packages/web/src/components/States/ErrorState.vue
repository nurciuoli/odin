<script setup lang="ts">
// IuErrorState.vue — no embedded SFC source in the bundle; built from the
// API table ("Error & denial" section) + the mockup's inline + full-page
// treatments. A denial is a warning, not an error: the user did nothing
// wrong, they just lack a role — so it gets the warning/lock treatment
// instead of the danger/alert one.
import { computed, getCurrentInstance, ref } from 'vue'
import { IuIcon } from '@/components/Icon'
import { IuButton } from '@/components/Button'

const props = withDefaults(
  defineProps<{
    /** technical failure (danger, alert glyph) vs permission denial (warning, lock glyph) */
    kind?: 'failure' | 'denial'
    /** inline banner (sits inside a view that partially still works) vs full view-crash treatment */
    variant?: 'inline' | 'page'
    title: string
    body: string
    /** machine-readable id — required: every error/denial carries one, in mono */
    traceId: string
    timestamp?: string
    /** overrides the primary button's label (defaults: Retry / Request access / Reload view) */
    retryLabel?: string
  }>(),
  { kind: 'failure', variant: 'inline' },
)

const emit = defineEmits<{ retry: [] }>()

// the primary action only renders when a parent actually listens for @retry —
// declaring it via defineEmits() strips `onRetry` out of $attrs, but the raw
// vnode props (unaffected by the emits declaration) still carry it, so that's
// what tells us whether a listener is attached.
const instance = getCurrentInstance()
const hasRetry = computed(
  () =>
    typeof (instance?.vnode.props as Record<string, unknown> | null | undefined)?.onRetry ===
    'function',
)

const icon = computed(() => (props.kind === 'denial' ? 'lock' : 'alert'))

const retryLabelResolved = computed(
  () =>
    props.retryLabel ??
    (props.kind === 'denial'
      ? 'Request access'
      : props.variant === 'page'
        ? 'Reload view'
        : 'Retry'),
)

const pageEyebrow = computed(() =>
  props.kind === 'denial' ? 'access denied' : '500 · page failed',
)

const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | undefined
async function copyTraceId() {
  try {
    await navigator.clipboard.writeText(props.traceId)
    copied.value = true
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => {
      copied.value = false
    }, 1500)
  } catch {
    // clipboard API unavailable (insecure context, permission denied) — nothing to fall back to
  }
}
</script>

<template>
  <div
    class="iu-error-state"
    :class="[`iu-error-state--${kind}`, `iu-error-state--${variant}`]"
    role="alert"
  >
    <template v-if="variant === 'inline'">
      <IuIcon :name="icon" :size="16" class="iu-error-state__icon" />
      <div class="iu-error-state__content">
        <div class="iu-error-state__title">{{ title }}</div>
        <div class="iu-error-state__text">{{ body }}</div>
        <div class="iu-error-state__meta">
          {{ traceId }}<template v-if="timestamp"> · {{ timestamp }}</template>
        </div>
      </div>
      <div v-if="hasRetry" class="iu-error-state__actions">
        <IuButton size="sm" @click="emit('retry')">{{ retryLabelResolved }}</IuButton>
      </div>
    </template>

    <template v-else>
      <div class="iu-error-state__eyebrow">{{ pageEyebrow }}</div>
      <div class="iu-error-state__title iu-error-state__title--page">{{ title }}</div>
      <div class="iu-error-state__text iu-error-state__text--page">{{ body }}</div>
      <div class="iu-error-state__actions iu-error-state__actions--page">
        <IuButton v-if="hasRetry" variant="primary" @click="emit('retry')">{{
          retryLabelResolved
        }}</IuButton>
        <IuButton variant="secondary" @click="copyTraceId">
          <template #icon><IuIcon name="copy" :size="14" /></template>
          {{ copied ? 'Copied' : 'Copy trace id' }}
        </IuButton>
      </div>
      <div class="iu-error-state__meta">
        {{ traceId }}<template v-if="timestamp"> · {{ timestamp }}</template>
      </div>
    </template>
  </div>
</template>

<style>
.iu-error-state--inline {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  border: 1px solid var(--iu-hairline);
  border-left: 3px solid var(--iu-danger);
  border-radius: var(--iu-radius-lg);
  background: var(--iu-surface);
  padding: 15px 17px;
}
.iu-error-state--denial.iu-error-state--inline {
  border-left-color: var(--iu-warning);
}

.iu-error-state__icon {
  flex: none;
  margin-top: 1px;
  color: var(--iu-danger);
}
.iu-error-state--denial .iu-error-state__icon {
  color: var(--iu-warning);
}

.iu-error-state__content {
  display: flex;
  flex-direction: column;
  gap: 5px;
  flex: 1;
  min-width: 0;
}

.iu-error-state__title {
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-medium);
  color: var(--iu-text);
}
.iu-error-state__text {
  font-size: var(--iu-font-size-13-5);
  color: var(--iu-text-2);
  line-height: var(--iu-leading-relaxed);
}
.iu-error-state__meta {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-disabled);
  margin-top: 2px;
}

.iu-error-state__actions {
  flex: none;
}

/* full-page crash treatment */
.iu-error-state--page {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 12px;
  border: 1px solid var(--iu-border);
  border-radius: var(--iu-radius-lg);
  background: var(--iu-surface);
  padding: 36px 22px;
}
.iu-error-state__eyebrow {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  letter-spacing: var(--iu-tracking-caps);
  text-transform: uppercase;
  color: var(--iu-danger);
}
.iu-error-state--denial .iu-error-state__eyebrow {
  color: var(--iu-warning);
}
.iu-error-state__title--page {
  font-size: 17px;
  font-weight: var(--iu-font-weight-semibold);
}
.iu-error-state__text--page {
  font-size: var(--iu-font-size-13-5);
  max-width: 44ch;
}
.iu-error-state__actions--page {
  display: flex;
  gap: 8px;
  margin-top: 4px;
  flex-wrap: wrap;
  justify-content: center;
}
</style>
