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
    // The same 30 s the web project takes, and for the same reason it wrote down: these run inside
    // the publish build gate, over a worktree checked out seconds earlier, and on a CI runner
    // several times slower than an idle developer machine. The default five seconds is a budget for
    // a test that only computes, and this project has several that do not - `tokensGate` walks
    // renderer/ off a cold disk, and `appHub` rasterises a tinted icon through Resvg, which the
    // suite mocks Electron but deliberately does not mock.
    //
    // Both were found the hard way rather than guessed: appHub timed out twice on the GitHub runner
    // while every neighbouring case in its file finished inside 22ms, and tokensGate timed out on
    // the first run inside a freshly created gate worktree. Neither is slow here, which is exactly
    // why the default looked adequate for as long as it did.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
