/// <reference types="vitest" />
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import type { PluginOption } from 'vite'

const plugins: PluginOption[] = [react()]

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins,
  build: {
    chunkSizeWarningLimit: 3000,
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
