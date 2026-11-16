// Markdown subset for assistant messages. Pure: no Vue, no DOM, no HTML.
// Anything outside the subset stays literal text. The output is a plain tree
// that the renderer walks with h(), so source text never reaches innerHTML.

export type Inline =
  | { kind: 'text'; value: string }
  | { kind: 'break' }
  | { kind: 'code'; value: string }
  | { kind: 'emphasis'; children: Inline[] }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] }
  // `name` is as written in the `mentions` list, not as typed in the source
  | { kind: 'mention'; name: string }

// threaded through the parser; `mentions` is longest-first so "Rae Okafor" beats "Rae"
interface Ctx {
  mentions: string[]
}

export interface ListItem {
  children: Inline[]
  nested: ListBlock | null
}

export interface ListBlock {
  kind: 'list'
  ordered: boolean
  start: number
  items: ListItem[]
}

export type Block =
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'heading'; level: 3 | 4; children: Inline[] }
  | { kind: 'code'; lang: string; value: string }
  | ListBlock
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'rule' }

const MAX_QUOTE_DEPTH = 6
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
const RULE = /^ {0,3}([-*])(?: *\1){2,} *$/
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/
const QUOTE = /^ {0,3}>/
const ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/

const WS = /\s/
const PUNCT = /[\p{P}\p{S}]/u

// ---------------------------------------------------------------- blocks

export function parseMarkdown(
  source: string,
  opts: { streaming?: boolean; mentions?: string[] } = {},
): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')
  const names = [...new Set((opts.mentions ?? []).map(m => m.trim()).filter(Boolean))]
  const ctx: Ctx = { mentions: names.sort((a, b) => b.length - a.length) }
  return parseBlocks(lines, 0, !!opts.streaming, ctx)
}

const isBlank = (line: string) => line.trim() === ''
const indentOf = (line: string) => /^ */.exec(line)![0].length
const isOrdered = (marker: string) => /^\d/.test(marker)

function fenceOf(line: string): { marker: string; info: string } | null {
  const m = FENCE.exec(line)
  if (!m) return null
  // a backtick fence's info string may not contain backticks (otherwise it is inline code)
  if (m[1].startsWith('`') && m[2].includes('`')) return null
  return { marker: m[1], info: m[2] }
}

function closesFence(line: string, marker: string): boolean {
  const m = FENCE_CLOSE.exec(line)
  return !!m && m[1].charAt(0) === marker.charAt(0) && m[1].length >= marker.length
}

