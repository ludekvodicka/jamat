import type {
  RemoteConnectionsSnapshot,
  RemoteOutboundEndpointDto,
} from '../../../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import type { LauncherRemoteTarget } from '../launcherTarget'

/** One connected computer as this screen draws it. */
export interface ComputerRow extends LauncherRemoteTarget {
  /** `host:port`. Two endpoints of one computer differ in nothing else a person can read. */
  endpointLabel: string
  /** Null until that computer has pushed a session snapshot; absence is not zero sessions. */
  sessionCount: number | null
}

export interface ComputersScreenState {
  rows: readonly ComputerRow[]
  cursor: number
  /**
   * Whether a snapshot has been read at all. "Nobody has looked yet" and "nothing is connected" are
   * the same empty list otherwise, and only one of them is worth telling somebody about.
   */
  loaded: boolean
}

export type ComputersScreenInput =
  | { input: 'snapshotLoaded'; rows: readonly ComputerRow[] }
  | { input: 'moveCursor'; delta: number }
  /** The mouse's activate: it names the row rather than acting on wherever the cursor stands. */
  | { input: 'openRow'; index: number }
  | { input: 'setCursor'; index: number }
  | { input: 'activate' }
  | { input: 'openSettings' }
  | { input: 'escape' }

export type ComputersScreenEffect =
  | { effect: 'fetchComputers' }
  | { effect: 'chosen'; target: LauncherRemoteTarget }
  /** Where a computer that is NOT on this list is explained: paired, offline, disabled alike. */
  | { effect: 'openSettings' }
  | { effect: 'close' }

export interface ComputersScreenStep {
  state: ComputersScreenState
  effects: readonly ComputersScreenEffect[]
}

/**
 * The first screen of the remote profile: which computer this card is about.
 *
 * Connected-only, the same rule the sessions tree follows and for the same reason: a card that
 * offered a computer this one cannot reach would take a project name, a session name and an agent
 * before saying so. What is missing from here is explained in Settings -> Network -> Remote
 * connections, the one place a paired computer's last success, next retry and version are written
 * down.
 *
 * The list fills IN as the dials land rather than being there already: nothing is connected until
 * something asks, and this screen is one of the things that asks, for as long as it is open.
 */
export class ComputersScreenModel {
  static initial(): ComputersScreenStep {
    return ComputersScreenModel.step(
      { rows: [], cursor: 0, loaded: false },
      { effect: 'fetchComputers' },
    )
  }

  /**
   * The connected outbound endpoints of a snapshot, in the order they are drawn.
   *
   * The switch is exhaustive and throws on a status nobody has decided about here, rather than
   * letting an unknown one fall through to a drawn row: every arm of it is a decision, and the
   * three that continue are the decision the user made when the tree was pinned connected-only.
   */
  static rowsOf(snapshot: RemoteConnectionsSnapshot): readonly ComputerRow[] {
    const rows: ComputerRow[] = []
    for (const entry of snapshot.outbound) {
      switch (entry.status) {
        case 'connected': break
        case 'idle':
        case 'connecting':
        case 'offline': continue
        default: throw new Error(`Unknown remote endpoint status: ${JSON.stringify(entry.status)}`)
      }
      rows.push({
        remoteEndpointId: entry.remoteEndpointId,
        displayName: entry.displayName,
        endpointLabel: ComputersScreenModel.endpointLabelOf(entry),
        sessionCount: entry.sessions?.sessions.length ?? null,
      })
    }
    return rows.sort((one, other) =>
      one.displayName.localeCompare(other.displayName)
      || one.endpointLabel.localeCompare(other.endpointLabel))
  }

  static transition(
    state: ComputersScreenState,
    input: ComputersScreenInput,
  ): ComputersScreenStep {
    if (input.input === 'snapshotLoaded')
      return ComputersScreenModel.withRows(state, input.rows)
    else if (input.input === 'moveCursor')
      return ComputersScreenModel.withCursor(state, state.cursor + input.delta)
    else if (input.input === 'setCursor')
      return ComputersScreenModel.withCursor(state, input.index)
    else if (input.input === 'openRow')
      return ComputersScreenModel.activated(
        ComputersScreenModel.withCursor(state, input.index).state)
    else if (input.input === 'activate') return ComputersScreenModel.activated(state)
    else if (input.input === 'openSettings')
      return ComputersScreenModel.step(state, { effect: 'openSettings' })
    else if (input.input === 'escape') return ComputersScreenModel.step(state, { effect: 'close' })
    else
      throw new Error(`Unknown computers screen input: ${JSON.stringify(input)}`)
  }

  /** What the screen says instead of a list, or null while there is a list to draw. */
  static emptyRefusal(state: ComputersScreenState): string | null {
    if (!state.loaded) return 'Reading the connected computers…'
    if (state.rows.length > 0) return null
    return 'No connected computers. Pair one and connect it in Settings → Remote Control.'
  }

  static rowKeyOf(row: ComputerRow): string {
    return row.remoteEndpointId
  }

  private static endpointLabelOf(entry: RemoteOutboundEndpointDto): string {
    return `${entry.endpoint.host}:${entry.endpoint.port}`
  }

  /**
   * A computer that dropped off the list mid-flow is a normal state: the row goes, the cursor moves
   * to whatever is still there, and the card stays up. The chosen target is the caller's to check.
   */
  private static withRows(
    state: ComputersScreenState,
    rows: readonly ComputerRow[],
  ): ComputersScreenStep {
    const standing = state.rows[state.cursor]
    const found = standing === undefined
      ? -1
      : rows.findIndex((row) => row.remoteEndpointId === standing.remoteEndpointId)
    return ComputersScreenModel.step({
      ...state,
      rows,
      loaded: true,
      cursor: ComputersScreenModel.clamp(found >= 0 ? found : state.cursor, rows.length),
    })
  }

  private static withCursor(state: ComputersScreenState, index: number): ComputersScreenStep {
    return ComputersScreenModel.step({
      ...state,
      cursor: ComputersScreenModel.clamp(index, state.rows.length),
    })
  }

  private static activated(state: ComputersScreenState): ComputersScreenStep {
    const row = state.rows[state.cursor]
    if (row === undefined) return ComputersScreenModel.step(state)
    return ComputersScreenModel.step(state, {
      effect: 'chosen',
      target: { remoteEndpointId: row.remoteEndpointId, displayName: row.displayName },
    })
  }

  private static clamp(index: number, length: number): number {
    if (length === 0) return 0
    if (index < 0) return 0
    if (index >= length) return length - 1
    return index
  }

  private static step(
    state: ComputersScreenState,
    ...effects: readonly ComputersScreenEffect[]
  ): ComputersScreenStep {
    return { state, effects }
  }
}
