import '../scripts/checks/test-tmpdir.mjs'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['app/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
