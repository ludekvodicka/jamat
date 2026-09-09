import type {
  RemoteConnectionsSnapshot,
  RemoteInboundConnectionDto,
  RemoteOutboundEndpointDto,
} from '../../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import type { SessionsSnapshot } from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
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
  ): RemoteSessionsSections {
    const next = new Map<string, TreeResult>()
    const outbound = RemoteSessionsTreeModel.outbound(
      remote.outbound,
      view,
      marks,
      previous,
      next,
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
  ): readonly RemoteSessionsComputerTree[] {
    const computers = new Map<string, RemoteSessionsComputerTree>()
    for (const entry of entries) {
      /*
       * Connected-only, and deliberately so: a computer this one cannot reach draws NO row here, not
       * a greyed one. The tree is what is running right now; a paired computer that is idle, still
       * dialling or offline is a settings matter, and Settings -> Network -> Remote connections is
       * where it is listed with the reason - last success, next retry, its version and a manual
       * Retry. `remoteSessionsTreeModel.test.ts` pins each of the three, because "show them here
       * too" is the obvious change to make and it is the one that was decided against.
       *
       * Since dialling became on demand this is also why the tree is quiet: a paired computer is
       * idle until a tab, a launcher card or the settings screen asks for it, so a row here means
       * something is really connected rather than that a profile exists.
       */
      switch (entry.status) {
        case 'connected': break
        case 'idle':
        case 'connecting':
        case 'offline': continue
        default: throw new Error(`Unknown remote endpoint status: ${JSON.stringify(entry.status)}`)
      }
      const key = `remote:${entry.remoteEndpointId}`
      const tree = SessionsTreeModel.build(
        entry.sessions ?? RemoteSessionsTreeModel.emptySnapshot(),
        { ...view, content: 'both' },
        marks,
        previous.get(key) ?? null,
        {
          namespace: key,
          target: { kind: 'remote', remoteEndpointId: entry.remoteEndpointId },
          operationScope: 'remote',
          interactive: true,
          allowLocalPaths: false,
        },
      )
      next.set(key, tree)
      if (view.stateGroup !== undefined && tree.nodes.length === 0) continue
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
        { ...local, sessions: local.sessions.filter((session) => active.has(session.sessionId)) },
        { ...view, content: 'both' },
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
      if (view.stateGroup !== undefined && tree.nodes.length === 0) continue
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

  private static emptySnapshot(): SessionsSnapshot {
    return {
      revision: 0,
      reconciled: false,
      host: {
        presence: 'unreachable',
        hostVersion: null,
        hostInstanceId: null,
        liveCount: 0,
        lastStartError: null,
      },
      categories: [],
      sessions: [],
      orphans: [],
    }
  }
}
