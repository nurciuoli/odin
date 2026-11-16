// build-strict.mjs — production build that fails on any warning.
// A Vite/esbuild warning once hid a real API bug (two v-models sharing a
// modifiers prop), so warnings are errors here.
import { build, createLogger } from 'vite'
import { buildWidgets } from './build-widgets.mjs'

const logger = createLogger('warn')
let warnings = 0
for (const level of ['warn', 'warnOnce']) {
  const original = logger[level].bind(logger)
  logger[level] = (msg, opts) => {
    warnings++
    original(msg, opts)
  }
}

await build({ customLogger: logger, logLevel: 'warn' })
await buildWidgets(logger)
if (warnings) {
  console.error(`\nbuild: ${warnings} warning(s) — treat as errors`)
  process.exit(1)
}
console.log('build: clean')
