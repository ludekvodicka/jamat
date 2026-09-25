import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ContextCompactionDelivery } from '../../shared/contextCompactionDelivery'
import type { IpcResult } from '../../shared/appClientUiIpc'
import { TerminalInputRegistry } from '../shell/terminalInputRegistry'
import { SessionCompact, type SessionCompactPorts } from './sessionCompact'

describe('app-client-ui/renderer/contextCompaction/sessionCompact', () => {
  let inputs: TerminalInputRegistry
  let written: string[]
  let focuses: number
  let claims: string[]
  let manualNotes: string[]
  let deliveries: string[]
  let errors: string[]
  let claimAnswer: Awaited<ReturnType<SessionCompactPorts['claimAutomatic']>>
  let deliverAnswer: IpcResult<ContextCompactionDelivery>

  beforeEach(() => {
    inputs = new TerminalInputRegistry()
    written = []
    focuses = 0
    claims = []
    manualNotes = []
    deliveries = []
    errors = []
    claimAnswer = { ok: true, value: true }
    deliverAnswer = { ok: true, value: { kind: 'delivered', proof: 'working' } }
  })

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
      deliver: (sessionId) => {
        deliveries.push(sessionId)
        return Promise.resolve(deliverAnswer)
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

  it('runs a manual compact through the verified delivery, with focus, and moves the cooldown', async () => {
    attach()
    const compact = subject()

    expect(compact.manual('s-a')).toBe(true)
    await vi.waitFor(() => expect(deliveries).toEqual(['s-a']))

    expect(written).toEqual([])
    expect(focuses).toBe(1)
    expect(manualNotes).toEqual(['s-a'])
    expect(errors).toEqual([])
  })

  it('claims and delivers an automatic compact without moving focus, and returns the proof', async () => {
    attach()
    const compact = subject()

    expect(await compact.automatic('s-a', () => true)).toEqual({ kind: 'delivered', proof: 'working' })

    expect(claims).toEqual(['s-a'])
    expect(deliveries).toEqual(['s-a'])
    expect(written).toEqual([])
    expect(focuses).toBe(0)
  })

  it('returns and reports a refusal with its stage and reason', async () => {
    attach()
    deliverAnswer = {
      ok: true,
      value: { kind: 'refused', stage: 'ready', reason: 'foreign-draft', detail: 'The composer holds a draft this call does not own' },
    }

    expect(await subject().automatic('s-a', () => true)).toEqual({
      kind: 'refused',
      detail: 'The composer holds a draft this call does not own (ready: foreign-draft)',
    })
    expect(errors).toEqual([
      'auto-compact for session s-a was not delivered: The composer holds a draft this call does not own (ready: foreign-draft)',
    ])
  })

  it('reports a refused manual compact', async () => {
    attach()
    deliverAnswer = {
      ok: true,
      value: { kind: 'refused', stage: 'submit', reason: 'unproven', detail: 'The composer cleared but nothing proves a submit' },
    }

    subject().manual('s-a')

    await vi.waitFor(() => expect(errors).toEqual([
      'compact for session s-a was not delivered: The composer cleared but nothing proves a submit (submit: unproven)',
    ]))
  })

  it('does not claim a session that has no terminal in this renderer', async () => {
    const compact = subject()

    expect(compact.hasTarget('s-a')).toBe(false)
    expect(await compact.automatic('s-a', () => true)).toEqual({ kind: 'unavailable' })

    expect(claims).toEqual([])
    expect(deliveries).toEqual([])
    expect(errors).toEqual([])
  })

  it('does not deliver when another renderer owns the cooldown', async () => {
    attach()
    claimAnswer = { ok: true, value: false }

    expect(await subject().automatic('s-a', () => true)).toEqual({ kind: 'cooldown' })

    expect(deliveries).toEqual([])
    expect(errors).toEqual([])
  })

  it('reports channel and missing-target failures', async () => {
    const compact = subject()
    expect(compact.manual('s-a')).toBe(false)
    attach()
    claimAnswer = { ok: false, error: 'main process is gone' }

    expect(await compact.automatic('s-a', () => true)).toEqual({ kind: 'failed', detail: 'auto-compact cooldown failed: main process is gone' })
    claimAnswer = { ok: true, value: true }
    deliverAnswer = { ok: false, error: 'deliver channel is gone' }
    expect(await compact.automatic('s-a', () => true)).toEqual({ kind: 'failed', detail: 'auto-compact failed: deliver channel is gone' })

    expect(errors).toEqual([
      'compact: no live terminal is attached for session s-a',
      'auto-compact cooldown failed: main process is gone',
      'auto-compact failed: deliver channel is gone',
    ])
  })

  it('does not deliver into a draft started while the cooldown claim is in flight', async () => {
    attach()
    let safe = true
    const pending = subject().automatic('s-a', () => safe)
    safe = false
    expect(await pending).toEqual({ kind: 'cancelled' })
    expect(deliveries).toEqual([])
  })
})
