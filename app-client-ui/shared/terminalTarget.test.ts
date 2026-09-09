import { describe, expect, it } from 'vitest'

import { TerminalTargetCodec } from './terminalTarget'

describe('app-client-ui/shared/terminalTarget', () => {
  it('keeps existing local params and panel identity unchanged', () => {
    expect(TerminalTargetCodec.params({ kind: 'local', sessionId: 'session-a' }))
      .toEqual({ sessionId: 'session-a' })
    expect(TerminalTargetCodec.read({ sessionId: 'session-a' })).toEqual({
      target: { kind: 'local', sessionId: 'session-a' },
      presentation: 'session',
    })
    expect(TerminalTargetCodec.key({ kind: 'local', sessionId: 'session-a' })).toBe('session-a')
  })

  it('includes the stable endpoint in remote params and identity', () => {
    const target = { kind: 'remote' as const, remoteEndpointId: 'endpoint-a', sessionId: 'same' }
    expect(TerminalTargetCodec.read(TerminalTargetCodec.params(target))).toEqual({
      target,
      presentation: 'session',
    })
    expect(TerminalTargetCodec.key(target)).not.toBe(
      TerminalTargetCodec.key({ ...target, remoteEndpointId: 'endpoint-b' }),
    )
  })

  it('refuses malformed and remote plain-tab parameters', () => {
    expect(TerminalTargetCodec.read({ target: { kind: 'remote', sessionId: 's' } })).toBeNull()
    expect(() => TerminalTargetCodec.params(
      { kind: 'remote', remoteEndpointId: 'e', sessionId: 's' },
      'tab',
    )).toThrow('plain-tab')
  })
})
