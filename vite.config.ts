/// <reference types="vitest" />
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  // Cast to any to silence type mismatches between vitest's bundled vite types and local vite types
  plugins: [react() as any] as any,
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
