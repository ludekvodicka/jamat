import { describe, expect, it } from 'vitest'

import { RemoteControlPeerBackoff } from './remoteControlPeerBackoff'

describe('lib-orchestrator/remoteControl/remoteControlPeerBackoff', () => {
  it('grows exponentially, jitters within bounds and caps at thirty seconds', () => {
    expect(RemoteControlPeerBackoff.delay(0, () => 0)).toBe(400)
    expect(RemoteControlPeerBackoff.delay(0, () => 1)).toBe(600)
    expect(RemoteControlPeerBackoff.delay(3, () => 0.5)).toBe(4_000)
    expect(RemoteControlPeerBackoff.delay(20, () => 1)).toBe(30_000)
  })

  it('rejects an invalid reconnect attempt', () => {
    expect(() => RemoteControlPeerBackoff.delay(-1)).toThrow('non-negative integer')
    expect(() => RemoteControlPeerBackoff.delay(1.5)).toThrow('non-negative integer')
  })
})
