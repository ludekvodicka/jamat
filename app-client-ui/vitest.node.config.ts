import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'node',
    environment: 'node',
    include: [
      'app/**/*.test.ts',
      'preload/**/*.test.ts',
      'shared/**/*.test.ts',
      'scripts/**/*.test.ts',
    ],
  },
})
