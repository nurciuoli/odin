// guard.mjs — repo-specific guardrails that ESLint can't express.
// Run: yarn guard   (part of yarn verify)
//
// Rules 1–7 come from Instrument UI (my-vue), where each was broken at least once.
// Rule 8 is Odin's: the artifact sandbox. Errors fail the run; warnings are printed.
import { readFile, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

const ROOT = process.cwd()
const errors = []
const warnings = []
const rel = p => relative(ROOT, p).split(sep).join('/')
const lineOf = (src, index) => src.slice(0, index).split('\n').length

async function walk(dir) {
  const out = []
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, d.name)
    if (d.isDirectory()) out.push(...(await walk(p)))
    else out.push(p)
  }
  return out
}

const styleBlocks = src =>
  [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => ({
    css: m[1],
    offset: m.index + m[0].indexOf(m[1]),
  }))
const stripComments = css => css.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))

const files = await walk(join(ROOT, 'src'))
const vueFiles = files.filter(f => f.endsWith('.vue'))
const isComponent = f => rel(f).startsWith('src/components/')
// App code built from the library: screens and the app shell. Same rules as the library's views had.
const isView = f => rel(f).startsWith('src/screens/') || rel(f).startsWith('src/app/')

// ── 1. tokens only: no colour literals or raw font stacks in components ──────
const COLOUR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/g
for (const f of vueFiles) {
  const src = await readFile(f, 'utf8')
  for (const { css, offset } of styleBlocks(src)) {
    const clean = stripComments(css)
    for (const m of clean.matchAll(COLOUR)) {
      const msg = `${rel(f)}:${lineOf(src, offset + m.index)} colour literal "${m[0]}" — use a token from tokens.css`
      errors.push(msg)
    }
    for (const m of clean.matchAll(/font-family:\s*(?!\s|var\(|inherit)([^;]+);/g)) {
      const msg = `${rel(f)}:${lineOf(src, offset + m.index)} raw font stack "${m[1].trim()}" — use var(--iu-font-sans|mono)`
      errors.push(msg)
    }
  }
}

// ── 1b. type tokens: UI sizes, weights, leading and caps tracking ───────────
// Display sizes (15px+) are per-component for now, so a rule that sets one may
// keep its own line-height and negative tracking.
const inlineStyles = src =>
  [...src.matchAll(/\sstyle="([^"]*)"/g)].map(m => ({
    css: m[1],
    offset: m.index + m[0].indexOf(m[1]),
  }))
for (const f of vueFiles) {
  const src = await readFile(f, 'utf8')
  for (const { css, offset } of [...styleBlocks(src), ...inlineStyles(src)]) {
    const clean = stripComments(css)
    const at = i => `${rel(f)}:${lineOf(src, offset + i)}`
    const ruleOf = i => clean.slice(clean.lastIndexOf('{', i) + 1, clean.indexOf('}', i) >>> 0)
    const isDisplay = i =>
      [...ruleOf(i).matchAll(/font-size:\s*([\d.]+)px/g)].some(m => Number(m[1]) >= 15)
    for (const m of clean.matchAll(/font-size:\s*([\d.]+)px/g))
      if (Number(m[1]) < 15)
        errors.push(`${at(m.index)} font-size ${m[1]}px — use var(--iu-font-size-*)`)
    for (const m of clean.matchAll(/font-weight:\s*(\d+|bold|normal)/g))
      errors.push(`${at(m.index)} font-weight ${m[1]} — use var(--iu-font-weight-*)`)
    for (const m of clean.matchAll(/line-height:\s*([\d.]+)\s*(?=[;}]|$)/g))
      if (!isDisplay(m.index))
        errors.push(`${at(m.index)} line-height ${m[1]} — use var(--iu-leading-*)`)
    for (const m of clean.matchAll(/letter-spacing:\s*([\d.]+)em/g))
      if (Number(m[1]) >= 0.05)
        errors.push(`${at(m.index)} letter-spacing ${m[1]}em — use var(--iu-tracking-caps*)`)
  }
}

// ── 2. screens never style library internals (.iu-foo__bar) ─────────────────
// A screen that needs a variant requests it from the component instead.
for (const f of vueFiles.filter(isView)) {
  const src = await readFile(f, 'utf8')
  for (const { css, offset } of styleBlocks(src)) {
    const clean = stripComments(css)
    for (const m of clean.matchAll(/\.iu-[a-z0-9-]+(?:__[a-z0-9-]+|--[a-z0-9-]+)/g)) {
      errors.push(
        `${rel(f)}:${lineOf(src, offset + m.index)} styles library internal "${m[0]}" — add a prop/variant to the component instead`,
      )
    }
  }
}

// ── 3. no v-html anywhere (Markdown renders through h()) ─────────────────────
// Icon.vue is the one exception: it injects the static, in-repo SVG strings from icons.ts.
const VHTML_OK = new Set(['src/components/Icon/Icon.vue'])
for (const f of vueFiles.filter(f => !VHTML_OK.has(rel(f)))) {
  const src = await readFile(f, 'utf8')
  // blank out <script> blocks so code samples in strings don't count; keep offsets for line numbers
  const markup = src.replace(/<script[\s\S]*?<\/script>/g, s => s.replace(/[^\n]/g, ' '))
  const m = markup.match(/\sv-html=/)
  if (m)
    errors.push(`${rel(f)}:${lineOf(src, m.index)} v-html — render through components/h() instead`)
}

// ── 6. component folders have a barrel ──────────────────────────────────────
const compDirs = new Set(
  files.filter(isComponent).map(f => rel(f).split('/').slice(0, 3).join('/')),
)
for (const d of compDirs) {
  if (!files.some(f => rel(f) === `${d}/index.ts`)) errors.push(`${d} has no index.ts barrel`)
}

// ── 7. leftovers ────────────────────────────────────────────────────────────
for (const f of files.filter(f => /\.(vue|ts)$/.test(f))) {
  const src = await readFile(f, 'utf8')
  const m = src.match(/TODO\(orchestrator\)/)
  if (m) errors.push(`${rel(f)}:${lineOf(src, m.index)} unresolved TODO(orchestrator)`)
}

// ── 8. artifacts render only in the sandboxed iframe ─────────────────────────
// Agent-written HTML must never reach the app's own DOM (srcdoc included): it loads from /a/<id>/<v> only.
for (const f of files.filter(f => /\.(vue|ts)$/.test(f))) {
  const src = await readFile(f, 'utf8')
  const m = src.match(/\bsrcdoc\b|allow-same-origin/)
  if (m)
    errors.push(
      `${rel(f)}:${lineOf(src, m.index)} "${m[0]}" — artifacts load from their own URL in a sandbox without allow-same-origin`,
    )
}

// ── report ──────────────────────────────────────────────────────────────────
for (const w of warnings) console.log(`warn  ${w}`)
for (const e of errors) console.log(`error ${e}`)
console.log(`\nguard: ${errors.length} error(s), ${warnings.length} warning(s)`)
process.exit(errors.length ? 1 : 0)
