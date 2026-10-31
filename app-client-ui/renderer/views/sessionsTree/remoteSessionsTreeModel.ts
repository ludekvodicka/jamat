import type { RemoteTaskListing } from '../../../../lib-orchestrator/remoteControl/remoteTaskApi.types'
import { SessionsGroupsState } from '../../../shared/sessionsGroupsState'
import { TerminalTargetCodec } from '../../../shared/terminalTarget'
import type {
  RemoteConnectionsSnapshot,
  RemoteInboundConnectionDto,
  RemoteOutboundEndpointDto,
} from '../../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import type { SessionInfo, SessionsSnapshot } from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import {
  SessionsTreeModel,
  type TreeResult,
  type TreeViewState,
} from './sessionsTreeModel'

export interface RemoteSessionsEndpointTree {
  id: string
  remoteEndpointId: string
  label: string
  status: RemoteOutboundEndpointDto['status'] | 'connected'
  tree: TreeResult
}

export interface RemoteSessionsComputerTree {
  id: string
  remoteComputerId: string
  label: string
  endpoints: readonly RemoteSessionsEndpointTree[]
}

export interface RemoteSessionsSections {
  outbound: readonly RemoteSessionsComputerTree[]
  inbound: readonly RemoteSessionsComputerTree[]
  previous: ReadonlyMap<string, TreeResult>
}

export class RemoteSessionsTreeModel {
  static build(
    remote: RemoteConnectionsSnapshot,
    local: SessionsSnapshot,
    view: Omit<TreeViewState, 'content'>,
    marks: ReadonlySet<string>,
    previous: ReadonlyMap<string, TreeResult>,
    tasks: ReadonlyMap<string, RemoteTaskListing> = new Map(),
  ): RemoteSessionsSections {
    const next = new Map<string, TreeResult>()
    const outbound = RemoteSessionsTreeModel.outbound(
      remote.outbound,
      view,
      marks,
      previous,
      next,
      tasks,
    )
    const inbound = RemoteSessionsTreeModel.inbound(
      remote.inbound,
      local,
      view,
      marks,
      previous,
      next,
    )
    return { outbound, inbound, previous: next }
  }

  private static outbound(
    entries: readonly RemoteOutboundEndpointDto[],
    view: Omit<TreeViewState, 'content'>,
    marks: ReadonlySet<string>,
    previous: ReadonlyMap<string, TreeResult>,
    next: Map<string, TreeResult>,
    tasks: ReadonlyMap<string, RemoteTaskListing>,
  ): readonly RemoteSessionsComputerTree[] {
    const computers = new Map<string, RemoteSessionsComputerTree>()
    for (const entry of entries) {
      const selected = new Set(entry.selectedSessionIds ?? [])
      if (selected.size === 0 || entry.sessions === null) continue
      const reachable = entry.reachableSessionIds === undefined ? null : new Set(entry.reachableSessionIds)
      const key = `remote:${entry.remoteEndpointId}`
      const rows = entry.sessions.sessions.map((session) => {
        const reading = tasks.get(TerminalTargetCodec.key({ kind: 'remote', remoteEndpointId: entry.remoteEndpointId, sessionId: session.sessionId }))
        return reading ? { ...session, scripts: reading.scripts ?? undefined } : session
      })
      const listings = new Map(rows.flatMap((session) => {
        const reading = tasks.get(TerminalTargetCodec.key({ kind: 'remote', remoteEndpointId: entry.remoteEndpointId, sessionId: session.sessionId }))
        return reading ? [[session.sessionId, reading.listing] as const] : []
      }))
      const tree = SessionsTreeModel.build(
        {
          ...entry.sessions,
          sessions: reachable === null
            ? RemoteSessionsTreeModel.shown(rows, selected)
            : rows.filter((session) => reachable.has(session.sessionId)),
          orphans: [],
        },
        view,
        marks,
        previous.get(key) ?? null,
        {
          namespace: key,
          target: { kind: 'remote', remoteEndpointId: entry.remoteEndpointId },
          operationScope: 'remote',
          interactive: true,
          allowLocalPaths: false,
        },
        undefined,
        listings,
      )
      next.set(key, tree)
      if (tree.nodes.length === 0) continue
      RemoteSessionsTreeModel.push(computers, {
        id: `remote-computer:${entry.remoteComputerId}`,
        remoteComputerId: entry.remoteComputerId,
        label: entry.displayName,
        endpoints: [{
          id: `remote-endpoint:${entry.remoteEndpointId}`,
          remoteEndpointId: entry.remoteEndpointId,
          label: RemoteSessionsTreeModel.endpointLabel(entry),
          status: entry.status,
          tree,
        }],
      })
    }
    return RemoteSessionsTreeModel.sortedComputers(computers)
  }

