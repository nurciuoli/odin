import { computed, createApp, h, ref } from 'vue'
import './styles/base.css'
import { agentsAt, LOOP, summary } from './lab/subagent-viz/mock'
import Ravens from './lab/subagent-viz/Ravens.vue'
import Yggdrasil from './lab/subagent-viz/Yggdrasil.vue'
import RuneLedger from './lab/subagent-viz/RuneLedger.vue'
import Longship from './lab/subagent-viz/Longship.vue'

// ?t=12 freezes the clock at second 12; ?only=ravens shows one variation; otherwise the timeline plays and loops.
const params = new URLSearchParams(location.search)
const frozen = params.get('t')
const only = params.get('only')
const t = ref(frozen ? Number(frozen) : 0)
const playing = ref(!frozen)
let last = 0
function tick(now: number) {
  if (playing.value && last) t.value = (t.value + (now - last) / 1000) % LOOP
  last = now
  requestAnimationFrame(tick)
}
requestAnimationFrame(tick)
;(window as any).setT = (v: number) => {
  playing.value = false
  t.value = v
}
const agents = computed(() => agentsAt(t.value))

const variants = [
  { key: 'ravens', title: 'A. Huginn and Muninn', blurb: 'Each subagent is a raven sent out from the high seat. It flies toward its task, waits on a wire when it needs you, and lands back with the result.', view: Ravens },
  { key: 'yggdrasil', title: 'B. Yggdrasil', blurb: 'The session is the world tree and every subagent grows a branch. A bud rides the tip, a leaf opens on return, and a failed branch snaps.', view: Yggdrasil },
  { key: 'runes', title: 'C. Rune stones', blurb: 'One rune per tool call. Carved runes glow steady, the one being cut shimmers, and a failed row cracks through.', view: RuneLedger },
  { key: 'ship', title: 'D. The longship', blurb: 'The session is the ship and each subagent an oar and shield. Oars pull while working, are tossed up when waiting, shipped when done, and snap on failure.', view: Longship },
]

createApp({
  render: () =>
    h('main', { style: 'max-width:820px;margin:0 auto;padding:28px 16px 48px;font-family:var(--iu-font-sans);color:var(--iu-text)' }, [
      h('div', { style: 'display:flex;gap:12px;align-items:center;margin-bottom:20px;font-size:13px;color:var(--iu-text-2)' }, [
        h('button', { onClick: () => (playing.value = !playing.value), style: 'font:inherit;padding:6px 12px;border-radius:8px;border:1px solid var(--iu-border);background:var(--iu-surface);color:var(--iu-text);cursor:pointer' }, playing.value ? 'Pause' : 'Play'),
        h('input', { type: 'range', min: 0, max: LOOP, step: 0.1, value: t.value, style: 'flex:1', 'aria-label': 'Timeline', onInput: (e: Event) => { playing.value = false; t.value = Number((e.target as HTMLInputElement).value) } }),
        h('span', { id: 'clock', style: 'font-family:var(--iu-font-mono);min-width:48px' }, `${t.value.toFixed(1)}s`),
      ]),
      h('p', { id: 'summary', 'aria-live': 'polite', style: 'margin:0 0 20px;color:var(--iu-text-muted);font-size:13px' }, summary(agents.value)),
      ...variants
        .filter((v) => !only || v.key === only)
        .map((v) =>
          h('section', { id: v.key, style: 'margin-bottom:28px;border:1px solid var(--iu-hairline);border-radius:14px;background:var(--iu-ground);padding:16px 20px 20px' }, [
            h('h2', { style: 'margin:0 0 4px;font-size:15px;font-weight:500' }, v.title),
            h('p', { style: 'margin:0 0 14px;color:var(--iu-text-muted);font-size:12px;max-width:640px' }, v.blurb),
            h(v.view as any, { agents: agents.value }),
          ]),
        ),
    ]),
}).mount('#app')
