import type {
  RemoteConnectionsSnapshot,
  RemoteOutboundEndpointDto,
} from '../../../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import { SessionsFilterState } from '../../../../shared/sessionsFilterState'
import { SessionsTreeModel } from '../../../views/sessionsTree/sessionsTreeModel'
import type { LauncherRemoteTarget } from '../launcherTarget'

export interface ComputerRow extends LauncherRemoteTarget {
  endpointLabel: string
  sessionCount: number | null
  status: RemoteOutboundEndpointDto['status']
  error: string | null
  sessions: RemoteOutboundEndpointDto['sessions']
  selectedSessionIds: readonly string[]
}

export interface ComputersScreenState {
  rows: readonly ComputerRow[]
  cursor: number
  loaded: boolean
  error?: string | null
}

export type ComputersScreenInput =
  | { input: 'snapshotLoaded'; rows: readonly ComputerRow[] }
  | { input: 'moveCursor'; delta: number }
  | { input: 'openRow'; index: number }
  | { input: 'setCursor'; index: number }
  | { input: 'activate' }
  | { input: 'newSession' }
  | { input: 'selectSession'; sessionId: string }
  | { input: 'failed'; detail: string }
  | { input: 'openSettings' }
  | { input: 'escape' }

export type ComputersScreenEffect =
  | { effect: 'fetchComputers' }
  | { effect: 'connect'; remoteEndpointId: string }
  | { effect: 'selectSession'; remoteEndpointId: string; sessionId: string; tabTitle: string }
  | { effect: 'chosen'; target: LauncherRemoteTarget }
  | { effect: 'openSettings' }
  | { effect: 'close' }

export interface ComputersScreenStep {
  state: ComputersScreenState
  effects: readonly ComputersScreenEffect[]
}

export class ComputersScreenModel {
  static initial(): ComputersScreenStep {
    return { state: { rows: [], cursor: 0, loaded: false }, effects: [{ effect: 'fetchComputers' }] }
  }

  static rowsOf(snapshot: RemoteConnectionsSnapshot): readonly ComputerRow[] {
    return snapshot.outbound.map((entry) => {
      switch (entry.status) {
        case 'connected':
        case 'idle':
        case 'connecting':
        case 'offline': break
        default: throw new Error(`Unknown remote endpoint status: ${JSON.stringify(entry.status)}`)
      }
      return {
        remoteEndpointId: entry.remoteEndpointId,
        displayName: entry.displayName,
        endpointLabel: `${entry.endpoint.host}:${entry.endpoint.port}`,
        sessionCount: entry.sessions?.sessions.length ?? null,
        status: entry.status,
        error: entry.error?.detail ?? null,
        sessions: entry.sessions,
        selectedSessionIds: entry.selectedSessionIds ?? [],
      }
    }).sort((one, other) => one.displayName.localeCompare(other.displayName)
      || one.endpointLabel.localeCompare(other.endpointLabel))
  }

  static transition(state: ComputersScreenState, input: ComputersScreenInput): ComputersScreenStep {
    const row = state.rows[state.cursor]
    switch (input.input) {
      case 'snapshotLoaded': {
        const found = input.rows.findIndex((entry) => entry.remoteEndpointId === row?.remoteEndpointId)
        return { state: { ...state, rows: input.rows, loaded: true,
          cursor: ComputersScreenModel.clamp(found >= 0 ? found : state.cursor, input.rows.length) }, effects: [] }
      }
      case 'moveCursor':
        return ComputersScreenModel.cursor(state, state.cursor + input.delta)
      case 'setCursor':
        return ComputersScreenModel.cursor(state, input.index)
      case 'openRow':
        return ComputersScreenModel.transition(ComputersScreenModel.cursor(state, input.index).state, { input: 'activate' })
      case 'activate':
        return { state: { ...state, error: null }, effects: row === undefined || row.status === 'connecting'
          ? [] : [{ effect: 'connect', remoteEndpointId: row.remoteEndpointId }] }
      case 'newSession':
        return { state, effects: row?.status === 'connected'
          ? [{ effect: 'chosen', target: { remoteEndpointId: row.remoteEndpointId, displayName: row.displayName } }] : [] }
      case 'selectSession': {
        const session = row?.sessions?.sessions.find((entry) => entry.sessionId === input.sessionId)
        return { state: { ...state, error: null }, effects: row?.status === 'connected' && session
          ? [{ effect: 'selectSession', remoteEndpointId: row.remoteEndpointId, sessionId: session.sessionId, tabTitle: session.tabTitle }] : [] }
      }
      case 'failed': return { state: { ...state, error: input.detail }, effects: [] }
      case 'openSettings': return { state, effects: [{ effect: 'openSettings' }] }
      case 'escape': return { state, effects: [{ effect: 'close' }] }
      default: throw new Error(`Unknown computers screen input: ${JSON.stringify(input)}`)
    }
  }

  static emptyRefusal(state: ComputersScreenState): string | null {
    if (!state.loaded) return 'Reading saved computers…'
    return state.rows.length > 0 ? null : 'No saved computers. Add a computer in Remote Control settings.'
  }

  static treeOf(row: ComputerRow | undefined, filter: string) {
    if (!row?.sessions) return []
    return SessionsTreeModel.build(row.sessions, {
      filters: SessionsFilterState.allConst,
      content: 'both',
      filterText: filter,
      inFront: new Set(),
      now: 0,
    }, new Set(), null, {
      namespace: `connect:${row.remoteEndpointId}`,
      target: { kind: 'remote', remoteEndpointId: row.remoteEndpointId },
      operationScope: 'remote',
      interactive: true,
      allowLocalPaths: false,
    }).nodes
  }

  static rowKeyOf(row: ComputerRow): string { return row.remoteEndpointId }

  private static cursor(state: ComputersScreenState, index: number): ComputersScreenStep {
    return { state: { ...state, error: null, cursor: ComputersScreenModel.clamp(index, state.rows.length) }, effects: [] }
  }

  private static clamp(index: number, length: number): number {
    return Math.max(0, Math.min(index, length - 1))
  }
}
