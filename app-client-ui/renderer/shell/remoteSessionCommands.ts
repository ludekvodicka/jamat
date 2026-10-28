import type { RemoteConnectionsSnapshot } from '../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import type { SessionInfo, SessionDetailsUpdate, SessionDetailsSaved, SessionsOpResult } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { IpcResult } from '../../shared/appClientUiIpc'
import type { CommandId } from '../../shared/commands'
import type { RemoteSessionCommand } from '../../shared/remoteSessionCommand'
import { TerminalTargetCodec, type TerminalTarget } from '../../shared/terminalTarget'
import { AppClientUiReport } from '../../shared/appClientUiReport'
import { SessionCommandRun } from '../commands/sessionCommandRun'
import type { LauncherIntent } from '../overlays/launcher/launcherIntentStore'
import { SessionFolder } from '../sessions/sessionFolder'
import { SessionOperations } from './sessionOperations'
import { RemoteReviewResults } from '../../shared/remoteReviewResults'
import { RemoteContentRead } from '../../shared/remoteContentRead'

type RemoteTarget = Extract<TerminalTarget, { kind: 'remote' }>
interface Ports {
  active(): TerminalTarget | null
  snapshot(): RemoteConnectionsSnapshot | null
  details(target: RemoteTarget, session: SessionInfo): void
  launch(intent: LauncherIntent): void
  open(target: RemoteTarget, title: string): Promise<unknown>
  folder(target: RemoteTarget, path: string): void
  compact(target: RemoteTarget): void
  review(target: RemoteTarget, vcs: 'svn' | 'git'): Promise<void>
}

export class RemoteSessionCommands {
  private readonly ports: Ports
  private readonly pending = new Map<string, string>()

  constructor(ports: Ports) { this.ports = ports }

  dispatch(id: CommandId, arg: unknown): boolean {
    if (!SessionCommandRun.targets(id) && id !== 'session.setColor') return false
    const named = typeof arg === 'object' && arg !== null ? arg as { sessionId?: string; remoteEndpointId?: string } : undefined
    const target = named?.remoteEndpointId && named.sessionId
      ? { kind: 'remote' as const, remoteEndpointId: named.remoteEndpointId, sessionId: named.sessionId }
      : named?.sessionId ? null : this.ports.active()
    if (target?.kind !== 'remote') return false
    void this.run(id, target, arg).catch((error: unknown) => AppClientUiReport.error(String(error)))
    return true
  }

  private async run(id: CommandId, target: RemoteTarget, arg: unknown): Promise<void> {
    if (id === 'session.copyReference') { await SessionOperations.copySessionReference(target, target.remoteEndpointId); return }
    const endpoint = this.ports.snapshot()?.outbound.find((entry) => entry.remoteEndpointId === target.remoteEndpointId)
    const info = endpoint?.sessions?.sessions.find((entry) => entry.sessionId === target.sessionId)
    if (endpoint?.status !== 'connected' || !info) throw new Error('The source session is disconnected or unavailable')
    if (['session.details', 'session.setColor', 'session.fork', 'session.restart', 'session.commitSvn', 'session.commitGit'].includes(id)
      && !endpoint.workspaceCapabilities?.includes('session-workspace.commands'))
      throw new Error(`${endpoint.displayName} does not support these session commands; update that computer first`)
    const session = { kind: 'sessionId' as const, sessionId: target.sessionId }
    switch (id) {
      case 'session.details': this.ports.details(target, await RemoteSessionCommands.readSession(target)); return
      case 'session.setColor': {
        const color = (arg as { color: SessionInfo['color'] }).color ?? null
        await this.command(target, { operation: 'sessions.color', operationId: '', body: { session, color } }); return
      }
      case 'session.newBeside':
      case 'session.newInClaude':
      case 'session.newInCodex': {
        const path = SessionFolder.ofSession(info)
        if (!path) throw new Error('This source session has no project directory')
        const project = info.project
        const binding = project.kind === 'project' ? { mode: 'project' as const, categoryId: project.categoryId, projectName: project.projectName, projectPath: project.projectPath }
          : { mode: 'adHoc' as const, path }
        const agentId = id === 'session.newInClaude' ? 'claude' : id === 'session.newInCodex' ? 'codex' : info.agent?.agentId
        this.ports.launch({ purpose: 'remote', remote: { remoteEndpointId: target.remoteEndpointId, displayName: endpoint.displayName },
          prefill: { binding, name: info.titleParts.name, ...(agentId ? { agentId } : {}) } }); return
      }
      case 'session.fork': {
        const value = await this.command(target, { operation: 'sessions.fork', operationId: '', body: { session } })
        if (!('sessionId' in value) || !('tabTitle' in value) || typeof value.sessionId !== 'string' || typeof value.tabTitle !== 'string')
          throw new Error('The source returned an unreadable fork result')
        const fork = { ...target, sessionId: value.sessionId }
        const selected = await window.appClient.remote.selectSession(fork.remoteEndpointId, fork.sessionId)
        if (!selected.ok || !selected.value.ok) throw new Error(!selected.ok ? selected.error : !selected.value.ok ? selected.value.error.detail : 'The fork could not be selected')
        await this.ports.open(fork, value.tabTitle); return
      }
      case 'session.resume':
        await this.command(target, { operation: 'sessions.reopen', operationId: '', body: { session } })
        await this.ports.open(target, info.tabTitle); return
      case 'session.restart': {
        if (info.life === 'live') {
          const confirmed = await window.appClient.dialog.confirm(`Restart ${info.title} on ${endpoint.displayName}?`, 'The running process on that computer will stop and its conversation will resume.')
          if (!confirmed.ok || !confirmed.value) return
        }
        await this.command(target, { operation: 'sessions.restart', operationId: '', body: { session } })
        await window.appClient.tabs.publishTerminalRestarted(TerminalTargetCodec.key(target)); return
      }
      case 'session.compact': this.ports.compact(target); return
      case 'session.showActions': {
        const result = await window.appClient.tabs.openSessionActions(target)
        if (!result.ok) throw new Error(result.error)
        return
      }
      case 'session.commitSvn': await this.ports.review(target, 'svn'); return
      case 'session.commitGit': await this.ports.review(target, 'git'); return
      case 'tab.openProjectFolder': {
        const path = SessionFolder.ofSession(info)
        if (!path) throw new Error('This source session has no project directory')
        this.ports.folder(target, path); return
      }
      case 'tab.copyProjectFolder': {
        const path = SessionFolder.ofSession(info)
        if (path) await SessionOperations.copyPath(path)
        return
      }
      case 'session.openInVsCode': throw new Error(`Open VS Code on ${endpoint.displayName}; native editor windows are local to that computer`)
      default: throw new Error(`Unsupported source session command: ${id}`)
    }
  }

