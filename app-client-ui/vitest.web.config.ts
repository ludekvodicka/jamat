import { resolve } from 'node:path'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: {
    dedupe: [
      '@testing-library/react',
      '@viz-js/viz',
      'dockview',
      'dompurify',
      'mermaid',
      'react',
      'react-dom',
      'react-markdown',
      'rehype-sanitize',
      'remark-directive',
      'remark-gfm',
      'shiki',
      'vega',
      'vega-lite',
      'vitest',
      'yaml',
    ],
  },
  server: { fs: { allow: [resolve(__dirname, '..')] } },
  test: {
    name: 'web',
    environment: 'jsdom',
    include: ['renderer/**/*.test.{ts,tsx}', '../mdext-renderer/renderer/**/*.test.{ts,tsx}'],
    setupFiles: ['./vitest.web.setup.ts'],
    // Both defaults are 5 s, and the setup file raises testing-library's waitFor ceiling to that
    // same 5 s, so one slow wait would consume a test's entire budget and report a timed-out test
    // instead of the element it was waiting for. These panels mount dockview and a full component
    // tree under jsdom; inside the publish build gate and on a CI runner that is several times
    // slower than an idle developer machine. A test that passes still costs nothing extra.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
