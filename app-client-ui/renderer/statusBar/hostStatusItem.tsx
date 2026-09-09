import { useMemo } from 'react'

import type {
  HostStatusInfo,
  SessionsOpResult,
  SessionsSnapshot,
} from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { IpcResult } from '../../shared/appClientUiIpc'
import { ErrorText } from '../../shared/errorText'
import { IpcFailure } from '../ipc/ipcFailure'
import type { SnapshotStore } from '../ipc/snapshotStore'
import { useSessionsSnapshot } from '../views/sessionsTree/useSessionsSnapshot'

export interface HostStatusPorts {
  reportError(message: string): void
  startHost(): Promise<IpcResult<SessionsOpResult>>
}

/** What a surface draws about the Host: one line of text, and whether it may offer to start one. */
export interface HostReading {
  text: string
  startable: boolean
}

/**
 * The one derivation of what the Host's presence means on screen. The status bar item below and the
 * Debug window's host section both read it here rather than each switching on `presence`, because
 * two switches on the same three-valued field are two answers waiting to disagree. The sessions
 * panel used to be a third reader; it says nothing about the Host now, and the bar is the one place
 * this is drawn.
 */
export class HostStatusReading {
  static of(host: HostStatusInfo): HostReading {
    if (host.presence === 'running')
      return { text: `Host v${host.hostVersion ?? '?'} · ${host.liveCount} live`, startable: false }
    // No Start offered while one launch is already in flight: a second would be a second Host.
    else if (host.presence === 'starting')
      return { text: 'Host starting…', startable: false }
    else if (host.presence === 'unreachable')
      return { text: 'Host unreachable', startable: true }
    else
      throw new Error(`Unknown host presence: ${JSON.stringify(host.presence)}`)
  }
}

/**
 * The Host's reading from the same document the sessions tree and restart chain observe.
 *
 * **Memoised on the three fields it draws.** The store hands back a fresh object per revision, and a
 * revision moves whenever anything about any session does - several times a second while an agent
 * works, in every open window. What this item shows changes almost never, so the sentence and the
 * button are derived once per CHANGE rather than once per revision. The neighbour
 * `useActiveAgentTerminal` holds a ref for the same reason.
 */
export function HostStatusItem(props: {
  ports: HostStatusPorts
  snapshotStore: SnapshotStore<SessionsSnapshot>
}): React.JSX.Element {
  const { ports, snapshotStore } = props
  const { snapshot, error, refresh } = useSessionsSnapshot(snapshotStore)
  const host = snapshot?.host ?? null
  const presence = host?.presence ?? null
  const hostVersion = host?.hostVersion ?? null
  const liveCount = host?.liveCount ?? null
  const reading = useMemo(
    () => presence === null || liveCount === null
      ? null
      : HostStatusReading.of({ presence, hostVersion, liveCount } as HostStatusInfo),
    [hostVersion, liveCount, presence],
  )

  const start = (): void => {
    void ports.startHost()
      .then((answer) => {
        const failure = IpcFailure.of(answer)
        if (failure)
          ports.reportError(`The Host could not be started: ${failure}`)
      })
      .catch((thrown: unknown) =>
        ports.reportError(`The Host could not be started: ${ErrorText.of(thrown)}`))
  }

  if (error !== null)
    return (
      <span className="jamat-host-status" title={error}>
        Host status unavailable
        <button className="jamat-host-status__start" type="button" onClick={refresh}>Retry</button>
      </span>
    )
  // Before the first read answers there is nothing true to say: a Host drawn as unreachable here
  // would offer a Start for a Host that may well be running.
  if (reading === null)
    return <span className="jamat-host-status">Host …</span>
  if (!reading.startable)
    return <span className="jamat-host-status">{reading.text}</span>
  return (
    <span className="jamat-host-status">
      {reading.text}
      <button className="jamat-host-status__start" type="button" onClick={start}>Start Host</button>
    </span>
  )
}
