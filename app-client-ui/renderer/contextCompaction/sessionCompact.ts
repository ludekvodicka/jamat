import type { IpcResult } from '../../shared/appClientUiIpc'
import type { ContextCompactionCooldown } from '../../shared/contextCompactionCooldown'
import type { ContextCompactionDelivery } from '../../shared/contextCompactionDelivery'
import { ErrorText } from '../../shared/errorText'
import type { TerminalInputRegistry } from '../shell/terminalInputRegistry'

export interface SessionCompactPorts {
  claimAutomatic(sessionId: string): Promise<IpcResult<boolean>>
  noteManual(sessionId: string): Promise<IpcResult<void>>
  cooldown(sessionId: string): Promise<IpcResult<ContextCompactionCooldown | null>>
  deliver(sessionId: string): Promise<IpcResult<ContextCompactionDelivery>>
  reportError(message: string): void
}

export type SessionCompactResult =
  | { kind: 'delivered'; proof: Extract<ContextCompactionDelivery, { kind: 'delivered' }>['proof'] }
  | { kind: 'refused'; detail: string }
  | { kind: 'cooldown' }
  | { kind: 'unavailable' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; detail: string }

/**
 * `/compact` goes through the main process's verified `terminal.deliver`, not through the panel:
 * that loop waits for an empty composer, sees the typed command and proves the submit. The panel
 * registry is still the gate - only a session this window shows as a writable terminal is a target.
 */
export class SessionCompact {
  private readonly inputs: TerminalInputRegistry
  private readonly ports: SessionCompactPorts

  constructor(inputs: TerminalInputRegistry, ports: SessionCompactPorts) {
    this.inputs = inputs
    this.ports = ports
  }

  hasTarget(sessionId: string): boolean {
    return this.inputs.has(sessionId)
  }

  async cooldown(sessionId: string): Promise<ContextCompactionCooldown | null> {
    const answer = await this.ports.cooldown(sessionId)
    if (!answer.ok) throw new Error(answer.error)
    return answer.value
  }

  manual(sessionId: string): boolean {
    if (!this.inputs.focus(sessionId)) {
      this.reportNoTarget(sessionId)
      return false
    }
    void this.runManual(sessionId)
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
    } catch (error) {
      return this.failed(`auto-compact cooldown failed: ${ErrorText.of(error)}`)
    }
    return this.deliver(sessionId, 'auto-compact')
  }

  private async runManual(sessionId: string): Promise<void> {
    await this.noteManual(sessionId)
    await this.deliver(sessionId, 'compact')
  }

  private async deliver(sessionId: string, label: string): Promise<SessionCompactResult> {
    try {
      const answer = await this.ports.deliver(sessionId)
      if (!answer.ok) return this.failed(`${label} failed: ${answer.error}`)
      const delivery = answer.value
      if (delivery.kind === 'delivered') return { kind: 'delivered', proof: delivery.proof }
      else if (delivery.kind === 'refused') {
        const detail = `${delivery.detail} (${delivery.stage}: ${delivery.reason})`
        this.ports.reportError(`${label} for session ${sessionId} was not delivered: ${detail}`)
        return { kind: 'refused', detail }
      } else
        throw new Error(`Unknown compact delivery: ${JSON.stringify(delivery)}`)
    } catch (error) {
      return this.failed(`${label} failed: ${ErrorText.of(error)}`)
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
