import { useCallback, useRef, useSyncExternalStore } from 'react'

import type {
  SessionAgentId,
  SessionInfo,
  SessionsSnapshot,
} from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { TerminalTargetCodec } from '../../shared/terminalTarget'
import type { SnapshotStore } from '../ipc/snapshotStore'
import type { ActiveTerminalReading, ActiveTerminalStore } from '../shell/activeTerminalStore'

export interface ActiveAgentTerminal {
  sessionId: string
  agentId: SessionAgentId
  life: 'starting' | 'live' | 'ended' | 'lost'
}

/**
 * What the bar of THIS window needs to know about the tab in front of it: the session, whose agent it
 * is, and whether it is still running. Null is "nothing to say about the active tab" - no tab, a tab
 * that is not a local terminal, a shell session, or a session this window's snapshot has no record
 * of.
 *
 * The join belongs here rather than in the store, and that is what makes V1's race impossible: the
 * panel id carries the source-aware target atomically, and the agent is a property of the snapshot
 * record rather than a message that can arrive after the tab has already changed.
 */
export function useActiveAgentTerminal(
  active: ActiveTerminalStore,
  sessions: SnapshotStore<SessionsSnapshot>,
): ActiveAgentTerminal | null {
  const subscribe = useCallback((onChanged: () => void) => {
    const stopActive = active.subscribe(onChanged)
    const stopSessions = sessions.subscribe(onChanged)
    return () => {
      stopActive()
      stopSessions()
    }
  }, [active, sessions])
  // Held rather than rebuilt: a busy agent moves the sessions document several times a second, and a
  // fresh object on every read would be a fresh identity - the bar would then re-render for every
  // revision, including the ones that said nothing about this tab.
  const held = useRef<ActiveAgentTerminal | null>(null)
  const read = useCallback((): ActiveAgentTerminal | null => {
    const next = ActiveAgentTerminals.of(active.current(), sessions.current().snapshot)
    if (!ActiveAgentTerminals.same(held.current, next))
      held.current = next
    return held.current
  }, [active, sessions])
  return useSyncExternalStore(subscribe, read, read)
}

export class ActiveAgentTerminals {
  static of(
    reading: ActiveTerminalReading | null,
    snapshot: SessionsSnapshot | null,
  ): ActiveAgentTerminal | null {
    if (reading === null || snapshot === null
      || TerminalTargetCodec.endpointOf(reading.target) !== null)
      return null
    const info = snapshot.sessions.find((session) => session.sessionId === reading.target.sessionId)
    if (info === undefined)
      return null
    return ActiveAgentTerminals.agentOf(info)
  }

  private static agentOf(info: SessionInfo): ActiveAgentTerminal | null {
    if (info.kind === 'shell')
      return null
    else if (info.kind === 'agent') {
      // A record that names no agent is one nothing can be drawn about, the same as a shell.
      if (info.agent === undefined)
        return null
      return { sessionId: info.sessionId, agentId: info.agent.agentId, life: info.life }
    } else
      throw new Error(`Unknown session kind: ${JSON.stringify(info)}`)
  }

  static same(left: ActiveAgentTerminal | null, right: ActiveAgentTerminal | null): boolean {
    if (left === null || right === null)
      return left === right
    return left.sessionId === right.sessionId
      && left.agentId === right.agentId
      && left.life === right.life
  }
}
