import type { RemoteControlStepResult } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { RemoteControlRegistry } from '../../../lib-orchestrator/remoteControl/remoteControlRegistry'
import { RemoteControlConst } from '../../../lib-orchestrator/remoteControl/remoteControlProtocol'
import type { SessionViewOperationMap } from '../../../lib-orchestrator/remoteControl/remoteSessionApi.types'
import type { SessionsSnapshot } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { RemoteSessionInteraction } from './remoteSessionViews'

export class RemoteSessionActions {
  private readonly read: () => SessionsSnapshot
  private readonly registry: Pick<RemoteControlRegistry, 'execute'>

  constructor(read: () => SessionsSnapshot, registry: Pick<RemoteControlRegistry, 'execute'>) {
    this.read = read
    this.registry = registry
  }

  async press(view: RemoteSessionInteraction, request: SessionViewOperationMap['actions.press']['request'], operationId: string): Promise<RemoteControlStepResult<null>> {
    const snapshot = this.read()
    if (snapshot.revision !== request.revision)
      return { ok: false, error: { code: 'conflict', detail: 'Session actions changed. Read the current action before pressing again.' } }
    const info = snapshot.sessions.find((session) => session.sessionId === view.sessionId)
    if ('kind' in request) {
      if (!info) return { ok: false, error: { code: 'not-found', detail: 'Session no longer exists' } }
      if (request.kind === 'clear-history')
        return this.execute(view, 'sessions.clearActions', { session: { kind: 'sessionId', sessionId: view.sessionId } }, operationId)
      else if (request.kind === 'resolve-conflict') {
        const entry = info.svnAction?.conflicts?.entries.find((entry) => entry.path === request.path
          && (request.conflictKind === undefined || entry.kind === request.conflictKind) && entry.state !== 'settled')
        if (!entry || !entry.options.some((option) => option.id === request.option) || entry.state === 'rule')
          return { ok: false, error: { code: 'conflict', detail: 'Conflict options changed. Read the current source conflicts again.' } }
        return this.execute(view, 'sessions.resolveConflict', { session: { kind: 'sessionId', sessionId: view.sessionId },
          path: request.path, ...(request.conflictKind === undefined ? {} : { kind: request.conflictKind }), option: request.option,
          ...(request.confirm ? { confirm: true } : {}) }, operationId)
      } else throw new Error(`Unknown session command: ${JSON.stringify(request satisfies never)}`)
    }
    const sections = info?.actions?.sections ?? (info?.workflow ? [info.workflow] : [])
    const section = sections.find((candidate) => candidate.workflowId === request.workflowId)
    const action = section?.actions.find((candidate) => candidate.id === request.actionId)
    if (!action) return { ok: false, error: { code: 'conflict', detail: 'This session action is no longer available.' } }
    // A commit selection needs the source review's revision/claim contract, never a raw action payload.
    if (request.commit || action.requiresCommit)
      return { ok: false, error: { code: 'unavailable', detail: 'Open the source commit review to approve this selection.' } }
    if (action.id === 'later') return { ok: true, value: null }
    const command = action.command
    if (command === undefined) return { ok: false, error: { code: 'unavailable', detail: 'This action requires navigation on the source computer.' } }
    return this.execute(view, command.operation, { session: { kind: 'sessionId', sessionId: command.sessionId ?? view.sessionId },
      ...request.agreement, ...command.body }, operationId)
  }

  private async execute(view: RemoteSessionInteraction, operation: string, body: object, operationId: string): Promise<RemoteControlStepResult<null>> {
    const result = await this.registry.execute({ protocol: RemoteControlConst.protocol, requestId: operationId, operationId, operation, body }, {
      callerId: JSON.stringify(['session-view', view.peerId, view.sessionId]),
      callerKind: 'window', allowedOperations: [operation],
    })
    return result.ok ? { ok: true, value: null } : { ok: false, error: result.error }
  }
}
