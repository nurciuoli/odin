// shots.mjs — screenshot app routes for visual review, on the mock API by default.
//
//   yarn workspace @odin/web shots /projects /p/odin/settings
//   yarn workspace @odin/web shots --width 900 /projects     narrow layout
//   yarn workspace @odin/web shots --width 720 --scale 2 /projects   zoomed detail check
//   yarn workspace @odin/web shots --live /projects          against a running core instead of ?mock
//   yarn workspace @odin/web shots --before path/to/steps.mjs /projects/new
//     steps.mjs: `export default async (page, { route, log }) => { … }` — runs
//     after load, before capture: type, press keys, click, and log() what you
//     assert. Thrown errors are reported as failures. Keep step files in your
//     scratchpad, not the repo.
//
// Boots its own Vite dev server on a free port, so it never collides with a
// running `yarn dev`. Writes .shots/<route>.png and prints any console
// errors/warnings.
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { mkdir, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

const args = process.argv.slice(2)
let width = 1440
let scale = 1
let beforePath = null
const routes = []
let live = false
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--width') width = Number(args[++i])
  else if (args[i] === '--scale') scale = Number(args[++i])
  else if (args[i] === '--before') beforePath = args[++i]
  else if (args[i] === '--live') live = true
  else {
    // Git Bash (MSYS) rewrites a leading-slash arg into a Windows path, e.g.
    // /components/button → C:/Program Files/Git/components/button — undo that
    const route = args[i].replace(/\\/g, '/').replace(/^[A-Za-z]:\/.*?\/Git(?=\/)/, '')
    if (route === 'index' || route === '/') routes.push('/')
    else routes.push(route.startsWith('/') ? route : `/${route}`)
  }
}

// Prefer Playwright's pinned browser; if its download is missing (the install
// hangs on some Windows machines), fall back to any complete headless shell
// already in the shared ms-playwright cache.
async function launchBrowser() {
  try {
    return await chromium.launch()
  } catch (err) {
    const { homedir } = await import('node:os')
    const { existsSync } = await import('node:fs')
    const cache =
      process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), 'AppData', 'Local', 'ms-playwright')
    const shells = existsSync(cache)
      ? (await readdir(cache))
          .filter(
            d =>
              d.startsWith('chromium_headless_shell-') &&
              existsSync(join(cache, d, 'INSTALLATION_COMPLETE')),
          )
          .sort()
          .reverse()
      : []
    for (const dir of shells) {
      // newer shells ship chrome-headless-shell-*/chrome-headless-shell; older Linux ones chrome-linux/headless_shell
      const sub = (await readdir(join(cache, dir))).find(
        d => d.startsWith('chrome-headless-shell') || d === 'chrome-linux',
      )
      const bin =
        sub === 'chrome-linux'
          ? 'headless_shell'
          : process.platform === 'win32'
            ? 'chrome-headless-shell.exe'
            : 'chrome-headless-shell'
      const exe = sub && join(cache, dir, sub, bin)
      if (exe && existsSync(exe)) {
        console.warn(`(pinned browser missing — using ${dir})`)
        return chromium.launch({ executablePath: exe })
      }
    }
    // Linux containers ship a Chromium outside the cache layout
    const preinstalled = '/opt/pw-browsers/chromium'
    if (existsSync(preinstalled)) return chromium.launch({ executablePath: preinstalled })
    throw err
  }
}

if (!routes.length) {
  console.error(
    'usage: yarn shots <route> [route…] [--width N] [--live]  (mock data unless --live)',
  )
  process.exit(1)
}

const { pathToFileURL } = await import('node:url')
const { resolve } = await import('node:path')
const before = beforePath ? (await import(pathToFileURL(resolve(beforePath)).href)).default : null

const server = await createServer({ logLevel: 'error', server: { port: 5199, strictPort: false } })
await server.listen()
const base = server.resolvedUrls.local[0].replace(/\/$/, '')
const browser = await launchBrowser()
const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: scale })
await mkdir('.shots', { recursive: true })

let problems = 0
for (const route of routes) {
  const logs = []
  const onConsole = m => {
    if (m.type() === 'error' || m.type() === 'warning') logs.push(`${m.type()}: ${m.text()}`)
  }
  const onError = e => logs.push(`pageerror: ${e.message}`)
  page.on('console', onConsole)
  page.on('pageerror', onError)
  // a file saved mid-capture (parallel builders) can trigger a Vite full
  // reload that lands on the wrong page — check we're where we asked, retry once
  for (let attempt = 0; attempt < 2; attempt++) {
    const url = live ? route : `${route}${route.includes('?') ? '&' : '?'}mock`
    await page.goto(base + url, { waitUntil: 'networkidle' })
    await page.waitForSelector('h1', { timeout: 5000 }).catch(() => {})
    if (new URL(page.url()).pathname === route.split('?')[0]) break
  }
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(150)
  if (before) {
    try {
      await before(page, { route, log: msg => logs.push(`step: ${msg}`) })
    } catch (e) {
      logs.push(`step failed: ${e.message.split('\n')[0]}`)
    }
  }
  // the app is a shell: the page doesn't scroll, its content pane
  // does — so fullPage alone only ever captures the first screen. Grow the
  // viewport until the pane's whole content fits, then capture.
  const fullHeight = await page.evaluate(() => {
    const pane = document.querySelector('.iu-shell__content')
    if (!pane) return 0
    return Math.ceil(pane.getBoundingClientRect().top + pane.scrollHeight)
  })
  if (fullHeight > 900) {
    await page.setViewportSize({ width, height: Math.min(fullHeight, 12000) })
    await page.waitForTimeout(120)
  }
  const file = join(
    '.shots',
    `${route.split('?')[0].replace(/^\//, '').replace(/[/]/g, '__') || 'index'}.png`,
  )
  await page.screenshot({ path: file, fullPage: true })
  await page.setViewportSize({ width, height: 900 })
  page.off('console', onConsole)
  page.off('pageerror', onError)
  const bad = logs.filter(l => !l.startsWith('step: ')).length
  problems += bad
  console.log(`${relative('.', file)}${bad ? '' : '  ✓ clean console'}`)
  for (const l of logs) console.log(`  ${l}`)
}

await browser.close()
await server.close()
process.exit(problems ? 2 : 0)
