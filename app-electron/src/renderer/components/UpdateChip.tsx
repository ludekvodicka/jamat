/**
 * Status-bar update indicator — the small, always-visible half of the update UI (the dialog is the
 * other half). It renders NOTHING while idle; every other phase is one click away from the dialog,
 * which is where the actual work is watched.
 */
import { useEffect, useState } from 'react'
import type { UpdateStatus } from '../../../../core/update/update-status.types'
import { OPEN_UPDATE_DIALOG_EVENT } from './UpdateDialog'

export function UpdateChip() {
  const [status, setStatus] = useState<UpdateStatus | null>(null)

  useEffect(() => {
    void window.electronAPI?.getUpdateStatus?.().then(setStatus).catch(() => {})
    return window.electronAPI?.onUpdateStatus?.(setStatus)
  }, [])

  if (!status) return null
  const { phase, progress, pendingVersion, lastError, channel } = status
  if (phase === 'idle' || phase === 'checking') return null

  const openDialog = () => window.dispatchEvent(new CustomEvent(OPEN_UPDATE_DIALOG_EVENT))
  const isSource = channel === 'source'

  if (phase === 'downloading') {
    const pct = progress?.percent ?? 0
    return (
      <span
        className="status-item update-chip"
        style={{ cursor: 'pointer' }}
        title={`Downloading Jamat ${progress?.version ?? ''} — click to watch`}
        onClick={openDialog}
      >
        ⬇ {progress?.version ?? 'update'} · {pct}%
        <span className="update-progress"><span className="update-progress-fill" style={{ width: `${pct}%` }} /></span>
      </span>
    )
  }

  if (phase === 'installing')
    return (
      <span className="status-item update-chip update-chip-ready" title="Jamat is closing to finish the update">
        {isSource ? 'Restarting…' : 'Installing…'}
      </span>
    )

  if (phase === 'available')
    return (
      <span
        className="status-item update-chip update-chip-ready"
        style={{ cursor: 'pointer' }}
        title={isSource
          ? `A newer build (${pendingVersion}) is on disk — click to restart into it.`
          : `Jamat ${pendingVersion} is available — click to download and install it.`}
        onClick={openDialog}
      >
        {isSource ? `New build ${pendingVersion} on disk` : `New version ${pendingVersion} available`}
        <button
          className="status-btn"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); openDialog() }}
        >
          {isSource ? 'Restart' : 'Update'}
        </button>
      </span>
    )

  if (phase === 'error')
    return (
      <span
        className="status-item update-chip update-chip-error"
        style={{ cursor: 'pointer' }}
        title={`Update failed: ${lastError ?? 'unknown error'}\n\nClick for details.`}
        onClick={openDialog}
      >
        ⚠ Update failed
      </span>
    )

  throw new Error(`Unknown update phase: ${JSON.stringify(phase)}`)
}
