import { describe, expect, it } from 'vitest'

import { WorktreeSetupIntentStore } from './worktreeSetupIntentStore'

describe('app-client-ui/renderer/overlays/configuration/worktreeSetupIntentStore', () => {
  const intentConst = { projectName: 'AppJamatV3', projectPath: 'Q:/x/AppJamatV3' }

  it('has nothing to hand over until somebody asks for a project', () => {
    expect(new WorktreeSetupIntentStore().consume()).toBeNull()
  })

  /* One shot, which is the whole reason it is a store and not a selection: a settings card opened
     later from Ctrl+, must not still be editing what somebody right-clicked last week. */
  it('hands an intent over exactly once', () => {
    const store = new WorktreeSetupIntentStore()
    store.write(intentConst)
    expect(store.consume()).toEqual(intentConst)
    expect(store.consume()).toBeNull()
  })

  it('keeps the second of two clicks, because that is the one the user meant', () => {
    const store = new WorktreeSetupIntentStore()
    store.write(intentConst)
    store.write({ projectName: 'MirabiaApp', projectPath: 'Q:/x/MirabiaApp' })
    expect(store.consume()?.projectName).toBe('MirabiaApp')
  })
})
