import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import { availableParallelism } from 'node:os'

// Dev server proxies the API, SSE and artifact pages to core (the dev channel, port 8791, unless ODIN_PORT says otherwise).
const core = `http://127.0.0.1:${process.env.ODIN_PORT ?? 8791}`

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/@lezer/markdown/')) return 'markdown-grammar'
        },
      },
    },
  },
  server: {
    port: 5190,
    proxy: { '/api': core, '/a/': core },
  },
  test: {
    // Threads start faster than forks. Capped at 8 (and below the core count) to avoid the suite-load
    // timeouts an uncapped run once hit; stable at 8 alongside the core suite.
    pool: 'threads',
    maxWorkers: Math.min(8, Math.max(1, availableParallelism() - 1)),
    // DOM tests only: pure-logic files opt out with `// @vitest-environment node` (happy-dom setup was ~half the run).
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
  },
})
