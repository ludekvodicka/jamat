import { IDockviewPanelProps } from 'dockview'
import { NotesPanel } from './NotesPanel'
import type { RemotePeer } from '../../../../../core/types/remote-control'

/**
 * Dockview wrapper that opens the (leaf) NotesPanel standalone for a PEER (Direction #2). NotesPanel
 * is normally a child of TerminalSidebarPanel keyed by the tab's projectDir; here we key it by the
 * peer tab's `cwd` (== the same projectDir panelId) and route load/save to that peer via the seam.
 * No `onPaste` — there's no local terminal to paste into.
 */
interface RemoteNotesParams {
  peer: RemotePeer
  /** Notes are keyed by panelId == the project dir; the peer tab's cwd is that key. */
  projectDir: string
}

export function RemoteNotesPanel({ params }: IDockviewPanelProps<RemoteNotesParams>) {
  return (
    <div style={{ height: '100%', overflow: 'auto' }}>
      <NotesPanel panelId={params.projectDir} peer={params.peer} visible />
    </div>
  )
}
