import type {
  RemoteConnectionsSnapshot,
} from '../../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import type {
  SessionInfo,
  SessionsSnapshot,
} from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { TerminalTarget } from '../../../shared/terminalTarget'
import {
  type FinalizeAsk,
  FinalizeAsks,
  type FinalizeScope,
} from '../../overlays/finalize/finalizeModel'

type FinalizeAwaitFinding =
  | { state: 'unknown-yet' }
  | { state: 'gone' }
  | { state: 'found'; info: SessionInfo; scope: FinalizeScope }

type FinalizeAwaitAction =
  | { kind: 'accepted'; targetKey: string; target: TerminalTarget }
  | { kind: 'settled'; targetKeys: readonly string[] }

/** Looks up one awaited target without turning an unread snapshot into a disappearance. */
export class FinalizeAwait {
  static reduce(
    current: ReadonlyMap<string, TerminalTarget>,
    action: FinalizeAwaitAction,
  ): ReadonlyMap<string, TerminalTarget> {
    if (action.kind === 'accepted')
      return new Map(current).set(action.targetKey, action.target)
    else if (action.kind === 'settled') {
      const next = new Map(current)
      for (const targetKey of action.targetKeys) next.delete(targetKey)
      return next
    } else
      throw new Error(`Unknown finalize await action: ${JSON.stringify(action)}`)
  }

  static findOf(
    target: TerminalTarget,
    snapshot: SessionsSnapshot | null,
    remoteSnapshot: RemoteConnectionsSnapshot | null,
  ): FinalizeAwaitFinding {
    if (target.kind === 'local') {
      if (snapshot === null) return { state: 'unknown-yet' }
      const info = snapshot.sessions.find((session) => session.sessionId === target.sessionId)
      return info === undefined ? { state: 'gone' } : { state: 'found', info, scope: 'local' }
    }
    else if (target.kind === 'remote') {
      if (remoteSnapshot === null) return { state: 'unknown-yet' }
      const endpoint = remoteSnapshot.outbound.find((candidate) =>
        candidate.remoteEndpointId === target.remoteEndpointId)
      if (endpoint === undefined) return { state: 'gone' }
      if (endpoint.status === 'idle'
        || endpoint.status === 'connecting'
        || endpoint.status === 'offline')
        return { state: 'gone' }
      else if (endpoint.status === 'connected') {
        if (endpoint.sessions === null) return { state: 'unknown-yet' }
        const info = endpoint.sessions.sessions.find((session) =>
          session.sessionId === target.sessionId)
        return info === undefined ? { state: 'gone' } : { state: 'found', info, scope: 'remote' }
      }
      else
        throw new Error(`Unknown remote endpoint status: ${JSON.stringify(endpoint.status)}`)
    }
    else
      throw new Error(`Unknown terminal target: ${JSON.stringify(target)}`)
  }

  static askOf(
    target: TerminalTarget,
    snapshot: SessionsSnapshot | null,
    remoteSnapshot: RemoteConnectionsSnapshot | null,
  ): FinalizeAsk | null {
    const found = FinalizeAwait.findOf(target, snapshot, remoteSnapshot)
    if (found.state === 'unknown-yet' || found.state === 'gone') return null
    else if (found.state === 'found') return FinalizeAsks.of(found.info, target, found.scope)
    else
      throw new Error(`Unknown finalize await state: ${JSON.stringify(found)}`)
  }
}
