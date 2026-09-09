import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'lib-orchestrator',
    environment: 'node',
    include: ['**/*.test.ts'],
    passWithNoTests: true,
    // 30 s, the same budget app-client-ui's two projects carry, and for the same reason: these run
    // inside the publish build gate over a worktree checked out seconds earlier, and on a CI runner
    // several times slower than an idle machine. Five seconds is a budget for a case that computes;
    // this package is full of cases that do not. `projectScanner` creates 2001 real directories and
    // then walks them, and that one timed out on the public runner at 8717ms while finishing here
    // in a fraction of a second.
    //
    // This is a floor, not a ceiling. A case that needs materially more says so itself, the way the
    // real-git worktree cases already do with their own `timeout: 120_000`.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
