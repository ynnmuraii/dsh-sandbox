import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  test: {
    include: ['tooling/**/*.spec.ts'],
    environment: 'node',
    // Windows subprocess integration tests can exceed Vitest's 5s default under parallel load
    testTimeout: 15_000,
  },
  resolve: {
    alias: {
      '@lab': fileURLToPath(new URL('./tooling/src', import.meta.url)),
    },
  },
})
