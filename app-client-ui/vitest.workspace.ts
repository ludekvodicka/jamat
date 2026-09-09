import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Runner-level on purpose: a project-level flag is ignored when the runner is this file.
    // The entry points and the assembly they run (index, appContext) legitimately have no tests
    // of their own: what they compose is covered, and the boot itself is smoke:ui.
    //
    // The preload was on that list until it was shown not to belong there. It is BUILT from the
    // contract's channel table now, so no member has code of its own - but the table is still one
    // pairing per member, and two channels of the same signature are indistinguishable to the
    // compiler: `sessions.reopen` bound to `sessions:remove` passed typecheck, every suite and
    // smoke:ui. `preload/index.test.ts` is the gate over that table; it is in the node project's
    // include.
    passWithNoTests: true,
    projects: ['./vitest.node.config.ts', './vitest.web.config.ts'],
  },
})
