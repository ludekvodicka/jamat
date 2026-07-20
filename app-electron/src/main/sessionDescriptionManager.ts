import { SESSION_ID_RE } from '../../../core/types/contracts.js'
import type { SessionDescriptionResult } from '../../../core/types/ipc-contracts.js'
import { getSessionDescriptionState, setSessionDescriptionState } from './app-state-store'

export class SessionDescriptionManager {
  private static readonly maxLength = 4_000

  static load(sessionId: unknown): SessionDescriptionResult {
    const error = SessionDescriptionManager.validateSessionId(sessionId)
    if (error) return { ok: false, error }
    const description = getSessionDescriptionState(sessionId as string) ?? ''
    if (description.length > SessionDescriptionManager.maxLength)
      return { ok: false, error: `description exceeds ${SessionDescriptionManager.maxLength} characters` }
    return { ok: true, description }
  }

  static save(sessionId: unknown, description: unknown): SessionDescriptionResult {
    const sessionError = SessionDescriptionManager.validateSessionId(sessionId)
    if (sessionError) return { ok: false, error: sessionError }
    if (typeof description !== 'string') return { ok: false, error: 'description must be a string' }
    if (description.length > SessionDescriptionManager.maxLength)
      return { ok: false, error: `description exceeds ${SessionDescriptionManager.maxLength} characters` }
    const normalized = description.trim()
    setSessionDescriptionState(sessionId as string, normalized)
    return { ok: true, description: normalized }
  }

  private static validateSessionId(sessionId: unknown): string | null {
    if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return 'invalid session id'
    return null
  }
}
