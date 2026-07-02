interface ActionsPanelProps {
  projectDir: string | null
  panelId: string
}

export function ActionsPanel({ projectDir }: ActionsPanelProps) {
  const openInVSCode = () => {
    if (projectDir) window.electronAPI?.runAction('open-vscode', projectDir)
  }

  return (
    <div className="actions-panel">
      <button className="action-btn" onClick={openInVSCode} disabled={!projectDir} style={{ width: '100%' }}>
        <span className="action-icon">📝</span>
        <span>Open in VS Code</span>
      </button>
    </div>
  )
}
