import { useEffect } from 'react'
import { createPortal } from 'react-dom'

interface Props {
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/** Minimal portal confirm modal for destructive actions (mirrors CustomTab's inline modal).
 *  Backdrop click + Escape cancel; the confirm button carries the danger styling. */
export function ConfirmDialog({ title, message, confirmLabel = 'Confirm', danger, onConfirm, onCancel }: Props) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onCancel])

  return createPortal(
    <div className="abilities-confirm-backdrop" onClick={onCancel}>
      <div className="abilities-confirm" onClick={(e) => e.stopPropagation()}>
        <div className="abilities-confirm-title">{title}</div>
        <div className="abilities-confirm-msg">{message}</div>
        <div className="abilities-confirm-actions">
          <button className="abilities-confirm-cancel" onClick={onCancel}>Cancel</button>
          <button className={danger ? 'abilities-confirm-ok danger' : 'abilities-confirm-ok'} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
