<script setup lang="ts">
// Lab only (not for merge): a session on mock data with four ways to open a timeline over it.
//   /timeline-lab.html?v=rail|ladder|branch|film     ⌥T toggles, ↑↓ (←→ in film) moves, ↵ jumps, Esc closes and returns,
//   c copies the step's prompt, r copies the reply.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import SessionThread from '@/screens/session/SessionThread.vue'
import { buildRows } from '@/screens/session/sessionView'
import { IuIcon } from '@/components/Icon'
import { transcript, turns, base, clock, strip, type Turn } from './timelineData'

const params = new URLSearchParams(location.search)
const variant = ref(params.get('v') ?? 'rail')
const rows = buildRows(transcript, { pending: [], streaming: [], running: false, artifacts: [] })
const all = turns()

const open = ref(params.has('open'))
const sel = ref(Number(params.get('sel') ?? all.length - 1))
const query = ref(params.get('q') ?? '')
const copied = ref('')
const frame = ref<HTMLElement | null>(null)
let saved = 0

const scroller = () => frame.value?.querySelector<HTMLElement>('.iu-msglist__scroller') ?? null
const userEls = () => [...(frame.value?.querySelectorAll<HTMLElement>('article[data-role="user"]') ?? [])]
function peek(i: number) {
  const el = userEls()[i]
  const sc = scroller()
  if (!el || !sc) return
  sc.scrollTop = el.offsetTop - sc.offsetTop - 24
  userEls().forEach((e, k) => e.classList.toggle('lab-peek', k === i))
}
const visible = computed<Turn[]>(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return all
  return all.filter(t => `${t.prompt} ${t.reply} ${t.files.join(' ')}`.toLowerCase().includes(q))
})
const cur = computed(() => all[sel.value] ?? all[all.length - 1]!)

function show() {
  const sc = scroller()
  saved = sc?.scrollTop ?? 0
  open.value = true
  nextTick(() => peek(sel.value))
}
function close(keep: boolean) {
  open.value = false
  userEls().forEach(e => e.classList.remove('lab-peek'))
  const sc = scroller()
  if (!keep && sc) sc.scrollTop = saved
  else if (keep) {
    const el = userEls()[sel.value]
    if (el) el.classList.add('lab-peek')
    setTimeout(() => el?.classList.remove('lab-peek'), 1200)
  }
}
function move(d: number) {
  const vis = visible.value
  if (!vis.length) return
  const at = Math.max(0, vis.findIndex(t => t.n - 1 === sel.value))
  const next = vis[Math.min(vis.length - 1, Math.max(0, at + d))]!
  sel.value = next.n - 1
}
async function copy(what: 'prompt' | 'reply', t = cur.value) {
  const text = what === 'prompt' ? t.prompt : strip(t.reply)
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    /* clipboard can be blocked in a lab */
  }
  copied.value = `Copied ${what} of step ${t.n}`
  setTimeout(() => (copied.value = ''), 1600)
}
watch(sel, i => open.value && peek(i))
watch(query, () => {
  if (visible.value.length && !visible.value.some(t => t.n - 1 === sel.value)) sel.value = visible.value[0]!.n - 1
})

