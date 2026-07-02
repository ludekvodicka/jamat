import { useEffect, useRef } from 'react'

/** What a right-clicked Abilities row represents + what can be done to it. */
export interface AbilitiesMenuTarget {
  kind: 'plugin' | 'skill' | 'instruction'
  /** display name */
  name: string
  /** plugin: the installed_plugins.json key (name@marketplace); skill: the dir name under ~/.claude/skills */
  id: string
  /** plugin: enabled globally; skill: present (listed skills are always present) */
  enabled: boolean
  /** plugin: has a key; skill: is a symlink (only synced skills can be toggled) */
  toggleable: boolean
  path?: string
}

interface Props {
  x: number
  y: number
  target: AbilitiesMenuTarget
  onAction: (action: 'enable' | 'disable') => void
  onRemove: () => void
  onOpen: (where: 'window' | 'vscode') => void
  onClose: () => void
}

/**
 * Right-click menu for the Abilities panel — enable/disable a plugin or user skill. Mirrors
 * TabContextMenu (fixed-positioned div, dismiss on outside mousedown + Escape). Changes are NOT
 * live (Claude loads ~/.claude at session start) — the note says so.
 */
export function AbilitiesContextMenu({ x, y, target, onAction, onRemove, onOpen, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const m = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('mousedown', m)
    window.addEventListener('keydown', k)
    return () => { window.removeEventListener('mousedown', m); window.removeEventListener('keydown', k) }
  }, [onClose])

  // Instructions: read-only files — open them, don't enable/disable/remove.
  if (target.kind === 'instruction') {
    return (
      <div ref={ref} className="abilities-ctx" style={{ left: x, top: y }}>
        <div className="abilities-ctx-head">📜 {target.name}</div>
        <div className="abilities-ctx-item" onClick={() => { onOpen('window'); onClose() }}>Open in new window</div>
        <div className="abilities-ctx-item" onClick={() => { onOpen('vscode'); onClose() }}>Open in VS Code</div>
        {target.path ? (
          <div className="abilities-ctx-item" onClick={() => { navigator.clipboard.writeText(target.path!); onClose() }}>Copy path</div>
        ) : null}
      </div>
    )
  }

  return (
    <div ref={ref} className="abilities-ctx" style={{ left: x, top: y }}>
      <div className="abilities-ctx-head">{target.kind === 'plugin' ? '🧩' : '🛠'} {target.name}</div>
      {target.toggleable ? (
        target.enabled ? (
          <div className="abilities-ctx-item" onClick={() => { onAction('disable'); onClose() }}>Disable</div>
        ) : (
          <div className="abilities-ctx-item" onClick={() => { onAction('enable'); onClose() }}>Enable</div>
        )
      ) : (
        <div className="abilities-ctx-item disabled">{target.kind === 'skill' ? 'Not a synced skill — can’t toggle' : 'No plugin key — can’t toggle'}</div>
      )}
      {target.path ? (
        <div className="abilities-ctx-item" onClick={() => { navigator.clipboard.writeText(target.path!); onClose() }}>Copy path</div>
      ) : null}
      {target.toggleable ? (
        <div className="abilities-ctx-item danger" onClick={() => { onRemove(); onClose() }}>Remove…</div>
      ) : null}
      <div className="abilities-ctx-note">applies to new Claude sessions</div>
    </div>
  )
}
