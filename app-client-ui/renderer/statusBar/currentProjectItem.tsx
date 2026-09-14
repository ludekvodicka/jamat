import { useCallback, useRef, useSyncExternalStore } from 'react'

import type { RemoteConnectionsSnapshot } from '../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import type { SessionsSnapshot, SessionTitleParts } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { TerminalTargetCodec } from '../../shared/terminalTarget'
import type { SnapshotStore } from '../ipc/snapshotStore'
import type { ActiveTerminalStore } from '../shell/activeTerminalStore'

export interface CurrentProject extends SessionTitleParts {
  category: string
  project: string
}

export function useCurrentProject(
  active: ActiveTerminalStore,
  local: SnapshotStore<SessionsSnapshot>,
  remote: SnapshotStore<RemoteConnectionsSnapshot>,
): CurrentProject | null {
  const held = useRef<CurrentProject | null>(null)
  const subscribe = useCallback((listener: () => void) => {
    const offActive = active.subscribe(listener)
    const offLocal = local.subscribe(listener)
    const offRemote = remote.subscribe(listener)
    return () => {
      offActive()
      offLocal()
      offRemote()
    }
  }, [active, local, remote])
  const read = useCallback(() => {
    const target = active.current()?.target
    let next: CurrentProject | null = null
    if (target !== undefined) {
      const endpointId = TerminalTargetCodec.endpointOf(target)
      const snapshot = endpointId === null
        ? local.current().snapshot
        : remote.current().snapshot?.outbound
          .find((entry) => entry.remoteEndpointId === endpointId)?.sessions
      next = CurrentProjects.of(snapshot ?? null, target.sessionId)
    }
    const previous = held.current
    if (previous?.category !== next?.category || previous?.project !== next?.project
      || previous?.number !== next?.number || previous?.name !== next?.name)
      held.current = next
    return held.current
  }, [active, local, remote])
  return useSyncExternalStore(subscribe, read, read)
}

export function CurrentProjectItem(props: { current: CurrentProject }): React.JSX.Element {
  const { category, project, number, name } = props.current
  const prefix = category ? `${category} / ` : ''
  const emphasis = `${project ? `${project} / ` : ''}${number ?? ''}`
  const suffix = `${number !== null && name ? ' - ' : ''}${name}`
  return (
    <span className="jamat-current-project" title={`${prefix}${emphasis}${suffix}`}>
      {prefix}
      <span className="jamat-current-project__focus">{emphasis}</span>
      {suffix}
    </span>
  )
}

class CurrentProjects {
  static of(snapshot: SessionsSnapshot | null, sessionId: string): CurrentProject | null {
    const session = snapshot?.sessions.find((entry) => entry.sessionId === sessionId)
    if (session === undefined || snapshot === null)
      return null
    const { project, titleParts } = session
    if (project.kind === 'project')
      return {
        category: snapshot.categories.find((entry) => entry.id === project.categoryId)?.label
          ?? project.categoryId,
        project: project.projectName,
        ...titleParts,
      }
    else if (project.kind === 'adHoc')
      return { category: '', project: project.path, ...titleParts }
    else if (project.kind === 'none')
      return { category: '', project: '', ...titleParts }
    else
      throw new Error(`Unknown project kind: ${JSON.stringify(project)}`)
  }
}
