import { useEffect, useRef, useState } from 'react'
import type { DiffGroup, DiffMode, DiffOption } from '../../../../core/types/file-diff'

interface DiffAgainstSelectorProps {
  value: DiffMode
  options: DiffOption[]
  /** Title shown on the button when no option matches `value` (e.g. while loading). */
  fallbackLabel?: string
  loading?: boolean
  /** Renders the button in an "active" state (diff currently applied to file view). */
  active?: boolean
  onChange: (mode: DiffMode) => void
}

function modeKey(mode: DiffMode): string {
  switch (mode.kind) {
    case 'git-head-back':
    case 'session-turn-back':
      return `${mode.kind}:${mode.n}`
    default:
      return mode.kind
  }
}

const GROUP_TITLES: Record<DiffGroup, string> = {
  'working-copy': 'Working copy',
  'claude-session': 'Claude session',
  off: '',
}
// 'off' is rendered as a standalone toolbar button outside this dropdown —
// keep the dropdown focused on actual diff baselines.
const GROUP_ORDER: DiffGroup[] = ['working-copy', 'claude-session']

/**
 * Grouped dropdown for picking the diff baseline ("Diff against ▾"). Button
 * shows the current option's label; clicking opens a popover with sections
 * for git/svn / Claude session / off. Disabled options render grayed with a
 * tooltip carrying the reason. Closes on outside click and Escape.
 */
export function DiffAgainstSelector({
  value,
  options,
  fallbackLabel,
  loading,
  active,
  onChange,
}: DiffAgainstSelectorProps) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current) return
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const currentKey = modeKey(value)
  const currentOption = options.find((o) => modeKey(o.mode) === currentKey)
  const buttonLabel = currentOption?.label ?? fallbackLabel ?? 'Diff against…'

  const grouped: Record<DiffGroup, DiffOption[]> = {
    'working-copy': [],
    'claude-session': [],
    off: [],
  }
  for (const o of options) grouped[o.group].push(o)

  return (
    <div className="diff-against-wrap" ref={wrapRef}>
      <button
        className={`notes-btn file-viewer-mode-btn diff-against-btn${loading ? ' diff-against-btn-loading' : ''}${active ? ' file-viewer-mode-btn-active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={buttonLabel}
        type="button"
      >
        <span className="diff-against-btn-label">
          {loading ? 'Loading…' : active ? `Diff: ${buttonLabel}` : 'Diff against…'}
        </span>
        <span className="diff-against-btn-arrow">▾</span>
      </button>
      {open ? (
        <div className="diff-against-popover" role="menu">
          {GROUP_ORDER.map((group) => {
            const items = grouped[group]
            if (items.length === 0) return null
            return (
              <div key={group} className="diff-against-group">
                {GROUP_TITLES[group] ? (
                  <div className="diff-against-group-title">{GROUP_TITLES[group]}</div>
                ) : null}
                {items.map((opt) => {
                  const key = modeKey(opt.mode)
                  const isCurrent = key === currentKey
                  const disabled = !opt.enabled
                  return (
                    <button
                      key={key}
                      className={`diff-against-item${isCurrent ? ' diff-against-item-current' : ''}${disabled ? ' diff-against-item-disabled' : ''}`}
                      onClick={() => {
                        if (disabled) return
                        onChange(opt.mode)
                        setOpen(false)
                      }}
                      type="button"
                      title={disabled ? opt.reason ?? '' : ''}
                      disabled={disabled}
                    >
                      <span className="diff-against-item-marker">{isCurrent ? '●' : ''}</span>
                      <span className="diff-against-item-label">{opt.label}</span>
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
