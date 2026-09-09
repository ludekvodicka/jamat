import type { IpcResult } from '../../shared/appClientUiIpc'
import type { ContextCompactionCooldown } from '../../shared/contextCompactionCooldown'
import { ErrorText } from '../../shared/errorText'
import type { TerminalInputRegistry } from '../shell/terminalInputRegistry'

export interface SessionCompactPorts {
  claimAutomatic(sessionId: string): Promise<IpcResult<boolean>>
  noteManual(sessionId: string): Promise<IpcResult<void>>
  cooldown(sessionId: string): Promise<IpcResult<ContextCompactionCooldown | null>>
  reportError(message: string): void
}

export type SessionCompactResult =
  | { kind: 'sent' }
  | { kind: 'cooldown' }
  | { kind: 'unavailable' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; detail: string }

export class SessionCompact {
  private static readonly commandConst = '/compact'

  constructor(
    private readonly inputs: TerminalInputRegistry,
    private readonly ports: SessionCompactPorts,
  ) {}

  hasTarget(sessionId: string): boolean {
    return this.inputs.has(sessionId)
  }

  async cooldown(sessionId: string): Promise<ContextCompactionCooldown | null> {
    const answer = await this.ports.cooldown(sessionId)
    if (!answer.ok) throw new Error(answer.error)
    return answer.value
  }

  manual(sessionId: string): boolean {
    if (!this.inputs.submit(sessionId, SessionCompact.commandConst)) {
      this.reportNoTarget(sessionId)
      return false
    }
    void this.noteManual(sessionId)
    return true
  }

  async automatic(sessionId: string, canSubmit: () => boolean): Promise<SessionCompactResult> {
    if (!this.inputs.has(sessionId)) return { kind: 'unavailable' }
    try {
      const claimed = await this.ports.claimAutomatic(sessionId)
      if (!claimed.ok) return this.failed(`auto-compact cooldown failed: ${claimed.error}`)
      if (!claimed.value) return { kind: 'cooldown' }
      // Claiming crosses IPC; the person may start typing before it answers.
      if (!canSubmit()) return { kind: 'cancelled' }
      if (this.inputs.submit(sessionId, SessionCompact.commandConst, { focus: false }))
        return { kind: 'sent' }
      this.reportNoTarget(sessionId)
      return { kind: 'unavailable' }
    } catch (error) {
      return this.failed(`auto-compact cooldown failed: ${ErrorText.of(error)}`)
    }
  }

  private failed(detail: string): SessionCompactResult {
    this.ports.reportError(detail)
    return { kind: 'failed', detail }
  }

  private async noteManual(sessionId: string): Promise<void> {
    try {
      const noted = await this.ports.noteManual(sessionId)
      if (!noted.ok)
        this.ports.reportError(`compact cooldown failed: ${noted.error}`)
    } catch (error) {
      this.ports.reportError(`compact cooldown failed: ${ErrorText.of(error)}`)
    }
  }

  private reportNoTarget(sessionId: string): void {
    this.ports.reportError(`compact: no live terminal is attached for session ${sessionId}`)
  }
}
