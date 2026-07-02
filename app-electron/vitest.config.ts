import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

/**
 * Vitest config for renderer component tests. Scope is `app-electron`
 * only — pure logic in `core/` is exercised by `scripts/smoke-*.ts`
 * which don't need jsdom and would slow the suite.
 *
 * See `docs/architecture/component-testing.md` for the testing
 * convention.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    // jsdom so React Testing Library can mount components without
    // booting Electron. Conservative default; switch to happy-dom only
    // if startup overhead bites.
    environment: 'jsdom',
    // Explicit imports for testing-library APIs; no auto-globals.
    globals: false,
    setupFiles: [resolve(__dirname, 'vitest.setup.ts')],
    // Co-located test files: `Foo.tsx` next to `Foo.test.tsx`. The
    // glob is config-dir-relative (Vitest resolves relative to the
    // config file, not cwd) so a different CI working dir is fine.
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['node_modules/**', 'out/**', 'dist/**'],
    // Skip the watcher's coverage probe — coverage threshold isn't a
    // gate for this suite, and v8 instrumenter slows cold start.
    coverage: {
      enabled: false,
    },
  },
})
