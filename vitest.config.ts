import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  test: {
    include: ['tooling/**/*.spec.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      '@lab': fileURLToPath(new URL('./tooling/src', import.meta.url)),
    },
  },
})
