import { describe, expect, it } from 'vitest'

import { LauncherIntentStore } from './launcherIntentStore'

describe('app-client-ui/renderer/overlays/launcher/launcherIntentStore', () => {
  it('holds nothing until something writes an intent', () => {
    expect(new LauncherIntentStore().consume()).toBeNull()
  })

  it('hands the intent out once and nothing after that', () => {
    const store = new LauncherIntentStore()
    store.set({})

    expect(store.consume()).toEqual({})
    // The launcher a saved layout or a later open brings back must not still act on a keystroke
    // from before: this is what makes it start from its own beginning instead.
    expect(store.consume()).toBeNull()
  })

  it('keeps the project a caller already knew', () => {
    const store = new LauncherIntentStore()
    store.set({
      project: {
        kind: 'project',
        categoryId: 'nodejs',
        projectName: 'AppJamatV3',
        projectPath: 'C:/Projects/NodeJs/AppJamatV3',
      },
    })

    expect(store.consume()?.project?.projectName).toBe('AppJamatV3')
  })

  it('answers with the last intent written, not the first', () => {
    const store = new LauncherIntentStore()
    store.set({
      project: {
        kind: 'project',
        categoryId: 'nodejs',
        projectName: 'AppJamatV3',
        projectPath: 'C:/Projects/NodeJs/AppJamatV3',
      },
    })
    store.set({})

    expect(store.consume()).toEqual({})
  })
})
