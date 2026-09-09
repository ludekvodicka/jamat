import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'lib-orchestrator',
    environment: 'node',
    include: ['**/*.test.ts'],
    passWithNoTests: true,
  },
})
