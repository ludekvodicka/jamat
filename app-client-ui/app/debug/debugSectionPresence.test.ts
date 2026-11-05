import { describe, expect, it } from 'vitest'

import { DebugSectionPresence } from './debugSectionPresence'

describe('app-client-ui/app/debug/debugSectionPresence', () => {
  it('keeps the host section when the old window reports null after the new window took the tab', () => {
    const published: (string | null)[] = []
    const presence = new DebugSectionPresence((section) => published.push(section))
    presence.report('before', 'host')
    presence.report('after', 'host')
    presence.report('before', null)
    expect(published).toEqual(['host'])
  })

  it('forgets a caller that reloads or closes without a final report', () => {
    const published: (string | null)[] = []
    const presence = new DebugSectionPresence((section) => published.push(section))
    presence.report('reloaded', 'host')
    presence.forget('reloaded')
    presence.report('closed', 'rate')
    presence.forget('closed')
    expect(published).toEqual(['host', null, 'rate', null])
  })
})
