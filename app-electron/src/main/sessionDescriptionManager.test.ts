import { afterEach, describe, expect, it, vi } from 'vitest'

const appState = vi.hoisted(() => ({
  get: vi.fn<(sessionId: string) => string | undefined>(),
  set: vi.fn<(sessionId: string, description: string) => void>(),
}))

vi.mock('./app-state-store', () => ({
  getSessionDescriptionState: appState.get,
  setSessionDescriptionState: appState.set,
}))

import { SessionDescriptionManager } from './sessionDescriptionManager'

const SESSION_ID = '12345678-1234-1234-1234-123456789012'

afterEach(() => vi.clearAllMocks())

describe('SessionDescriptionManager', () => {
  it('loads a description by canonical session id', () => {
    appState.get.mockReturnValue('Investigating restore behavior')
    expect(SessionDescriptionManager.load(SESSION_ID)).toEqual({
      ok: true,
      description: 'Investigating restore behavior',
    })
    expect(appState.get).toHaveBeenCalledWith(SESSION_ID)
  })

  it('normalizes outer whitespace while preserving internal newlines', () => {
    expect(SessionDescriptionManager.save(SESSION_ID, '  First line\nSecond line  ')).toEqual({
      ok: true,
      description: 'First line\nSecond line',
    })
    expect(appState.set).toHaveBeenCalledWith(SESSION_ID, 'First line\nSecond line')
  })

  it('clears the sparse entry for an empty description', () => {
    expect(SessionDescriptionManager.save(SESSION_ID, '   ')).toEqual({ ok: true, description: '' })
    expect(appState.set).toHaveBeenCalledWith(SESSION_ID, '')
  })

  it('rejects invalid ids, non-string values, and oversized descriptions', () => {
    expect(SessionDescriptionManager.load('../other-session')).toEqual({ ok: false, error: 'invalid session id' })
    expect(SessionDescriptionManager.save(SESSION_ID, 42)).toEqual({ ok: false, error: 'description must be a string' })
    expect(SessionDescriptionManager.save(SESSION_ID, 'x'.repeat(4_001))).toEqual({
      ok: false,
      error: 'description exceeds 4000 characters',
    })
    expect(SessionDescriptionManager.save(SESSION_ID, ' '.repeat(4_001))).toEqual({
      ok: false,
      error: 'description exceeds 4000 characters',
    })
    expect(appState.set).not.toHaveBeenCalled()
  })
})