function langOf(info: string): string {
  const lang = info.trim().split(/\s+/)[0] ?? ''
  return /^[A-Za-z0-9_+#.-]{1,32}$/.test(lang) ? lang : ''
}

// lines that end a paragraph; a plain line never does
function interrupts(line: string): boolean {
  return (
    !!fenceOf(line) || RULE.test(line) || HEADING.test(line) || QUOTE.test(line) || ITEM.test(line)
  )
}

// `atEnd` means this run of lines reaches the end of the source. Only then can
// a trailing half-typed marker be dropped while streaming.
function parseBlocks(lines: string[], depth: number, atEnd: boolean, ctx: Ctx): Block[] {
  let lastContent = lines.length - 1
  while (lastContent >= 0 && isBlank(lines[lastContent])) lastContent--
  const tailAt = (end: number) => atEnd && end > lastContent

  const out: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (isBlank(line)) {
      i++
      continue
    }

    const fence = fenceOf(line)
    if (fence) {
      // an unclosed fence runs to the end of the source (that is the streaming case)
      let j = i + 1
      const body: string[] = []
      while (j < lines.length && !closesFence(lines[j], fence.marker)) body.push(lines[j++])
      if (j < lines.length) j++
      out.push({ kind: 'code', lang: langOf(fence.info), value: body.join('\n') })
      i = j
      continue
    }

    if (RULE.test(line)) {
      out.push({ kind: 'rule' })
      i++
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      const text = (heading[2] ?? '').replace(/(^|[ \t]+)#+$/, '').trim()
      if (text) {
        out.push({
          kind: 'heading',
          level: Math.min(4, Math.max(3, heading[1].length)) as 3 | 4,
          children: parseInline(text, tailAt(i + 1), ctx),
        })
        i++
        continue
      }
    }

    if (QUOTE.test(line) && depth < MAX_QUOTE_DEPTH) {
      let j = i
      const inner: string[] = []
      while (j < lines.length && QUOTE.test(lines[j]))
        inner.push(lines[j++].replace(/^ {0,3}> ?/, ''))
      out.push({ kind: 'quote', blocks: parseBlocks(inner, depth + 1, tailAt(j), ctx) })
      i = j
      continue
    }

    if (ITEM.test(line)) {
      const { block, next } = parseList(lines, i, tailAt, ctx)
      out.push(block)
      i = next
      continue
    }

    let j = i + 1
    while (j < lines.length && !isBlank(lines[j]) && !interrupts(lines[j])) j++
    const text = lines
      .slice(i, j)
      .map(l => l.trim())
      .join('\n')
    out.push({ kind: 'paragraph', children: parseInline(text, tailAt(j), ctx) })
    i = j
  }
  return out
}

interface RawList {
  ordered: boolean
  start: number
  items: string[][]
}

interface RawItem {
  lines: string[]
  nested: RawList | null
}

// One top-level list plus one level of nesting. Deeper indentation folds into that level.
function parseList(
  lines: string[],
  from: number,
  tailAt: (end: number) => boolean,
  ctx: Ctx,
): { block: ListBlock; next: number } {
  const first = ITEM.exec(lines[from]) as RegExpExecArray
  const ordered = isOrdered(first[2])
  const start = ordered ? parseInt(first[2], 10) : 1

  const raw: RawItem[] = [{ lines: [first[3] ?? ''], nested: null }]
  let cur = raw[0]
  let j = from + 1
  while (j < lines.length) {
    const line = lines[j]
    if (isBlank(line)) {
      let q = j
      while (q < lines.length && isBlank(lines[q])) q++
      if (q >= lines.length) break
      const qItem = ITEM.exec(lines[q])
      if (qItem && indentOf(lines[q]) < 2 && isOrdered(qItem[2]) === ordered) {
        j = q
        continue
      }
      if (indentOf(lines[q]) >= 2) {
        j++
        continue
      }
      break
    }

    const indent = indentOf(line)
    const item = ITEM.exec(line)
    if (indent < 2) {
      if (item && isOrdered(item[2]) === ordered) {
        cur = { lines: [item[3] ?? ''], nested: null }
        raw.push(cur)
        j++
        continue
      }
      break
    }

    if (item) {
      const o = isOrdered(item[2])
      if (!cur.nested) cur.nested = { ordered: o, start: o ? parseInt(item[2], 10) : 1, items: [] }
      cur.nested.items.push([item[3] ?? ''])
    } else {
      const bucket = cur.nested ? cur.nested.items[cur.nested.items.length - 1] : cur.lines
      bucket.push(line.trim())
    }
    j++
  }

  const listTail = tailAt(j)
  const items: ListItem[] = raw.map((it, k) => {
    const tail = listTail && k === raw.length - 1
    if (!it.nested) return { children: parseInline(joinLines(it.lines), tail, ctx), nested: null }
    const n = it.nested
    const nestedItems: ListItem[] = n.items.map((ls, m) => ({
      children: parseInline(joinLines(ls), tail && m === n.items.length - 1, ctx, false),
      nested: null,
    }))
    return {
      children: parseInline(joinLines(it.lines), false, ctx),
      nested: { kind: 'list', ordered: n.ordered, start: n.start, items: nestedItems },
    }
  })

  return { block: { kind: 'list', ordered, start, items }, next: j }
}

const joinLines = (ls: string[]) =>
  ls
    .map(l => l.trim())
    .filter(l => l !== '')
    .join('\n')

// ---------------------------------------------------------------- inlines

type Token =
  | { k: 'text'; v: string }
  | { k: 'node'; node: Inline }
  | { k: 'delim'; ch: '*' | '_'; len: number; open: boolean; close: boolean }

// `drop` is set for the trailing block while streaming: an unfinished marker
// at the very end is removed instead of shown.
// `links` is off inside link labels and in nested list items; mentions are off inside link labels only.
function parseInline(
  text: string,
  drop: boolean,
  ctx: Ctx,
  links = true,
  mentions = true,
): Inline[] {
  return resolve(tokenize(text, drop, ctx, links, mentions), drop)
}

function runLength(s: string, i: number, ch: string): number {
  let r = 0
  while (s.charAt(i + r) === ch) r++
  return r
}

function findCodeClose(s: string, from: number, r: number): number {
  const run = '`'.repeat(r)
  let j = from
  for (;;) {
    const k = s.indexOf(run, j)
    if (k < 0) return -1
    if (s.charAt(k - 1) !== '`' && s.charAt(k + r) !== '`') return k
    j = k + 1
  }
}

function flanks(ch: '*' | '_', prev: string, next: string) {
  const left = !WS.test(next) && (!PUNCT.test(next) || WS.test(prev) || PUNCT.test(prev))
  const right = !WS.test(prev) && (!PUNCT.test(prev) || WS.test(next) || PUNCT.test(next))
  if (ch === '*') return { open: left, close: right }
  // underscore emphasis never opens or closes inside a word, so snake_case survives
  return {
    open: left && (!right || PUNCT.test(prev)),
    close: right && (!left || PUNCT.test(next)),
  }
}

// the URL may contain balanced parentheses, e.g. javascript:alert(1)
function closingParen(s: string, from: number): number {
  let depth = 1
  for (let p = from; p < s.length; p++) {
    const c = s.charAt(p)
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return p
  }
  return -1
}

function safeHref(raw: string): string | null {
  const url = raw.split(/\s+/)[0] ?? ''
  // control characters are how scheme filters get bypassed ("java\tscript:") — reject outright
  // eslint-disable-next-line no-control-regex
  if (!url || /[\u0000-\u001f\u007f]/.test(url)) return null
  if (/^(https?:|mailto:)/i.test(url)) return url
  if (url.startsWith('#')) return url
  if (url.startsWith('/') && !url.startsWith('//') && !url.startsWith('/\\')) return url
  return null
}

// a mention starts at a word boundary and ends where the name ends; the name must be listed
const NAME_CHAR = /[\p{L}\p{N}_-]/u
const MENTION_OPENER = '([{"\'*_~'
function mentionAt(s: string, i: number, names: string[]): string | null {
  const prev = i > 0 ? s.charAt(i - 1) : ' '
  if (!WS.test(prev) && !MENTION_OPENER.includes(prev)) return null
  for (const name of names) {
    const at = s.slice(i + 1, i + 1 + name.length)
    if (at.toLowerCase() !== name.toLowerCase()) continue
    if (NAME_CHAR.test(s.charAt(i + 1 + name.length))) continue
    return name
  }
  return null
}

function tokenize(s: string, drop: boolean, ctx: Ctx, links: boolean, mentions: boolean): Token[] {
  const out: Token[] = []
  let buf = ''
  const flush = () => {
    if (buf) {
      out.push({ k: 'text', v: buf })
      buf = ''
    }
  }
  const n = s.length
  let i = 0
  while (i < n) {
    const c = s.charAt(i)

    if (c === '\\' && i + 1 < n && '\\`*_[]'.includes(s.charAt(i + 1))) {
      buf += s.charAt(i + 1)
      i += 2
      continue
    }

    if (c === '\n') {
      flush()
      out.push({ k: 'node', node: { kind: 'break' } })
      i++
      continue
    }

    if (c === '`') {
      const r = runLength(s, i, '`')
      const close = findCodeClose(s, i + r, r)
      if (close < 0) {
        if (!(drop && i + r === n)) buf += '`'.repeat(r)
        i += r
        continue
      }
      flush()
      out.push({ k: 'node', node: { kind: 'code', value: s.slice(i + r, close) } })
      i = close + r
      continue
    }

    if (c === '[' && links) {
      const k = s.indexOf(']', i + 1)
      if (k > i + 1 && s.charAt(k + 1) === '(') {
        const label = s.slice(i + 1, k)
        const m = closingParen(s, k + 2)
        if (m >= 0) {
          const href = safeHref(s.slice(k + 2, m).trim())
          flush()
          out.push(
            href
              ? {
                  k: 'node',
                  node: {
                    kind: 'link',
                    href,
                    children: parseInline(label, false, ctx, false, false),
                  },
                }
              : { k: 'text', v: label },
          )
          i = m + 1
          continue
        }
        if (drop) {
          // half-typed link at the end: keep the label, drop the markup
          buf += label
          i = n
          continue
        }
      }
    }

    if (c === '@' && mentions && ctx.mentions.length) {
      const name = mentionAt(s, i, ctx.mentions)
      if (name) {
        flush()
        out.push({ k: 'node', node: { kind: 'mention', name } })
        i += 1 + name.length
        continue
      }
    }

    if (c === '*' || c === '_') {
      const r = runLength(s, i, c)
      if (r <= 2) {
        const prev = i > 0 ? s.charAt(i - 1) : ' '
        const next = i + r < n ? s.charAt(i + r) : ' '
        const f = flanks(c, prev, next)
        flush()
        out.push({ k: 'delim', ch: c, len: r, open: f.open, close: f.close })
      } else {
        buf += c.repeat(r)
      }
      i += r
      continue
    }

    buf += c
    i++
  }
  flush()
  return out
}

interface Frame {
  children: Inline[]
  closeAt: number
}

function resolve(tokens: Token[], drop: boolean): Inline[] {
  // Pair each closer with the nearest free opener of the same char and length.
  // Scanning back jumps over finished pairs, so groups nest and never cross.
  const partner = new Array<number>(tokens.length).fill(-1)
  for (let c = 0; c < tokens.length; c++) {
    const t = tokens[c]
    if (t.k !== 'delim' || !t.close) continue
    for (let o = c - 1; o >= 0; o--) {
      const u = tokens[o]
      if (u.k !== 'delim') continue
      if (partner[o] >= 0 && partner[o] < o) {
        o = partner[o]
        continue
      }
      if (partner[o] < 0 && u.open && u.ch === t.ch && u.len === t.len) {
        partner[o] = c
        partner[c] = o
        break
      }
    }
  }

  const root: Frame = { children: [], closeAt: -1 }
  const stack: Frame[] = [root]
  const top = () => stack[stack.length - 1]
  const pushText = (v: string) => {
    const kids = top().children
    const last = kids[kids.length - 1]
    if (last && last.kind === 'text') last.value += v
    else kids.push({ kind: 'text', value: v })
  }

  for (let idx = 0; idx < tokens.length; idx++) {
    const t = tokens[idx]
    if (t.k === 'text') {
      pushText(t.v)
    } else if (t.k === 'node') {
      top().children.push(t.node)
    } else {
      const p = partner[idx]
      if (p > idx) {
        stack.push({ children: [], closeAt: p })
      } else if (p >= 0 && stack.length > 1) {
        const frame = stack.pop() as Frame
        top().children.push({ kind: t.len === 2 ? 'strong' : 'emphasis', children: frame.children })
      } else if (!(drop && idx === tokens.length - 1)) {
        pushText(t.ch.repeat(t.len))
      }
    }
  }
  return root.children
}
