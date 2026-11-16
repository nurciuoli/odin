import { build } from 'vite'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

/** Separate IIFE: sandboxed widget documents cannot load the application's module graph. */
export async function buildWidgets(customLogger) {
  await build({
    configFile: false,
    customLogger,
    logLevel: 'warn',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: {
      emptyOutDir: false,
      assetsInlineLimit: 1024 * 1024,
      chunkSizeWarningLimit: 6000,
      commonjsOptions: { transformMixedEsModules: true },
      lib: {
        entry: fileURLToPath(new URL('../src/widgets/runtime.ts', import.meta.url)),
        name: 'OdinWidgetRuntime',
        formats: ['iife'],
        fileName: () => 'widget-runtime.js',
      },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  })
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await buildWidgets()
