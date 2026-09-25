import { describe, expect, it } from 'vitest'

import { TerminalTargetCodec } from './terminalTarget'

describe('app-client-ui/shared/terminalTarget', () => {
  it('keeps existing local params and panel identity unchanged', () => {
    expect(TerminalTargetCodec.params({ kind: 'local', sessionId: 'session-a' }))
      .toEqual({ sessionId: 'session-a' })
    expect(TerminalTargetCodec.read({ sessionId: 'session-a' }))
      .toEqual({ target: { kind: 'local', sessionId: 'session-a' } })
    expect(TerminalTargetCodec.key({ kind: 'local', sessionId: 'session-a' })).toBe('session-a')
  })

  it('includes the stable endpoint in remote params and identity', () => {
    const target = { kind: 'remote' as const, remoteEndpointId: 'endpoint-a', sessionId: 'same' }
    expect(TerminalTargetCodec.read(TerminalTargetCodec.params(target))).toEqual({ target })
    expect(TerminalTargetCodec.key(target)).not.toBe(
      TerminalTargetCodec.key({ ...target, remoteEndpointId: 'endpoint-b' }),
    )
  })

  it('refuses malformed parameters', () => {
    expect(TerminalTargetCodec.read({ target: { kind: 'remote', sessionId: 's' } })).toBeNull()
    expect(TerminalTargetCodec.read({})).toBeNull()
  })

  /*
   * A window saved before 2026-09-23 still carries the key a plain tab was marked with. The panel
   * is an ordinary terminal now, and refusing its parameters would leave it out of the restored
   * window without a word.
   */
  it('reads a terminal saved as a plain tab as the session it draws', () => {
    expect(TerminalTargetCodec.read({ sessionId: 'session-a', presentation: 'tab' }))
      .toEqual({ target: { kind: 'local', sessionId: 'session-a' } })
  })
})