function onKey(e: KeyboardEvent) {
  if (e.altKey && (e.code === 'KeyT' || e.key === 't' || e.key === '†')) {
    e.preventDefault()
    open.value ? close(false) : show()
    return
  }
  if (!open.value) return
  const typing = (e.target as HTMLElement)?.tagName === 'INPUT'
  const horiz = variant.value === 'film'
  if (e.key === 'Escape') { e.preventDefault(); close(false) }
  else if (e.key === 'Enter') { e.preventDefault(); close(true) }
  else if ((horiz ? e.key === 'ArrowRight' : e.key === 'ArrowDown') || (!horiz && !typing && e.key === 'j')) { e.preventDefault(); move(1) }
  else if ((horiz ? e.key === 'ArrowLeft' : e.key === 'ArrowUp') || (!horiz && !typing && e.key === 'k')) { e.preventDefault(); move(-1) }
  else if (e.key === 'Home') { sel.value = 0 }
  else if (e.key === 'End') { sel.value = all.length - 1 }
  else if (!typing && e.key === 'c') { void copy('prompt') }
  else if (!typing && e.key === 'r') { void copy('reply') }
  else if (typing && (e.metaKey || e.ctrlKey) && e.key === 'c' && !getSelection()?.toString()) { e.preventDefault(); void copy('prompt') }
}
onMounted(() => {
  window.addEventListener('keydown', onKey)
  ;(window as unknown as { lab: unknown }).lab = { show, close, sel, query }
  if (open.value) nextTick(() => setTimeout(show, 50))
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

// time-proportional scrubber (film) and strip positions
const span = (all[all.length - 1]!.min + 6) || 1
const pct = (m: number) => `${(m / span) * 100}%`
const mark = (t: Turn) => (t.tags.includes('fail') ? 'fail' : t.tags.includes('agent') ? 'agent' : t.tags.includes('contract') ? 'contract' : 'ok')
const dur = (i: number) => {
  const next = all[i + 1]
  const m = Math.round((next ? next.min : all[i]!.min + 6) - all[i]!.min)
  return `${m}m`
}
const title = 'Retry policy for the GitHub sync client'
</script>

<template>
  <div class="lab" :data-v="variant">
    <nav class="lab-switch" aria-label="Variants">
      <a v-for="v in ['rail', 'ladder', 'branch', 'film']" :key="v" :href="`?v=${v}`" :aria-current="variant === v || undefined">{{ v }}</a>
    </nav>
    <div ref="frame" class="frame">
      <header class="bar">
        <span class="bar__title">{{ title }}</span>
        <span class="bar__chip">worktree</span>
        <span class="bar__sp" />
        <button class="tl-btn" :aria-pressed="open" @click="open ? close(false) : show()">
          <IuIcon name="clock" :size="14" /> Timeline <kbd>⌥T</kbd>
        </button>
      </header>
      <div class="thread">
        <SessionThread :rows="rows" :entries="transcript" :working="false" harness="claude-code" root="/work/odin" />
      </div>
      <div class="dock"><div class="composer"><span>Message Claude…</span><span class="composer__r">Opus 5.5 · 44%</span></div></div>

      <!-- ① RAIL: a slim column of steps docked to the right edge -->
      <aside v-if="open && variant === 'rail'" class="rail" aria-label="Session timeline">
        <div class="rail__head"><span>Timeline</span><span class="dim">{{ all.length }} steps · 1h 25m</span></div>
        <ol class="rail__list">
          <li v-for="(t, i) in all" :key="t.id" :class="{ on: sel === i }" :data-mark="mark(t)" @click="sel = i" @dblclick="close(true)">
            <span class="rail__node" />
            <div class="rail__body">
              <div class="rail__row"><b>{{ t.n }}</b><span class="rail__q">{{ t.prompt }}</span><time>{{ clock(t.at) }}</time></div>
              <div v-if="sel === i" class="rail__open">
                <p class="rail__reply">{{ strip(t.reply) }}</p>
                <div class="chips">
                  <span v-if="t.files.length">{{ t.files.length }} file{{ t.files.length > 1 ? 's' : '' }}</span>
                  <span>{{ t.steps }} steps</span>
                  <span v-if="t.failed" class="bad">{{ t.failed }} failed</span>
                  <span v-if="t.agents">agent</span>
                </div>
                <div class="acts">
                  <button @click.stop="close(true)">Jump <kbd>↵</kbd></button>
                  <button @click.stop="copy('prompt')">Copy prompt <kbd>c</kbd></button>
                  <button @click.stop="copy('reply')">Copy reply <kbd>r</kbd></button>
                </div>
              </div>
            </div>
          </li>
        </ol>
        <footer class="keys"><kbd>↑↓</kbd> move <kbd>↵</kbd> stay here <kbd>esc</kbd> go back</footer>
      </aside>

      <!-- ② LADDER: a ⌘K-style finder with a preview pane -->
      <div v-if="open && variant === 'ladder'" class="scrim" @click.self="close(false)">
        <div class="ladder" role="dialog" aria-label="Session timeline">
          <div class="ladder__search">
            <IuIcon name="search" :size="16" />
            <input v-model="query" placeholder="Search this session’s steps, replies and files…" autofocus />
            <span class="dim">{{ visible.length }} of {{ all.length }}</span>
          </div>
          <div class="ladder__main">
            <ul class="ladder__list" role="listbox">
              <li v-for="t in visible" :key="t.id" role="option" :aria-selected="sel === t.n - 1" :class="{ on: sel === t.n - 1 }" :data-mark="mark(t)" @click="sel = t.n - 1" @dblclick="close(true)">
                <span class="ladder__n">{{ t.n }}</span>
                <span class="ladder__q">{{ t.prompt }}</span>
                <span class="ladder__meta">
                  <i v-if="t.failed" class="dot bad" title="a step failed" />
                  <i v-if="t.agents" class="dot agent" title="agent" />
                  <i v-if="t.tags.includes('contract')" class="dot ctr" title="contract" />
                  <time>{{ clock(t.at) }}</time>
                </span>
              </li>
              <li v-if="!visible.length" class="ladder__none">Nothing in this session matches “{{ query }}”.</li>
            </ul>
            <section class="ladder__pre" v-if="visible.length">
              <div class="pre__k">You · {{ clock(cur.at) }} · step {{ cur.n }}</div>
              <p class="pre__q">{{ cur.prompt }}</p>
              <div class="pre__k">Claude</div>
              <p class="pre__r">{{ strip(cur.reply) }}</p>
              <div v-if="cur.files.length" class="pre__files"><span v-for="f in cur.files" :key="f">{{ base(f) }}</span></div>
              <div class="acts">
                <button @click="close(true)">Jump here <kbd>↵</kbd></button>
                <button @click="copy('prompt')">Copy prompt <kbd>c</kbd></button>
                <button @click="copy('reply')">Copy reply <kbd>r</kbd></button>
              </div>
            </section>
          </div>
          <footer class="keys"><kbd>↑↓</kbd> move <kbd>↵</kbd> jump <kbd>esc</kbd> back where I was <span class="keys__r">the thread scrolls behind as you move</span></footer>
        </div>
      </div>

      <!-- ③ BRANCH: the session as a git-style trunk, forks for agents and failures -->
      <aside v-if="open && variant === 'branch'" class="branch" aria-label="Session timeline">
        <div class="branch__head">
          <span>Session tree</span>
          <div class="miniline" aria-hidden="true">
            <i v-for="t in all" :key="t.id" :style="{ left: pct(t.min) }" :data-mark="mark(t)" :class="{ on: sel === t.n - 1 }" />
          </div>
          <span class="dim">1h 25m</span>
        </div>
        <ol class="branch__list">
          <li v-for="(t, i) in all" :key="t.id" :class="{ on: sel === i }" :data-mark="mark(t)" @click="sel = i" @dblclick="close(true)">
            <svg class="g" width="64" height="56" viewBox="0 0 64 56" aria-hidden="true">
              <line x1="12" x2="12" :y1="i === 0 ? 28 : 0" :y2="i === all.length - 1 ? 28 : 56" class="g__trunk" />
              <path v-if="t.agents" d="M12 28 Q12 40 24 40 H44" class="g__fork g__fork--agent" />
              <circle v-if="t.agents" cx="46" cy="40" r="3" class="g__head g__head--agent" />
              <path v-if="t.failed" d="M12 28 Q12 16 24 16 H44" class="g__fork g__fork--bad" />
              <rect v-if="t.failed" x="43" y="13" width="6" height="6" class="g__head g__head--bad" />
              <circle cx="12" cy="28" :r="sel === i ? 6 : 4.5" class="g__node" />
              <path v-if="t.tags.includes('contract')" d="M54 22 l4 6 -4 6 -4 -6z" class="g__ctr" />
            </svg>
            <div class="branch__txt">
              <div class="branch__row"><span class="branch__q">{{ t.prompt }}</span><time>{{ clock(t.at) }}</time></div>
              <div class="branch__sub">
                <template v-if="t.files.length">{{ t.files.map(base).slice(0, 2).join(', ') }}{{ t.files.length > 2 ? ` +${t.files.length - 2}` : '' }} · </template>{{ t.steps }} steps · {{ dur(i) }}<template v-if="t.failed"> · <span class="bad">{{ t.failed }} failed</span></template>
              </div>
              <p v-if="sel === i" class="branch__reply">{{ strip(t.reply) }}</p>
              <div v-if="sel === i" class="acts">
                <button @click.stop="close(true)">Jump <kbd>↵</kbd></button>
                <button @click.stop="copy('prompt')">Copy prompt <kbd>c</kbd></button>
                <button @click.stop="copy('reply')">Copy reply <kbd>r</kbd></button>
              </div>
            </div>
          </li>
        </ol>
        <footer class="keys"><kbd>↑↓</kbd> walk <kbd>↵</kbd> stay <kbd>esc</kbd> back <span class="keys__r"><i class="lg lg--agent" />agent <i class="lg lg--bad" />failed <i class="lg lg--ctr" />contract</span></footer>
      </aside>

      <!-- ④ FILM: a strip of step cards rising out of the composer dock -->
      <section v-if="open && variant === 'film'" class="film" aria-label="Session timeline">
        <div class="film__scrub" aria-hidden="true">
          <i v-for="t in all" :key="t.id" :style="{ left: pct(t.min) }" :data-mark="mark(t)" :class="{ on: sel === t.n - 1 }" @click="sel = t.n - 1" />
          <span class="film__ends"><span>09:12</span><span>10:37</span></span>
        </div>
        <ol class="film__cards">
          <li v-for="(t, i) in all" :key="t.id" :class="{ on: sel === i }" :data-mark="mark(t)" :ref="el => sel === i && (el as HTMLElement | null)?.scrollIntoView?.({ inline: 'center', block: 'nearest' })" @click="sel = i" @dblclick="close(true)">
            <div class="card__top"><b>{{ t.n }}</b><time>{{ clock(t.at) }}</time><span class="sp" /><span v-if="t.failed" class="bad">{{ t.failed }} failed</span></div>
            <p class="card__q">{{ t.prompt }}</p>
            <div class="chips"><span v-if="t.files.length">{{ t.files.length }} file{{ t.files.length > 1 ? 's' : '' }}</span><span>{{ t.steps }} steps</span><span v-if="t.agents">agent</span></div>
            <div v-if="sel === i" class="card__acts">
              <button @click.stop="copy('prompt')" aria-label="Copy prompt"><IuIcon name="copy" :size="13" /> Prompt</button>
              <button @click.stop="copy('reply')" aria-label="Copy reply"><IuIcon name="copy" :size="13" /> Reply</button>
              <button @click.stop="close(true)">Jump</button>
            </div>
          </li>
        </ol>
        <footer class="keys"><kbd>←→</kbd> move <kbd>↵</kbd> jump <kbd>c</kbd> copy prompt <kbd>r</kbd> copy reply <kbd>esc</kbd> back</footer>
      </section>

      <div v-if="copied" class="lab-toast" role="status">{{ copied }}</div>
    </div>
  </div>
</template>

<style>
.lab { padding: 16px; font-family: var(--iu-font-sans, system-ui, sans-serif); color: var(--iu-text); background: var(--iu-well); min-height: 100vh; box-sizing: border-box; }
.lab-switch { display: flex; gap: 4px; margin-bottom: 10px; }
.lab-switch a { color: var(--iu-text-muted); text-decoration: none; padding: 3px 10px; border-radius: 6px; font-size: 12px; border: 1px solid transparent; }
.lab-switch a[aria-current] { color: var(--iu-text); border-color: var(--iu-border); background: var(--iu-surface); }
.frame { position: relative; display: flex; flex-direction: column; height: calc(100vh - 66px); min-height: 520px; background: var(--iu-ground); border: 1px solid var(--iu-hairline); border-radius: 10px; overflow: hidden; }
.bar { display: flex; align-items: center; gap: 10px; padding: 0 16px; height: 44px; border-bottom: 1px solid var(--iu-hairline); flex: none; }
.bar__title { font-weight: 500; font-size: 14px; }
.bar__chip { font-size: 11px; color: var(--iu-text-muted); border: 1px solid var(--iu-border); border-radius: 5px; padding: 1px 6px; }
.bar__sp { flex: 1; }
.tl-btn { display: inline-flex; align-items: center; gap: 6px; font: inherit; font-size: 12px; color: var(--iu-text-2); background: transparent; border: 1px solid var(--iu-border); border-radius: 6px; padding: 3px 8px; cursor: pointer; }
.tl-btn[aria-pressed='true'] { background: var(--iu-surface); color: var(--iu-text); }
.thread { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.thread > * { flex: 1; min-height: 0; }
.dock { flex: none; padding: 8px 16px 14px; max-width: 760px; width: 100%; margin: 0 auto; box-sizing: border-box; }
.composer { display: flex; justify-content: space-between; border: 1px solid var(--iu-border); border-radius: 10px; padding: 14px; color: var(--iu-text-muted); font-size: 13px; background: var(--iu-surface); }
kbd { font: 11px var(--iu-font-mono, ui-monospace, monospace); color: var(--iu-text-muted); border: 1px solid var(--iu-border); border-radius: 4px; padding: 0 4px; margin-left: 3px; background: var(--iu-surface-sunken); }
.dim { color: var(--iu-text-muted); font-size: 11px; }
.bad { color: var(--iu-danger); }
.lab-peek { outline: 1px solid var(--iu-info-border); outline-offset: 6px; border-radius: 8px; transition: outline-color 0.4s; }
.lab button { font: inherit; }
.acts { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.acts button { font-size: 12px; color: var(--iu-text-2); background: var(--iu-surface); border: 1px solid var(--iu-border); border-radius: 6px; padding: 3px 8px; cursor: pointer; }
.acts button:hover { color: var(--iu-text); border-color: var(--iu-border-strong); }
.chips { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
.chips span { font-size: 11px; color: var(--iu-text-muted); border: 1px solid var(--iu-hairline); border-radius: 5px; padding: 0 6px; }
.chips span.bad { color: var(--iu-danger); border-color: var(--iu-danger-border); }
.keys { display: flex; gap: 10px; align-items: center; padding: 8px 12px; border-top: 1px solid var(--iu-hairline); color: var(--iu-text-muted); font-size: 11px; flex: none; }
.keys__r { margin-left: auto; display: inline-flex; gap: 8px; align-items: center; }
.lab-toast { position: absolute; left: 50%; bottom: 20px; transform: translateX(-50%); background: var(--iu-raised); border: 1px solid var(--iu-border); border-radius: 8px; padding: 6px 12px; font-size: 12px; box-shadow: var(--iu-shadow-raised); z-index: 20; }
time { font: 11px var(--iu-font-mono, ui-monospace, monospace); color: var(--iu-text-muted); }
.lg { display: inline-block; width: 8px; height: 8px; margin-right: 3px; }
.lg--agent { border-radius: 50%; border: 1.5px dashed var(--iu-info); }
.lg--bad { background: var(--iu-danger); }
.lg--ctr { background: var(--iu-warning); transform: rotate(45deg) scale(0.8); }

/* ① rail */
.rail { position: absolute; top: 44px; right: 0; bottom: 0; width: 340px; background: var(--iu-surface); border-left: 1px solid var(--iu-border); box-shadow: var(--iu-shadow-raised); display: flex; flex-direction: column; z-index: 10; }
.rail__head { display: flex; justify-content: space-between; align-items: baseline; padding: 12px 16px 6px; font-size: 13px; font-weight: 500; }
.rail__list { list-style: none; margin: 0; padding: 4px 8px 8px 16px; overflow: auto; flex: 1; position: relative; }
.rail__list li { position: relative; display: flex; gap: 12px; padding: 6px 8px 6px 0; cursor: pointer; border-radius: 6px; }
.rail__list li::before { content: ''; position: absolute; left: 4px; top: 0; bottom: 0; width: 2px; background: var(--iu-border); }
.rail__list li:first-child::before { top: 16px; } .rail__list li:last-child::before { bottom: calc(100% - 16px); }
.rail__node { flex: none; width: 10px; height: 10px; margin-top: 6px; border-radius: 50%; background: var(--iu-ground); border: 2px solid var(--iu-text-muted); z-index: 1; box-sizing: border-box; margin-left: 0; }
li[data-mark='fail'] .rail__node { border-color: var(--iu-danger); } li[data-mark='agent'] .rail__node { border-color: var(--iu-info); border-style: dashed; } li[data-mark='contract'] .rail__node { border-color: var(--iu-warning); }
.rail__list li.on .rail__node { background: var(--iu-text); border-color: var(--iu-text); }
.rail__body { min-width: 0; flex: 1; padding: 2px 6px; border-radius: 6px; }
.rail__list li.on .rail__body { background: var(--iu-raised); }
.rail__row { display: flex; gap: 8px; align-items: baseline; font-size: 13px; }
.rail__row b { color: var(--iu-text-muted); font-weight: 500; font-size: 11px; width: 12px; }
.rail__q { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--iu-text-2); }
.rail__list li.on .rail__q { color: var(--iu-text); white-space: normal; }
.rail__reply { margin: 6px 0 0; font-size: 12px; color: var(--iu-text-muted); line-height: 1.45; }

/* ② ladder */
.scrim { position: absolute; inset: 0; background: var(--iu-scrim-light); display: flex; justify-content: center; padding-top: 9%; z-index: 10; }
.ladder { width: min(860px, 94%); height: fit-content; max-height: 76%; background: var(--iu-surface); border: 1px solid var(--iu-border); border-radius: 12px; box-shadow: var(--iu-shadow-dialog); display: flex; flex-direction: column; overflow: hidden; }
.ladder__search { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--iu-hairline); color: var(--iu-text-muted); }
.ladder__search input { flex: 1; background: transparent; border: 0; outline: 0; color: var(--iu-text); font: inherit; font-size: 14px; }
.ladder__main { display: grid; grid-template-columns: 1fr 1fr; min-height: 0; flex: 1; }
.ladder__list { list-style: none; margin: 0; padding: 6px; overflow: auto; border-right: 1px solid var(--iu-hairline); }
.ladder__list li { display: grid; grid-template-columns: 18px 1fr auto; gap: 8px; align-items: center; padding: 7px 8px; border-radius: 6px; font-size: 13px; cursor: pointer; color: var(--iu-text-2); }
.ladder__list li.on { background: var(--iu-raised); color: var(--iu-text); box-shadow: inset 2px 0 0 var(--iu-text-2); }
.ladder__n { color: var(--iu-text-muted); font-size: 11px; text-align: right; }
.ladder__q { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ladder__meta { display: inline-flex; gap: 6px; align-items: center; }
.dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
.dot.bad { background: var(--iu-danger); } .dot.agent { border: 1.5px dashed var(--iu-info); box-sizing: border-box; } .dot.ctr { background: var(--iu-warning); border-radius: 1px; transform: rotate(45deg) scale(0.85); }
.ladder__none { color: var(--iu-text-muted); display: block !important; padding: 16px; }
.ladder__pre { padding: 14px 16px; overflow: auto; font-size: 13px; }
.pre__k { font-size: 11px; color: var(--iu-text-muted); letter-spacing: 0.02em; margin-bottom: 4px; }
.pre__q { margin: 0 0 14px; line-height: 1.5; background: var(--iu-raised); border: 1px solid var(--iu-hairline); border-radius: 8px; padding: 8px 10px; user-select: text; }
.pre__r { margin: 0 0 10px; line-height: 1.5; color: var(--iu-text-2); user-select: text; }
.pre__files { display: flex; gap: 6px; flex-wrap: wrap; } .pre__files span { font: 11px var(--iu-font-mono, monospace); color: var(--iu-text-muted); background: var(--iu-surface-sunken); border-radius: 4px; padding: 1px 6px; }

/* ③ branch */
.branch { position: absolute; top: 44px; right: 0; bottom: 0; width: 400px; background: var(--iu-surface); border-left: 1px solid var(--iu-border); box-shadow: var(--iu-shadow-raised); display: flex; flex-direction: column; z-index: 10; }
.branch__head { display: flex; align-items: center; gap: 12px; padding: 12px 16px; font-size: 13px; font-weight: 500; border-bottom: 1px solid var(--iu-hairline); }
.miniline { position: relative; flex: 1; height: 14px; } .miniline::before { content: ''; position: absolute; left: 0; right: 0; top: 6px; height: 2px; background: var(--iu-border); border-radius: 2px; }
.miniline i, .film__scrub i { position: absolute; top: 3px; width: 8px; height: 8px; margin-left: -4px; border-radius: 50%; background: var(--iu-text-muted); }
.miniline i[data-mark='fail'], .film__scrub i[data-mark='fail'] { background: var(--iu-danger); } .miniline i[data-mark='agent'], .film__scrub i[data-mark='agent'] { background: var(--iu-info); }
.miniline i.on, .film__scrub i.on { background: var(--iu-text); box-shadow: 0 0 0 3px var(--iu-raised), 0 0 0 4px var(--iu-text-2); }
.branch__list { list-style: none; margin: 0; padding: 0 12px 0 4px; overflow: auto; flex: 1; }
.branch__list li { display: flex; gap: 0; min-height: 56px; cursor: pointer; border-radius: 6px; }
.branch__list li.on { background: var(--iu-raised); }
.g { flex: none; } .g__trunk { stroke: var(--iu-text-muted); stroke-width: 2; stroke-linecap: round; }
.g__node { fill: var(--iu-ground); stroke: var(--iu-text-2); stroke-width: 2; } li.on .g__node { fill: var(--iu-text); stroke: var(--iu-text); }
.g__fork { fill: none; stroke-width: 1.6; stroke-linecap: round; } .g__fork--agent { stroke: var(--iu-info); stroke-dasharray: 3 2; } .g__fork--bad { stroke: var(--iu-danger); }
.g__head--agent { fill: var(--iu-info); } .g__head--bad { fill: var(--iu-danger); } .g__ctr { fill: var(--iu-warning); transform: translate(2px, 0) scale(0.8); transform-origin: 54px 28px; }
.branch__txt { flex: 1; min-width: 0; padding: 9px 0 9px 0; }
.branch__row { display: flex; gap: 8px; align-items: baseline; font-size: 13px; } .branch__q { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--iu-text-2); }
li.on .branch__q { color: var(--iu-text); white-space: normal; }
.branch__sub { font-size: 11px; color: var(--iu-text-muted); margin-top: 2px; }
.branch__reply { margin: 6px 0 0; font-size: 12px; color: var(--iu-text-muted); line-height: 1.45; }
.branch__txt { padding-right: 8px; }

/* ④ film */
.film { position: absolute; left: 0; right: 0; bottom: 0; background: var(--iu-surface); border-top: 1px solid var(--iu-border); box-shadow: 0 -12px 28px rgb(0 0 0 / 0.4); z-index: 10; padding-top: 12px; }
.film__scrub { position: relative; margin: 0 24px; height: 14px; } .film__scrub::before { content: ''; position: absolute; left: 0; right: 0; top: 6px; height: 2px; background: var(--iu-border); border-radius: 2px; }
.film__scrub i { cursor: pointer; } .film__ends { position: absolute; left: 0; right: 0; top: 14px; display: flex; justify-content: space-between; font: 10px var(--iu-font-mono, monospace); color: var(--iu-text-muted); }
.film__cards { list-style: none; margin: 22px 0 0; padding: 4px 24px 12px; display: flex; gap: 10px; overflow-x: auto; }
.film__cards li { flex: none; width: 232px; border: 1px solid var(--iu-hairline); background: var(--iu-ground); border-radius: 10px; padding: 10px 12px; cursor: pointer; }
.film__cards li.on { border-color: var(--iu-border-strong); background: var(--iu-raised); }
.card__top { display: flex; gap: 8px; align-items: baseline; font-size: 12px; } .card__top b { font-weight: 500; color: var(--iu-text-2); } .sp { flex: 1; }
.card__q { margin: 6px 0 0; font-size: 13px; line-height: 1.4; color: var(--iu-text-2); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; min-height: 54px; }
li.on .card__q { color: var(--iu-text); }
.film__cards li[data-mark='fail'] { border-top: 2px solid var(--iu-danger-border); } .film__cards li[data-mark='agent'] { border-top: 2px dashed var(--iu-info-border); }
.card__acts { display: flex; gap: 6px; margin-top: 8px; } .card__acts button { font-size: 11px; color: var(--iu-text-2); background: var(--iu-surface); border: 1px solid var(--iu-border); border-radius: 6px; padding: 2px 7px; cursor: pointer; display: inline-flex; gap: 4px; align-items: center; }
</style>
