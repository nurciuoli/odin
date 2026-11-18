import { computed, createApp, h, ref } from 'vue'
import './styles/base.css'
import { LOOP, nodesAt, summary } from './lab/agent-tree/tree'
import TreeLanes from './lab/agent-tree/TreeLanes.vue'
import TreeBuds from './lab/agent-tree/TreeBuds.vue'
import TreeLog from './lab/agent-tree/TreeLog.vue'
import TreeStrip from './lab/agent-tree/TreeStrip.vue'

// ?t=12 freezes the clock; otherwise the timeline plays and loops. window.setT(s) is for screenshots.
const frozen = new URLSearchParams(location.search).get('t')
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
const variants = [
  { key: 'lanes', title: '1. Lanes', blurb: 'The project git graph, for a run. The trunk is the session; subagents and processes fork onto lanes and lengthen as they work. Finished branches merge back into their parent. Dashed lanes and square heads are processes.', view: TreeLanes },
  { key: 'buds', title: '2. Buds', blurb: 'The Yggdrasil take: soft curves, labels ride the growing tip so there are no columns, and tips are plants: bud, hollow bud, leaf, snapped twig.', view: TreeBuds },
  { key: 'log', title: '3. Log', blurb: 'git log --graph: one row per agent or process, a lane gutter on the left that lengthens as later rows start, and a bar with the exact time on the right.', view: TreeLog },
  { key: 'strip', title: '4. Strip', blurb: 'The smallest form, for a header or the sidebar. Quiet by default; only branches that need you or failed get a label.', view: TreeStrip },
]
createApp({
  render: () => {
    const nodes = nodesAt(t.value)
    return h('main', { style: 'max-width:860px;margin:0 auto;padding:28px 16px 48px;font-family:var(--iu-font-sans);color:var(--iu-text)' }, [
      h('div', { style: 'display:flex;gap:12px;align-items:center;margin-bottom:12px;font-size:13px;color:var(--iu-text-2)' }, [
        h('button', { onClick: () => (playing.value = !playing.value), style: 'font:inherit;padding:6px 12px;border-radius:8px;border:1px solid var(--iu-border);background:var(--iu-surface);color:var(--iu-text);cursor:pointer' }, playing.value ? 'Pause' : 'Play'),
        h('input', { type: 'range', min: 0, max: LOOP, step: 0.1, value: t.value, style: 'flex:1', 'aria-label': 'Timeline', onInput: (e: Event) => { playing.value = false; t.value = Number((e.target as HTMLInputElement).value) } }),
        h('span', { style: 'font-family:var(--iu-font-mono);min-width:48px' }, `${t.value.toFixed(1)}s`),
      ]),
      h('p', { 'aria-live': 'polite', style: 'margin:0 0 20px;color:var(--iu-text-muted);font-size:13px' }, summary(nodes)),
      ...variants.map((v) =>
        h('section', { id: v.key, style: 'margin-bottom:24px;border:1px solid var(--iu-hairline);border-radius:14px;background:var(--iu-ground);padding:16px 20px 20px' }, [
          h('h2', { style: 'margin:0 0 4px;font-size:15px;font-weight:500' }, v.title),
          h('p', { style: 'margin:0 0 14px;color:var(--iu-text-muted);font-size:12px;max-width:680px' }, v.blurb),
          h(v.view as any, { t: t.value }),
        ]),
      ),
    ])
  },
}).mount('#app')
