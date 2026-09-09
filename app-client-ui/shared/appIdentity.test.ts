import { describe, expect, it } from 'vitest'

import { AppIdentity } from './appIdentity'

describe('app-client-ui/shared/appIdentity', () => {
  // Both processes write this title and the renderer's write is the one that lands, so the two
  // formatting it differently would show a name that changes as the window finishes loading.
  it('wears the application name alone when the window has no name of its own', () => {
    expect(AppIdentity.titleOf(null)).toBe('Jamat V3')
  })

  it('puts a named window after the application name', () => {
    expect(AppIdentity.titleOf('Review')).toBe('Jamat V3 - Review')
  })

  it('names the debug window from the same word', () => {
    expect(AppIdentity.debugNameConst).toBe('Jamat V3 Debug')
  })
})
