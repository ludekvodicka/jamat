import { Fragment, useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { RemoteConnectionsSnapshot } from '../../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import { SessionWorkspaceTargets, type SessionFilePorts } from '../../../shared/sessionWorkspace'
import { TerminalTargetCodec } from '../../../shared/terminalTarget'
import type { AppClientUiBridge } from '../../../shared/appClientUiIpc'
import type { SnapshotStore } from '../../ipc/snapshotStore'
import { SessionWorkspaceProviders } from './sessionWorkspaceProviders'

export function SessionContentPanel(props: {
  params: Record<string, unknown>
  remote: SnapshotStore<RemoteConnectionsSnapshot>
  children(files: SessionFilePorts, changes: AppClientUiBridge['fileChanges'] | null): React.ReactNode
}): React.JSX.Element {
  const target = SessionWorkspaceTargets.panel(props.params)
  const key = TerminalTargetCodec.key(target)
  const workspace = useMemo(() => SessionWorkspaceProviders.forTarget(target, props.remote), [key, props.remote])
  useEffect(() => workspace.start(), [workspace])
  const revision = useSyncExternalStore(useCallback((changed) => workspace.subscribe(changed), [workspace]), useCallback(() => workspace.contentRevision(), [workspace]))
  return workspace.files ? <Fragment key={`${key}:${revision}`}>{props.children(workspace.files, workspace.changes)}</Fragment> : <p>This peer does not support source files.</p>
}
