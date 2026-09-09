import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TerminalInputRegistry } from '../shell/terminalInputRegistry'
import { SessionCompact, type SessionCompactPorts } from './sessionCompact'

describe('app-client-ui/renderer/contextCompaction/sessionCompact', () => {
  let inputs: TerminalInputRegistry
  let written: string[]
  let focuses: number
  let claims: string[]
  let manualNotes: string[]
  let errors: string[]
  let claimAnswer: Awaited<ReturnType<SessionCompactPorts['claimAutomatic']>>

  beforeEach(() => {
    vi.useFakeTimers()
    inputs = new TerminalInputRegistry()
    written = []
    focuses = 0
    claims = []
    manualNotes = []
    errors = []
    claimAnswer = { ok: true, value: true }
  })

  afterEach(() => vi.useRealTimers())

  function subject(): SessionCompact {
    return new SessionCompact(inputs, {
      claimAutomatic: (sessionId) => {
        claims.push(sessionId)
        return Promise.resolve(claimAnswer)
      },
      cooldown: () => Promise.resolve({ ok: true, value: null }),
      noteManual: (sessionId) => {
        manualNotes.push(sessionId)
        return Promise.resolve({ ok: true, value: undefined })
      },
      reportError: (message) => errors.push(message),
    })
  }

  function attach(sessionId = 's-a'): void {
    inputs.register(sessionId, {
      writable: () => true,
      write: (data) => {
        written.push(data)
        return true
      },
      focus: () => { focuses += 1 },
    })
  }

  it('runs a manual compact with focus and moves the cooldown', async () => {
    attach()
    const compact = subject()

    expect(compact.manual('s-a')).toBe(true)
    await vi.runAllTimersAsync()

    expect(written).toEqual(['/compact', '\r'])
    expect(focuses).toBe(1)
    expect(manualNotes).toEqual(['s-a'])
  })

  it('claims and runs an automatic compact without moving focus', async () => {
    attach()
    const compact = subject()

    expect(await compact.automatic('s-a', () => true)).toEqual({ kind: 'sent' })
    await vi.runAllTimersAsync()

    expect(claims).toEqual(['s-a'])
    expect(written).toEqual(['/compact', '\r'])
    expect(focuses).toBe(0)
  })

  it('does not claim a session that has no terminal in this renderer', async () => {
    const compact = subject()

    expect(compact.hasTarget('s-a')).toBe(false)
    expect(await compact.automatic('s-a', () => true)).toEqual({ kind: 'unavailable' })

    expect(claims).toEqual([])
    expect(errors).toEqual([])
  })

  it('does not write when another renderer owns the cooldown', async () => {
    attach()
    claimAnswer = { ok: true, value: false }

    expect(await subject().automatic('s-a', () => true)).toEqual({ kind: 'cooldown' })

    expect(written).toEqual([])
    expect(errors).toEqual([])
  })

  it('reports channel and missing-target failures', async () => {
    const compact = subject()
    expect(compact.manual('s-a')).toBe(false)
    attach()
    claimAnswer = { ok: false, error: 'main process is gone' }

    expect(await compact.automatic('s-a', () => true)).toEqual({ kind: 'failed', detail: 'auto-compact cooldown failed: main process is gone' })

    expect(errors).toEqual([
      'compact: no live terminal is attached for session s-a',
      'auto-compact cooldown failed: main process is gone',
    ])
  })

  it('does not submit into a draft started while the cooldown claim is in flight', async () => {
    attach()
    let safe = true
    const pending = subject().automatic('s-a', () => safe)
    safe = false
    expect(await pending).toEqual({ kind: 'cancelled' })
    await vi.advanceTimersByTimeAsync(100)
    expect(written).toEqual([])
  })
})
