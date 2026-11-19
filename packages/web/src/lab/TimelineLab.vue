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
// morph: 'off' | 'in' (rows placed over their prompts, no transition) | 'on' | 'out'
const mState = ref<'off' | 'in' | 'on' | 'out'>('off')
const offs = ref<number[]>([])
const liEls = () => [...(frame.value?.querySelectorAll<HTMLElement>('.morph__li') ?? [])]
function measure() {
  const lis = liEls()
  offs.value = userEls().map((el, i) => Math.max(-700, Math.min(900, el.getBoundingClientRect().top - (lis[i]?.getBoundingClientRect().top ?? 0))))
}
async function morphOpen() {
  mState.value = 'in'
  offs.value = []
  await nextTick()
  measure()
  await nextTick()
  void frame.value?.offsetHeight
  requestAnimationFrame(() => requestAnimationFrame(() => (mState.value = 'on')))
}
function morphClose(keep: boolean) {
  const sc = scroller()
  if (keep) peek(sel.value)
  else if (sc) sc.scrollTop = saved
  measure()
  mState.value = 'out'
  setTimeout(() => {
    mState.value = 'off'
    userEls().forEach(e => e.classList.remove('lab-peek'))
  }, 620)
  if (keep) {
    const el = userEls()[sel.value]
    setTimeout(() => el?.classList.add('lab-peek'), 500)
    setTimeout(() => el?.classList.remove('lab-peek'), 1700)
  }
}

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
  if (variant.value === 'morph') return void morphOpen()
  nextTick(() => peek(sel.value))
}
function close(keep: boolean) {
  open.value = false
  if (variant.value === 'morph') return morphClose(keep)
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
watch(sel, i => open.value && variant.value !== 'morph' && peek(i))
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
      <a v-for="v in ['rail', 'ladder', 'branch', 'film', 'crawl', 'margin', 'm1', 'm2', 'm3', 'm4', 'morph']" :key="v" :href="`?v=${v}`" :aria-current="variant === v || undefined">{{ v }}</a>
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
      <div class="thread" :class="{ 'thread--morph': mState === 'on' }">
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

      <!-- ⑤ CRAWL: the thread recedes; steps scroll away in perspective, like the opening crawl -->
      <section v-if="open && variant === 'crawl'" class="crawl" aria-label="Session timeline" @wheel.prevent="move($event.deltaY > 0 ? 1 : -1)">
        <div class="crawl__stars" aria-hidden="true" />
        <header class="crawl__title"><span>ᚨ</span> Session timeline <span class="dim">{{ sel + 1 }} / {{ all.length }}</span></header>
        <div class="crawl__stage">
          <div class="crawl__plane">
            <ol class="crawl__list" :style="{ transform: `translateY(${-sel * 240}px)` }">
              <li v-for="(t, i) in all" :key="t.id" :class="{ on: sel === i }" :style="{ opacity: sel === i ? 1 : Math.max(0.08, 1 - Math.abs(i - sel) * (i > sel ? 0.5 : 0.3)) }" :data-mark="mark(t)" @click="sel = i" @dblclick="close(true)">
                <div class="crawl__k">Step {{ ['I','II','III','IV','V','VI','VII','VIII'][i] }} · {{ clock(t.at) }}<template v-if="t.failed"> · {{ t.failed }} failed</template><template v-if="t.agents"> · an agent was sent out</template></div>
                <p class="crawl__q">{{ t.prompt }}</p>
                <p class="crawl__r">{{ strip(t.reply) }}</p>
              </li>
            </ol>
          </div>
        </div>
        <footer class="crawl__hud">
          <div class="chips"><span v-if="cur.files.length">{{ cur.files.map(base).join(' · ') }}</span><span>{{ cur.steps }} steps</span></div>
          <div class="acts">
            <button @click="close(true)">Jump here <kbd>↵</kbd></button>
            <button @click="copy('prompt')">Copy prompt <kbd>c</kbd></button>
            <button @click="copy('reply')">Copy reply <kbd>r</kbd></button>
          </div>
          <div class="keys keys--flat"><kbd>↑↓</kbd> or scroll <kbd>esc</kbd> back where I was</div>
        </footer>
      </section>

      <!-- ⑥ MARGIN: no panel, no scrim. The steps appear as a quiet list in the thread's own side gutter -->
      <nav v-if="open && variant === 'margin'" class="margin" aria-label="Session timeline">
        <ol class="margin__list">
          <li v-for="(t, i) in all" :key="t.id" :class="{ on: sel === i, past: i < sel, next: i > sel }" :data-mark="mark(t)" @click="sel = i" @dblclick="close(true)">
            <span class="margin__tick" />
            <div class="margin__txt">
              <div class="margin__k"><time>{{ clock(t.at) }}</time><span v-if="t.failed" class="bad">failed</span><span v-if="t.agents">agent</span><span v-if="t.files.length">{{ t.files.length }} file{{ t.files.length > 1 ? 's' : '' }}</span></div>
              <p class="margin__q">{{ t.prompt }}</p>
              <div v-if="sel === i" class="margin__acts">
                <button @click.stop="copy('prompt')">Copy prompt <kbd>c</kbd></button>
                <button @click.stop="copy('reply')">Copy reply <kbd>r</kbd></button>
                <button @click.stop="close(true)">Stay <kbd>↵</kbd></button>
              </div>
            </div>
          </li>
        </ol>
        <p class="margin__keys"><kbd>↑↓</kbd> move <kbd>esc</kbd> back</p>
      </nav>

      <!-- m1 TICKS: always-on minimap of ticks in the gutter; ⌥T opens the labels -->
      <nav v-if="variant === 'm1'" class="mg mg1" :class="{ open }" aria-label="Session timeline">
        <ol>
          <li v-for="(t, i) in all" :key="t.id" :class="{ on: open && sel === i }" :data-mark="mark(t)" :style="{ top: `calc(${(t.min / span) * 100}% )` }" @click="open ? (sel = i) : ((sel = i), show())">
            <i class="mg1__tick" />
            <span v-if="open" class="mg1__lab"><time>{{ clock(t.at) }}</time> {{ t.prompt }}</span>
          </li>
        </ol>
        <div v-if="open" class="mg1__card">
          <p>{{ cur.prompt }}</p>
          <div class="margin__acts"><button @click="copy('prompt')">Copy prompt <kbd>c</kbd></button><button @click="copy('reply')">Copy reply <kbd>r</kbd></button><button @click="close(true)">Stay <kbd>↵</kbd></button></div>
        </div>
      </nav>

      <!-- m2 LEDGER: dense one-line rows with a type-to-filter, for long sessions -->
      <nav v-if="open && variant === 'm2'" class="mg mg2" aria-label="Session timeline">
        <input v-model="query" class="mg2__q" placeholder="Filter steps…" autofocus />
        <ol>
          <li v-for="t in visible" :key="t.id" :class="{ on: sel === t.n - 1 }" :data-mark="mark(t)" @click="sel = t.n - 1" @dblclick="close(true)">
            <b>{{ t.n }}</b><span class="mg2__t">{{ t.prompt }}</span><time>{{ clock(t.at) }}</time>
            <div v-if="sel === t.n - 1" class="mg2__open">
              <p>{{ strip(t.reply) }}</p>
              <div class="margin__acts"><button @click.stop="copy('prompt')">Copy prompt <kbd>c</kbd></button><button @click.stop="copy('reply')">Copy reply <kbd>r</kbd></button><button @click.stop="close(true)">Stay <kbd>↵</kbd></button></div>
            </div>
          </li>
        </ol>
      </nav>

      <!-- m3 TREE: the gutter carries the session's trunk, same glyphs as the Background tasks graph -->
      <nav v-if="open && variant === 'm3'" class="mg mg3" aria-label="Session timeline">
        <ol>
          <li v-for="(t, i) in all" :key="t.id" :class="{ on: sel === i }" :data-mark="mark(t)" @click="sel = i" @dblclick="close(true)">
            <svg width="44" height="46" viewBox="0 0 44 46" aria-hidden="true">
              <line x1="8" x2="8" :y1="i === 0 ? 23 : 0" :y2="i === all.length - 1 ? 23 : 46" class="g__trunk" />
              <path v-if="t.agents" d="M8 23 Q8 33 18 33 H32" class="g__fork g__fork--agent" /><circle v-if="t.agents" cx="34" cy="33" r="2.6" class="g__head--agent" />
              <path v-if="t.failed" d="M8 23 Q8 13 18 13 H32" class="g__fork g__fork--bad" /><rect v-if="t.failed" x="31" y="10" width="6" height="6" class="g__head--bad" />
              <circle cx="8" cy="23" :r="sel === i ? 5.5 : 4" class="g__node" />
            </svg>
            <div><p class="margin__q">{{ t.prompt }}</p><div v-if="sel === i" class="mg3__acts"><button title="Copy your prompt (c)" @click.stop="copy('prompt')"><IuIcon name="copy" :size="11" />you<kbd>c</kbd></button><button title="Copy Claude's reply (r)" @click.stop="copy('reply')"><IuIcon name="copy" :size="11" />Claude<kbd>r</kbd></button><button title="Stay here (Enter)" @click.stop="close(true)">↵</button></div></div>
          </li>
        </ol>
        <p class="mg3__keys">↑↓ · ↵ · esc</p>
      </nav>

      <!-- m4 ANCHOR: a narrow numbered rail; the chosen step opens a card beside the thread with the full text to copy from -->
      <nav v-if="open && variant === 'm4'" class="mg mg4" aria-label="Session timeline">
        <ol>
          <li v-for="(t, i) in all" :key="t.id" :class="{ on: sel === i }" :data-mark="mark(t)" @click="sel = i" @dblclick="close(true)"><b>{{ t.n }}</b><time>{{ clock(t.at) }}</time></li>
        </ol>
        <article class="mg4__card">
          <div class="pre__k">You · {{ clock(cur.at) }}</div>
          <p class="mg4__p">{{ cur.prompt }}</p>
          <div class="pre__k">Claude</div>
          <p class="mg4__r">{{ strip(cur.reply) }}</p>
          <div v-if="cur.files.length" class="pre__files"><span v-for="f in cur.files" :key="f">{{ base(f) }}</span></div>
          <div class="margin__acts"><button @click="copy('prompt')">Copy prompt <kbd>c</kbd></button><button @click="copy('reply')">Copy reply <kbd>r</kbd></button><button @click="close(true)">Stay <kbd>↵</kbd></button></div>
        </article>
      </nav>

      <!-- morph: the thread's turns collapse in place; each prompt glides into a row, Claude's work folds into its sub-line -->
      <section v-if="variant === 'morph' && mState !== 'off'" class="morph" :class="`morph--${mState}`" aria-label="Session timeline">
        <div class="morph__col">
          <div class="morph__head"><span>Timeline</span><span class="dim">{{ all.length }} steps · 1h 25m</span></div>
          <ol>
            <li v-for="(t, i) in all" :key="t.id" class="morph__li" :class="{ on: sel === i }" :data-mark="mark(t)" :style="{ transform: mState === 'on' ? 'none' : `translateY(${offs[i] ?? 0}px)`, transitionDelay: mState === 'on' || mState === 'out' ? `${Math.abs(i - sel) * 18}ms` : '0ms' }" @click="sel = i" @dblclick="close(true)">
              <b>{{ t.n }}</b>
              <div class="morph__main">
                <div class="morph__row"><span class="morph__q">{{ t.prompt }}</span><time>{{ clock(t.at) }}</time></div>
                <div class="morph__sub">Claude worked {{ dur(i) }} · {{ t.steps }} steps<template v-if="t.files.length"> · {{ t.files.length }} file{{ t.files.length > 1 ? 's' : '' }}</template><template v-if="t.agents"> · agent</template><template v-if="t.failed"> · <span class="bad">{{ t.failed }} failed</span></template></div>
                <div class="morph__open" :data-open="sel === i">
                  <div>
                    <p class="morph__reply">{{ strip(t.reply) }}</p>
                    <div class="margin__acts"><button tabindex="-1" @click.stop="copy('prompt')">Copy prompt <kbd>c</kbd></button><button tabindex="-1" @click.stop="copy('reply')">Copy reply <kbd>r</kbd></button><button tabindex="-1" @click.stop="close(true)">Open in thread <kbd>↵</kbd></button></div>
                  </div>
                </div>
              </div>
            </li>
          </ol>
          <p class="morph__keys"><kbd>↑↓</kbd> move <kbd>↵</kbd> open in thread <kbd>esc</kbd> back where I was</p>
        </div>
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

/* ⑤ crawl */
.crawl { position: absolute; inset: 44px 0 0; z-index: 10; background: radial-gradient(ellipse at 50% 100%, rgb(18 18 17 / 0.94), rgb(8 8 8 / 0.98) 70%); overflow: hidden; display: flex; flex-direction: column; align-items: center; animation: crawl-in 0.5s var(--iu-ease); }
@keyframes crawl-in { from { opacity: 0; } }
.crawl__stars { position: absolute; inset: 0; background-image: radial-gradient(1px 1px at 12% 18%, #fff8, transparent), radial-gradient(1px 1px at 78% 12%, #fff6, transparent), radial-gradient(1.5px 1.5px at 34% 42%, #fff5, transparent), radial-gradient(1px 1px at 90% 55%, #fff6, transparent), radial-gradient(1px 1px at 6% 70%, #fff5, transparent), radial-gradient(1px 1px at 58% 28%, #fff4, transparent), radial-gradient(1.5px 1.5px at 66% 78%, #fff4, transparent), radial-gradient(1px 1px at 22% 88%, #fff5, transparent); pointer-events: none; }
.crawl__title { position: relative; z-index: 2; margin-top: 14px; font-size: 11px; letter-spacing: 0.28em; text-transform: uppercase; color: var(--iu-hue-2-ink); display: flex; gap: 10px; align-items: baseline; }
.crawl__stage { position: relative; flex: 1; width: 100%; perspective: 520px; perspective-origin: 50% 8%; overflow: hidden; -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 22%, #000 78%, transparent 96%); mask-image: linear-gradient(to bottom, transparent 0, #000 22%, #000 78%, transparent 96%); }
.crawl__plane { position: absolute; left: 50%; top: 46%; width: 700px; margin-left: -350px; transform-origin: 50% 0; transform: rotateX(52deg); }
.crawl__list { list-style: none; margin: 0; padding: 0; transition: transform 0.6s var(--iu-ease); animation: crawl-run 0.9s var(--iu-ease); }
@keyframes crawl-run { from { margin-top: 520px; } }
.crawl__list li { height: 240px; box-sizing: border-box; cursor: pointer; text-align: justify; transition: opacity 0.4s; }
.crawl__k { text-align: center; font-size: 15px; letter-spacing: 0.22em; text-transform: uppercase; color: var(--iu-hue-2-ink); margin-bottom: 10px; }
.crawl__q { margin: 0 0 8px; font-size: 25px; line-height: 1.3; font-weight: 500; color: var(--iu-text-2); }
.crawl__r { margin: 0; font-size: 18px; line-height: 1.4; color: var(--iu-text-muted); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.crawl__list li.on .crawl__q { color: var(--iu-text); }
.crawl__list li[data-mark='fail'] .crawl__k { color: var(--iu-danger); }
.crawl__hud { position: relative; z-index: 2; padding: 10px 0 14px; display: flex; flex-direction: column; align-items: center; gap: 4px; }
.crawl__hud .chips, .crawl__hud .acts { justify-content: center; margin-top: 4px; }
.keys--flat { border: 0; padding: 4px 0 0; }

/* ⑥ margin */
.margin { position: absolute; top: 44px; bottom: 0; left: 0; width: 330px; z-index: 10; display: flex; flex-direction: column; justify-content: center; padding: 0 12px 0 20px; background: linear-gradient(to right, var(--iu-ground) 55%, transparent); }
.margin__list { list-style: none; margin: 0; padding: 0; position: relative; -webkit-mask-image: linear-gradient(to bottom, transparent, #000 14%, #000 86%, transparent); mask-image: linear-gradient(to bottom, transparent, #000 14%, #000 86%, transparent); }
.margin__list::before { content: ''; position: absolute; left: 3px; top: 0; bottom: 0; width: 1px; background: var(--iu-border); }
.margin__list li { position: relative; display: flex; gap: 14px; padding: 9px 0; cursor: pointer; opacity: 0.55; transition: opacity 0.2s; }
.margin__list li.past { opacity: 0.4; } .margin__list li:hover, .margin__list li.on { opacity: 1; }
.margin__tick { flex: none; width: 7px; height: 7px; margin-top: 5px; border-radius: 50%; background: var(--iu-ground); border: 1.5px solid var(--iu-text-muted); box-sizing: border-box; z-index: 1; }
li.on .margin__tick { background: var(--iu-text); border-color: var(--iu-text); }
li[data-mark='fail'] .margin__tick { border-color: var(--iu-danger); } li[data-mark='agent'] .margin__tick { border-color: var(--iu-info); border-style: dashed; }
.margin__txt { min-width: 0; }
.margin__k { display: flex; gap: 8px; font-size: 11px; color: var(--iu-text-muted); align-items: baseline; }
.margin__q { margin: 2px 0 0; font-size: 13px; line-height: 1.4; color: var(--iu-text-2); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
li.on .margin__q { color: var(--iu-text); -webkit-line-clamp: 4; }
.margin__acts { display: flex; gap: 6px; margin-top: 7px; flex-wrap: wrap; }
.margin__acts button { font-size: 11px; color: var(--iu-text-2); background: var(--iu-surface); border: 1px solid var(--iu-border); border-radius: 6px; padding: 2px 7px; cursor: pointer; }
.margin__keys { position: absolute; bottom: 14px; left: 20px; margin: 0; font-size: 11px; color: var(--iu-text-muted); }

/* margin family */
.mg { position: absolute; top: 44px; bottom: 0; left: 0; z-index: 10; padding: 0 12px 0 20px; display: flex; flex-direction: column; justify-content: center; }
.mg ol { list-style: none; margin: 0; padding: 0; }
.mg .margin__q { margin: 0; font-size: 13px; line-height: 1.4; color: var(--iu-text-2); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; } .mg li.on .margin__q { color: var(--iu-text); }
.margin__acts { display: flex; gap: 6px; margin-top: 7px; flex-wrap: wrap; } .margin__acts button { font-size: 11px; color: var(--iu-text-2); background: var(--iu-surface); border: 1px solid var(--iu-border); border-radius: 6px; padding: 2px 7px; cursor: pointer; }
/* m1 */
.mg1 { width: 40px; padding: 24px 0 24px 18px; justify-content: stretch; transition: width 0.2s var(--iu-ease); } .mg1.open { width: 330px; background: linear-gradient(to right, var(--iu-ground) 60%, transparent); }
.mg1 ol { position: relative; flex: 1; } .mg1 ol::before { content: ''; position: absolute; left: 3px; top: 0; bottom: 0; width: 1px; background: var(--iu-hairline); }
.mg1 li { position: absolute; left: 0; display: flex; gap: 12px; align-items: center; cursor: pointer; white-space: nowrap; max-width: 300px; }
.mg1__tick { width: 7px; height: 2px; border-radius: 1px; background: var(--iu-text-muted); opacity: 0.7; } .mg1 li:hover .mg1__tick { opacity: 1; width: 11px; }
.mg1 li[data-mark='fail'] .mg1__tick { background: var(--iu-danger); } .mg1 li[data-mark='agent'] .mg1__tick { background: var(--iu-info); }
.mg1 li.on .mg1__tick { background: var(--iu-text); width: 12px; height: 3px; opacity: 1; }
.mg1__lab { font-size: 12px; color: var(--iu-text-muted); overflow: hidden; text-overflow: ellipsis; max-width: 260px; } .mg1 li.on .mg1__lab { color: var(--iu-text); } .mg1__lab time { margin-right: 6px; }
.mg1__card { position: absolute; left: 20px; bottom: 16px; width: 290px; background: var(--iu-surface); border: 1px solid var(--iu-border); border-radius: 8px; padding: 8px 10px; box-shadow: var(--iu-shadow-popover); } .mg1__card p { margin: 0; font-size: 12px; line-height: 1.4; color: var(--iu-text-2); }
/* m2 */
.mg2 { width: 330px; background: linear-gradient(to right, var(--iu-ground) 60%, transparent); justify-content: flex-start; padding-top: 16px; }
.mg2__q { background: transparent; border: 0; border-bottom: 1px solid var(--iu-hairline); color: var(--iu-text); font: inherit; font-size: 12px; padding: 6px 0; margin-bottom: 6px; outline: 0; }
.mg2 ol { overflow: auto; }
.mg2 li { display: grid; grid-template-columns: 16px 1fr auto; gap: 8px; align-items: baseline; padding: 5px 6px; margin-left: -6px; border-radius: 6px; font-size: 12px; cursor: pointer; color: var(--iu-text-muted); }
.mg2 li b { font-weight: 400; text-align: right; font-size: 11px; } .mg2__t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mg2 li.on { background: var(--iu-surface); color: var(--iu-text); } .mg2 li[data-mark='fail'] b { color: var(--iu-danger); } .mg2 li[data-mark='agent'] b { color: var(--iu-info); }
.mg2__open { grid-column: 1 / -1; } .mg2__open p { margin: 6px 0 0 24px; color: var(--iu-text-muted); line-height: 1.4; } .mg2__open .margin__acts { margin-left: 24px; }
/* m3 */
.mg3 { width: 330px; background: linear-gradient(to right, var(--iu-ground) 60%, transparent); }
.mg3 li { display: flex; gap: 6px; align-items: center; min-height: 46px; cursor: pointer; opacity: 0.6; } .mg3 li.on, .mg3 li:hover { opacity: 1; } .mg3 svg { flex: none; margin-left: -8px; }
/* m4 */
.mg4 { width: auto; padding-left: 12px; flex-direction: row; align-items: center; gap: 12px; }
.mg4 ol { display: flex; flex-direction: column; gap: 2px; }
.mg4 li { display: flex; flex-direction: column; align-items: center; width: 40px; padding: 5px 0; border-radius: 6px; cursor: pointer; color: var(--iu-text-muted); } .mg4 li b { font-weight: 500; font-size: 13px; } .mg4 li time { font-size: 10px; }
.mg4 li.on { background: var(--iu-raised); color: var(--iu-text); box-shadow: inset 2px 0 0 var(--iu-text-2); } .mg4 li[data-mark='fail'] b { color: var(--iu-danger); } .mg4 li[data-mark='agent'] b { color: var(--iu-info); }
.mg4__card { width: 280px; align-self: center; background: var(--iu-surface); border: 1px solid var(--iu-border); border-radius: 10px; padding: 12px 14px; box-shadow: var(--iu-shadow-popover); }
.mg4__p { margin: 0 0 12px; font-size: 13px; line-height: 1.45; color: var(--iu-text); user-select: text; } .mg4__r { margin: 0 0 10px; font-size: 12px; line-height: 1.45; color: var(--iu-text-muted); user-select: text; }

/* morph */
.thread { transition: opacity 0.3s var(--iu-ease), transform 0.4s var(--iu-ease), filter 0.4s; }
.thread--morph { opacity: 0; transform: scale(0.985); filter: blur(2px); pointer-events: none; }
.morph { position: absolute; top: 44px; bottom: 0; left: 0; right: 0; z-index: 10; overflow: auto; }
.morph__col { width: 734px; max-width: 100%; margin: 0 auto; padding: 24px 0 56px; box-sizing: border-box; position: relative; min-height: 100%; }
.morph__head { display: flex; justify-content: space-between; padding: 0 12px 10px 40px; font-size: 13px; font-weight: 500; opacity: 0; transition: opacity 0.35s 0.15s; }
.morph--on .morph__head { opacity: 1; }
.morph ol { list-style: none; margin: 0; padding: 0; position: relative; }
.morph ol::before { content: ''; position: absolute; left: 14px; top: 8px; bottom: 8px; width: 1px; background: var(--iu-border); opacity: 0; transition: opacity 0.4s 0.2s; } .morph--on ol::before { opacity: 1; }
.morph__li { position: relative; display: flex; gap: 14px; align-items: flex-start; padding: 8px 12px 8px 4px; border-radius: 8px; cursor: pointer; transition: transform 0.5s var(--iu-ease), background 0.2s, opacity 0.25s; opacity: 0; }
.morph--on .morph__li, .morph--out .morph__li { opacity: 1; } .morph--in .morph__li { opacity: 0.001; }
.morph--out .morph__li { opacity: 0; transition: transform 0.5s var(--iu-ease), opacity 0.3s 0.25s; }
.morph__li b { flex: none; width: 20px; height: 20px; margin-top: 1px; display: grid; place-items: center; font-size: 11px; font-weight: 500; color: var(--iu-text-muted); background: var(--iu-ground); border: 1.5px solid var(--iu-text-muted); border-radius: 50%; box-sizing: border-box; position: relative; z-index: 1; }
.morph__li[data-mark='fail'] b { border-color: var(--iu-danger); } .morph__li[data-mark='agent'] b { border-color: var(--iu-info); border-style: dashed; }
.morph__li.on b { background: var(--iu-text); border-color: var(--iu-text); color: var(--iu-ground); }
.morph__li.on { background: var(--iu-surface); }
.morph__main { min-width: 0; flex: 1; }
.morph__row { display: flex; gap: 12px; align-items: baseline; }
.morph__q { flex: 1; font-size: 15px; color: var(--iu-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .morph__li.on .morph__q { color: var(--iu-text); white-space: normal; }
.morph__sub { font-size: 12px; color: var(--iu-text-muted); margin-top: 2px; }
.morph__open { display: grid; grid-template-rows: 0fr; transition: grid-template-rows 0.3s var(--iu-ease); } .morph__open[data-open='true'] { grid-template-rows: 1fr; } .morph__open > div { overflow: hidden; }
.morph__reply { margin: 8px 0 0; font-size: 13px; line-height: 1.5; color: var(--iu-text-muted); }
.morph__keys { margin: 18px 0 0 40px; font-size: 11px; color: var(--iu-text-muted); opacity: 0; transition: opacity 0.3s 0.3s; } .morph--on .morph__keys { opacity: 1; }

.mg3__acts { display: flex; gap: 4px; margin-top: 5px; }
.mg3__acts button { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; line-height: 16px; color: var(--iu-text-muted); background: transparent; border: 1px solid var(--iu-hairline); border-radius: 5px; padding: 0 5px; cursor: pointer; }
.mg3__acts button:hover { color: var(--iu-text); border-color: var(--iu-border); }
.mg3__acts kbd { margin: 0; padding: 0; border: 0; background: none; font-size: 10px; color: var(--iu-text-disabled); }
.mg3__keys { position: absolute; bottom: 14px; left: 20px; margin: 0; font: 10px var(--iu-font-mono, monospace); color: var(--iu-text-disabled); }
</style>
