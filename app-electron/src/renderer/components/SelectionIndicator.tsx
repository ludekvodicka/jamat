import { useLayoutStore } from '../store/layout-store'

export function SelectionIndicator() {
  const selection = useLayoutStore(s => s.terminalSelection)
  if (!selection) return null

  return (
    <span
      className="status-item"
      style={{ color: '#4ec94e', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      title={selection}
    >
      Sel: {selection}
    </span>
  )
}