  private async command(target: RemoteTarget, command: RemoteSessionCommand) {
    const key = JSON.stringify([target, command.operation, command.body])
    const operationId = this.pending.get(key) ?? crypto.randomUUID()
    this.pending.set(key, operationId)
    const answer = await window.appClient.remote.sessionCommand(target.remoteEndpointId, { ...command, operationId })
    if (!answer.ok) throw new Error(`${answer.error}. Retry keeps the same operation identity.`)
    if (!answer.value.ok) {
      if (['invalid-request', 'protocol-mismatch', 'forbidden', 'not-found', 'conflict'].includes(answer.value.error.code)) this.pending.delete(key)
      throw new Error(answer.value.error.detail)
    }
    this.pending.delete(key)
    return answer.value.value
  }

  static async saveDetails(endpointId: string, sessionId: string, update: SessionDetailsUpdate): Promise<IpcResult<SessionsOpResult<SessionDetailsSaved>>> {
    const answer = await window.appClient.remote.sessionCommand(endpointId, { operation: 'sessions.setDetails', operationId: crypto.randomUUID(), body: { session: { kind: 'sessionId', sessionId }, update } })
    if (!answer.ok) return answer
    if (!answer.value.ok) return { ok: false, error: answer.value.error.detail }
    const value = answer.value.value
    if (!('titleChanged' in value) || typeof value.titleChanged !== 'boolean' || !('notifyAgent' in value)
      || value.notifyAgent !== null && (typeof value.notifyAgent !== 'object' || !('text' in value.notifyAgent) || typeof value.notifyAgent.text !== 'string'))
      return { ok: false, error: 'The source returned an unreadable details result' }
    return { ok: true, value: { ok: true, value: { titleChanged: value.titleChanged, notifyAgent: value.notifyAgent } } }
  }

  private static async readSession(target: RemoteTarget): Promise<SessionInfo> {
    const bridge = window.appClient.remote
    const selected = await bridge.selectSession(target.remoteEndpointId, target.sessionId)
    if (!selected.ok || !selected.value.ok) throw new Error(!selected.ok ? selected.error : !selected.value.ok ? selected.value.error.detail : 'Source session unavailable')
    const opened = await bridge.openView(target.remoteEndpointId, target.sessionId)
    if (!opened.ok || !opened.value.ok) throw new Error(!opened.ok ? opened.error : !opened.value.ok ? opened.value.error.detail : 'Source view unavailable')
    const viewId = opened.value.value.viewId
    try {
      const answer = await bridge.readView(target.remoteEndpointId, viewId)
      if (!answer.ok || !answer.value.ok) throw new Error(!answer.ok ? answer.error : !answer.value.ok ? answer.value.error.detail : 'Source details unavailable')
      if (answer.value.value.session.sessionId !== target.sessionId) throw new Error('Source details belong to another session')
      return answer.value.value.session
    } finally { await bridge.closeView(target.remoteEndpointId, viewId) }
  }

  static async openReview(target: RemoteTarget, vcs: 'svn' | 'git'): Promise<void> {
    const bridge = window.appClient.remote
    const opened = await bridge.openView(target.remoteEndpointId, target.sessionId)
    if (!opened.ok || !opened.value.ok) throw new Error(!opened.ok ? opened.error : !opened.value.ok ? opened.value.error.detail : 'The source view is unavailable')
    const viewId = opened.value.value.viewId
    try {
      const first = await bridge.requestReviews(target.remoteEndpointId, viewId, { kind: 'create', vcs, openId: crypto.randomUUID() })
      if (!first.ok || !first.value.ok) throw new Error(!first.ok ? first.error : !first.value.ok ? first.value.error.detail : 'The source review is unavailable')
      const bytes = await RemoteContentRead.collect(first.value.value, async (cursor) => {
        const page = await bridge.readReviewPage(target.remoteEndpointId, viewId, cursor)
        if (!page.ok || !page.value.ok) throw new Error(!page.ok ? page.error : !page.value.ok ? page.value.error.detail : 'Source review transfer failed')
        return page.value.value
      })
      const result: unknown = RemoteReviewResults.parse({ kind: 'create', vcs, openId: 'validated' }, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), target.sessionId)
      if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true)
        throw new Error(result && typeof result === 'object' && 'detail' in result ? String(result.detail) : 'The source could not open its review')
    } finally { await bridge.closeView(target.remoteEndpointId, viewId) }
  }
}
