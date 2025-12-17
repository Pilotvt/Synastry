/// <reference types="vitest" />
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import type { PluginOption } from 'vite'
import path from 'node:path'

// Silence baseline-browser-mapping "old data" warning during build (force)
const originalWarn = console.warn
console.warn = (...args: unknown[]) => {
  if (args.some((a) => typeof a === 'string' && a.includes('baseline-browser-mapping'))) {
    return
  }
  return originalWarn(...args)
}
process.env.BROWSERSLIST_IGNORE_OLD_DATA = 'true'
process.env.BASELINE_BROWSER_MAPPING_IGNORE_OLD_DATA = 'true'

const baselineStubPlugin: PluginOption = {
  name: 'baseline-browser-mapping-stub',
  enforce: 'pre',
  resolveId(id) {
    if (id.includes('baseline-browser-mapping')) return id
    return null
  },
  load(id) {
    if (id.includes('baseline-browser-mapping')) {
      return `export const getCompatibleVersions = () => [];
        export const getAllVersions = () => [];
        export default () => [];`
    }
    return null
  },
}

const plugins: PluginOption[] = [react(), baselineStubPlugin]

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins,
  define: {
    'process.env.BASELINE_BROWSER_MAPPING_IGNORE_OLD_DATA': JSON.stringify('true'),
    'process.env.BROWSERSLIST_IGNORE_OLD_DATA': JSON.stringify('true'),
  },
  resolve: {
    alias: {
      'baseline-browser-mapping': path.resolve(__dirname, 'scripts/baseline-browser-mapping-stub.js'),
      'baseline-browser-mapping/dist': path.resolve(__dirname, 'scripts/baseline-browser-mapping-stub.js'),
    },
  },
  optimizeDeps: {
    exclude: ['baseline-browser-mapping'],
  },
  ssr: {
    external: [],
    noExternal: ['baseline-browser-mapping'],
  },
  build: {
    chunkSizeWarningLimit: 3000,
    rollupOptions: {
      onwarn(warning, warn) {
        const msg = typeof warning === 'string' ? warning : warning.message || '';
        if (msg.includes('baseline-browser-mapping')) return;
        warn(warning);
      },
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.ts'],
    coverage: {
      provider: 'v8'
    }
  }
})
