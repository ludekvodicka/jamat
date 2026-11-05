import { useState } from 'react'

import './fileViewerPane.css'
import type { PromptInsertMode } from '../shell/terminalInputRegistry'
import { ContextMenu, type ContextMenuPosition } from '../widgets/contextMenu'

export function FileViewerChecklistStrip(props: {
  done: number
  total: number
  onSend?: (mode: PromptInsertMode) => void
  unavailable?: string
}): React.JSX.Element {
  const [menu, setMenu] = useState<ContextMenuPosition | null>(null)
  const send = props.onSend
  return <div className="file-viewer-checklist" role="group" aria-label="Checklist results">
    <span>Checklist {props.done}/{props.total}</span>
    <span className="file-viewer-checklist__send">
      <button type="button" disabled={!send} title={props.unavailable ?? 'Send the results to the agent'}
        onClick={() => send?.('submit')}>Send results</button>
      <button type="button" className="file-viewer-checklist__more" disabled={!send} aria-label="More send options"
        aria-haspopup="menu" aria-expanded={menu !== null} title={props.unavailable ?? 'More send options'}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect()
          setMenu({ x: box.left, y: box.bottom })
        }}>▾</button>
    </span>
    {menu && send && <ContextMenu ariaLabel="Send options" position={menu}
      items={[{ key: 'insert', label: 'Insert to terminal', onSelect: () => send('insert') }]}
      onClose={() => setMenu(null)} />}
  </div>
}
