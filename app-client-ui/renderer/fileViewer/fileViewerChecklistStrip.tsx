import { useState } from 'react'

import './fileViewerPane.css'
import type { PromptInsertMode } from '../shell/terminalInputRegistry'
import { ContextMenu, type ContextMenuPosition } from '../widgets/contextMenu'

/**
 * Send to agent with the checklist's confirmed count: `Send results` alone did not say where the
 * results went. A click sends them to the agent, the arrow inserts them unsent.
 */
export function FileViewerChecklistStrip(props: {
  done: number
  total: number
  onSend?: (mode: PromptInsertMode) => void
  unavailable?: string
}): React.JSX.Element {
  const [menu, setMenu] = useState<ContextMenuPosition | null>(null)
  const send = props.onSend
  return <span className="file-viewer-checklist__send" role="group" aria-label="Checklist results">
    <button type="button" disabled={!send} title={props.unavailable ?? `${props.done} of ${props.total} checks confirmed. Sends the confirmed count and the unconfirmed items to the agent in this session's terminal.`}
      onClick={() => send?.('submit')}>Send to agent {props.done}/{props.total}</button>
    <button type="button" className="file-viewer-checklist__more" disabled={!send} aria-label="More checklist options"
      aria-haspopup="menu" aria-expanded={menu !== null} title={props.unavailable ?? 'More checklist options'}
      onClick={(event) => {
        const box = event.currentTarget.getBoundingClientRect()
        setMenu({ x: box.left, y: box.bottom })
      }}>▾</button>
    {menu && send && <ContextMenu ariaLabel="Checklist options" position={menu}
      items={[{ key: 'insert', label: 'Insert into terminal (no Enter)', onSelect: () => send('insert') }]}
      onClose={() => setMenu(null)} />}
  </span>
}
