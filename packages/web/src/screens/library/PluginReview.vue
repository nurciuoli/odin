<script setup lang="ts">
// What a plugin would add, to read before anything is written: its members, every hook, local command and remote
// server with the exact text, the secrets and sign-ins it needs, and any warnings. Used by install and import.
import type { PluginMemberKind, PluginRun } from '@odin/shared/api'
import { IuBadge } from '@/components/Badge'
import { IuCallout } from '@/components/Callout'
import { plural } from '@/screens/shared/format'
import { KIND_INFO } from './assetForm'

defineProps<{
  members: { kind: PluginMemberKind; id: string; origin?: 'own' | 'library' }[]
  runs: PluginRun[]
  secrets?: { name: string; set?: boolean }[]
  oauth?: string[]
  warnings?: string[]
  missing?: string[]
}>()

const RUN_LABEL: Record<PluginRun['kind'], string> = {
  hook: 'Hook',
  command: 'Runs a command',
  remote: 'Remote server',
}
</script>

<template>
  <div class="plugin-review">
    <IuCallout
      v-if="missing?.length"
      intent="danger"
      variant="inline"
      title="Missing from the library"
    >
      {{ missing.join(', ') }}. Install is refused until these exist.
    </IuCallout>

    <section>
      <h3 class="plugin-review__h">{{ plural(members.length, 'member') }}</h3>
      <ul class="plugin-review__list">
        <li v-for="m in members" :key="`${m.kind}/${m.id}`">
          <span class="plugin-review__kind">{{ KIND_INFO[m.kind].label }}</span>
          <code>{{ m.id }}</code>
          <IuBadge v-if="m.origin" size="xs" :intent="m.origin === 'own' ? 'neutral' : 'info'">{{
            m.origin === 'own' ? 'In the plugin' : 'From the library'
          }}</IuBadge>
        </li>
      </ul>
    </section>

    <section v-if="runs.length">
      <h3 class="plugin-review__h">What it adds that can run</h3>
      <ul class="plugin-review__runs">
        <li v-for="(r, i) in runs" :key="i">
          <div>
            <IuBadge size="xs" :intent="r.kind === 'remote' ? 'neutral' : 'warning'">{{
              RUN_LABEL[r.kind]
            }}</IuBadge>
            <code class="plugin-review__member">{{ r.member }}</code>
          </div>
          <pre class="plugin-review__text">{{ r.text }}</pre>
        </li>
      </ul>
      <p class="plugin-review__note">
        Nothing runs when a plugin is installed. Hooks and commands run when a session uses them.
      </p>
    </section>

    <section v-if="secrets?.length || oauth?.length">
      <h3 class="plugin-review__h">Needs setup</h3>
      <ul class="plugin-review__list">
        <li v-for="s in secrets" :key="s.name">
          <code>{{ s.name }}</code>
          <IuBadge v-if="s.set !== undefined" size="xs" :intent="s.set ? 'positive' : 'warning'">{{
            s.set ? 'Secret is set' : 'Secret not set'
          }}</IuBadge>
          <span v-else class="plugin-review__muted">a secret it refers to</span>
        </li>
        <li v-for="o in oauth" :key="o">
          <code>{{ o }}</code>
          <IuBadge size="xs" intent="warning">Needs sign-in</IuBadge>
        </li>
      </ul>
      <p class="plugin-review__note">Set secrets and sign in from the MCP servers screen.</p>
    </section>

    <IuCallout v-if="warnings?.length" intent="warning" variant="inline" title="Heads up">
      <ul class="plugin-review__warnings">
        <li v-for="w in warnings" :key="w">{{ w }}</li>
      </ul>
    </IuCallout>
  </div>
</template>

<style>
.plugin-review {
  display: flex;
  flex-direction: column;
  gap: 16px;
  font-size: var(--iu-font-size-13);
}
.plugin-review__h {
  margin: 0 0 6px;
  font-size: var(--iu-font-size-13);
  font-weight: var(--iu-font-weight-semibold);
}
.plugin-review__list,
.plugin-review__runs,
.plugin-review__warnings {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.plugin-review__list li {
  display: flex;
  align-items: center;
  gap: 8px;
}
.plugin-review__kind {
  min-width: 96px;
  color: var(--iu-text-muted);
}
.plugin-review__member {
  margin-left: 8px;
}
.plugin-review__text {
  margin: 4px 0 0;
  padding: 8px 10px;
  max-height: 120px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  background: var(--iu-surface-sunken, var(--iu-bg-subtle));
  border-radius: 6px;
}
.plugin-review__note,
.plugin-review__muted {
  margin: 6px 0 0;
  color: var(--iu-text-muted);
}
.plugin-review__muted {
  margin: 0;
}
</style>