  private static inbound(
    entries: readonly RemoteInboundConnectionDto[],
    local: SessionsSnapshot,
    view: Omit<TreeViewState, 'content'>,
    marks: ReadonlySet<string>,
    previous: ReadonlyMap<string, TreeResult>,
    next: Map<string, TreeResult>,
  ): readonly RemoteSessionsComputerTree[] {
    const computers = new Map<string, RemoteSessionsComputerTree>()
    for (const entry of entries) {
      const key = `inbound:${entry.identity.remoteEndpointId}`
      const active = new Set(entry.activeSessionIds)
      const tree = SessionsTreeModel.build(
        { ...local, sessions: RemoteSessionsTreeModel.shown(local.sessions, active) },
        view,
        marks,
        previous.get(key) ?? null,
        {
          namespace: key,
          target: { kind: 'local' },
          operationScope: 'local',
          interactive: true,
          allowLocalPaths: true,
        },
      )
      next.set(key, tree)
      if ((view.stateGroup !== undefined || view.group !== undefined) && tree.nodes.length === 0) continue
      RemoteSessionsTreeModel.push(computers, {
        id: `inbound-computer:${entry.identity.remoteComputerId}`,
        remoteComputerId: entry.identity.remoteComputerId,
        label: entry.identity.displayName,
        endpoints: [{
          id: `inbound-endpoint:${entry.identity.remoteEndpointId}`,
          remoteEndpointId: entry.identity.remoteEndpointId,
          label: `${entry.identity.configIdentity} (${entry.identity.runtimeChannel})`,
          status: 'connected',
          tree,
        }],
      })
    }
    return RemoteSessionsTreeModel.sortedComputers(computers)
  }

  /**
   * The local snapshot the person's own sections draw. A session marked Hidden when remote leaves
   * them while an inbound connection has it attached, so it is drawn under Remote connections only;
   * its script runs go with it, the way `shown` brings them there.
   */
  static locallyShown(
    local: SessionsSnapshot,
    remote: RemoteConnectionsSnapshot | null,
    hiddenWhenRemote: ReadonlySet<string>,
  ): SessionsSnapshot {
    if (remote === null || hiddenWhenRemote.size === 0) return local
    const hidden = new Set(remote.inbound.flatMap((entry) => entry.activeSessionIds).filter((sessionId) =>
      hiddenWhenRemote.has(SessionsGroupsState.sessionKeyOf({ kind: 'local', sessionId }))))
    if (hidden.size === 0) return local
    return { ...local, sessions: local.sessions.filter((session) => !hidden.has(session.sessionId)
      && !(session.script !== undefined && hidden.has(session.script.parentId))) }
  }

  /**
   * The sessions named, and the script runs of those: a run is part of the session it runs for, so
   * it comes with it the way it is nested under it on the computer that runs both.
   */
  private static shown(sessions: readonly SessionInfo[], named: ReadonlySet<string>): SessionInfo[] {
    return sessions.filter((session) => named.has(session.sessionId)
      || (session.script !== undefined && named.has(session.script.parentId)))
  }

  private static push(
    computers: Map<string, RemoteSessionsComputerTree>,
    incoming: RemoteSessionsComputerTree,
  ): void {
    const found = computers.get(incoming.remoteComputerId)
    if (found)
      computers.set(incoming.remoteComputerId, {
        ...found,
        endpoints: [...found.endpoints, ...incoming.endpoints],
      })
    else computers.set(incoming.remoteComputerId, incoming)
  }

  private static sortedComputers(
    computers: ReadonlyMap<string, RemoteSessionsComputerTree>,
  ): readonly RemoteSessionsComputerTree[] {
    return [...computers.values()]
      .map((computer) => ({
        ...computer,
        endpoints: [...computer.endpoints].sort((left, right) =>
          left.label.localeCompare(right.label)
          || left.remoteEndpointId.localeCompare(right.remoteEndpointId)),
      }))
      .sort((left, right) => left.label.localeCompare(right.label)
        || left.remoteComputerId.localeCompare(right.remoteComputerId))
  }

  private static endpointLabel(entry: RemoteOutboundEndpointDto): string {
    return `${entry.configIdentity} (${entry.runtimeChannel})`
  }

}
