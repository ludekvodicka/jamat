import { useMemo, useRef, useState } from 'react'

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
import { ContextMenu, type ContextMenuPosition } from '../widgets/contextMenu'

export interface HostStatusPorts {
  reportError(message: string): void
  startHost(): Promise<IpcResult<SessionsOpResult>>
  restartHost(hostInstanceId: string): Promise<IpcResult<SessionsOpResult>>
  stopHost(hostInstanceId: string): Promise<IpcResult<SessionsOpResult>>
  confirmHostRestart(liveCount: number): Promise<IpcResult<boolean>>
  confirmHostStop(liveCount: number): Promise<IpcResult<boolean>>
}

type HostAction = 'restart' | 'stop'

interface HostActionSpec {
  verb: string
  busyText: string
  confirm(ports: HostStatusPorts, liveCount: number): Promise<IpcResult<boolean>>
  run(ports: HostStatusPorts, hostInstanceId: string): Promise<IpcResult<SessionsOpResult>>
}

const hostActionsConst: Record<HostAction, HostActionSpec> = {
  restart: {
    verb: 'restarted',
    busyText: 'Host restarting…',
    confirm: (ports, liveCount) => ports.confirmHostRestart(liveCount),
    run: (ports, hostInstanceId) => ports.restartHost(hostInstanceId),
  },
  stop: {
    verb: 'stopped',
    busyText: 'Host stopping…',
    confirm: (ports, liveCount) => ports.confirmHostStop(liveCount),
    run: (ports, hostInstanceId) => ports.stopHost(hostInstanceId),
  },
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
  const [menu, setMenu] = useState<{ position: ContextMenuPosition; hostInstanceId: string | null; liveCount: number } | null>(null)
  const [busy, setBusy] = useState<HostAction | null>(null)
  const actionPending = useRef(false)
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

  const act = async (action: HostAction): Promise<void> => {
    if (menu === null || menu.hostInstanceId === null || actionPending.current) return
    const hostInstanceId = menu.hostInstanceId
    const spec = hostActionsConst[action]
    actionPending.current = true
    try {
      const confirmed = await spec.confirm(ports, menu.liveCount)
      if (!confirmed.ok) {
        ports.reportError(`The Host could not be ${spec.verb}: ${confirmed.error}`)
        return
      }
      if (!confirmed.value) return
      setBusy(action)
      const failure = IpcFailure.of(await spec.run(ports, hostInstanceId))
      if (failure) ports.reportError(`The Host could not be ${spec.verb}: ${failure}`)
    } catch (thrown) {
      ports.reportError(`The Host could not be ${spec.verb}: ${ErrorText.of(thrown)}`)
    } finally {
      actionPending.current = false
      setBusy(null)
    }
  }

  const openMenu = (event: React.MouseEvent): void => {
    event.preventDefault()
    if (host === null || actionPending.current) return
    const position = { x: event.clientX, y: event.clientY }
    if (host.presence === 'running')
      setMenu(host.hostInstanceId ? { position, hostInstanceId: host.hostInstanceId, liveCount: host.liveCount } : null)
    else if (host.presence === 'unreachable')
      setMenu({ position, hostInstanceId: null, liveCount: 0 })
    // Nothing to offer while a launch is in flight: Start would be a second Host, and Stop has no Host yet.
    else if (host.presence === 'starting')
      setMenu(null)
    else
      throw new Error(`Unknown host presence: ${JSON.stringify(host.presence)}`)
  }

  const menuItems = menu === null ? [] : menu.hostInstanceId === null
    ? [{ key: 'start-host', label: 'Start apphost', onSelect: start }]
    : [
        { key: 'restart-host', label: 'Restart apphost', onSelect: () => { void act('restart') } },
        { key: 'stop-host', label: 'Stop apphost', onSelect: () => { void act('stop') } },
      ]
  const contextMenu = menu !== null && busy === null && (
    <ContextMenu
      position={menu.position}
      ariaLabel="AppHost actions"
      items={menuItems}
      onClose={() => setMenu(null)}
    />
  )

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
  if (!reading.startable || busy !== null)
    return (
      <>
        <span className="jamat-host-status" onContextMenu={openMenu}>
          {busy === null ? reading.text : hostActionsConst[busy].busyText}
        </span>
        {contextMenu}
      </>
    )
  return (
    <>
      <span className="jamat-host-status" onContextMenu={openMenu}>
        {reading.text}
        <button className="jamat-host-status__start" type="button" onClick={start}>Start Host</button>
      </span>
      {contextMenu}
    </>
  )
}
