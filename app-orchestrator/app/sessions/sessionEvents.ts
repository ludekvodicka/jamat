import type { SessionManagerDeps } from '../../../lib-orchestrator/sessionManager/sessionManager'
import type { ScriptRunCollapsed } from '../../../lib-orchestrator/clientApi/scriptRunHandOff.types'
import { TerminalTargetCodec } from '../../../lib-orchestrator/clientApi/terminalTarget'
import { ErrorText } from '../../../lib-orchestrator/shared/errorText'

export interface SessionEventsPorts {
  refreshCommits(): void
  wakeSnapins(): void
  noticeWaits(): void
  attentionSeen(): void
  publishSessions(): void
  publishControl(): void
  publishInbound(): void
  publishActivity(): void
  titleOf(sessionId: string): string | null
  scriptRunCollapsed: ScriptRunCollapsed
  report(message: string): void
}

export class SessionEvents {
  private readonly ports: SessionEventsPorts
  constructor(ports: SessionEventsPorts) { this.ports = ports }

  changed(): void {
    try { this.ports.refreshCommits() }
    catch (error) { this.ports.report(`Commit review marks could not be refreshed: ${ErrorText.of(error)}`) }
    try { this.ports.wakeSnapins() }
    catch (error) { this.ports.report(`Snap-ins wake failed: ${ErrorText.of(error)}`) }
    this.ports.noticeWaits()
    this.ports.attentionSeen()
    this.ports.publishSessions()
    this.ports.publishControl()
    this.ports.publishInbound()
    this.ports.publishActivity()
  }

  scriptCollapsed(event: Parameters<NonNullable<SessionManagerDeps['onScriptCollapsed']>>[0]): void {
    const runKey = TerminalTargetCodec.key({ kind: 'local', sessionId: event.runId })
    if (event.handoff === 'parent-tab') {
      const title = this.ports.titleOf(event.handoffTo)
      this.ports.scriptRunCollapsed(runKey,
        title === null ? null : { target: { kind: 'local', sessionId: event.handoffTo }, title })
    } else if (event.handoff === 'close') this.ports.scriptRunCollapsed(runKey, null)
    else throw new Error(`Unknown script handoff: ${JSON.stringify(event.handoff)}`)
  }
}
