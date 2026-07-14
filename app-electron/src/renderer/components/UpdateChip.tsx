/**
 * Status-bar update indicator — the answer to "I clicked check, it said there's a new version, and
 * nothing happened". Every phase the update module can be in is visible here: the download's progress,
 * the ready-to-install build (with the button that installs it), and the failure that used to be
 * silent. Renders NOTHING while idle — an app with no update pending shows no chip at all.
 */
import { useEffect, useState } from 'react'
import type { UpdateStatus } from '../../../../core/update/update-status.types'

function fmtMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function UpdateChip() {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    void window.electronAPI?.getUpdateStatus?.().then(setStatus).catch(() => {})
    return window.electronAPI?.onUpdateStatus?.(setStatus)
  }, [])

  if (!status) return null
  const { phase, progress, pendingVersion, lastError, channel } = status
  if (phase === 'idle' || phase === 'checking') return null

  if (phase === 'downloading') {
    const pct = progress?.percent ?? 0
    return (
      <span
        className="status-item update-chip"
        title={progress
          ? `Downloading Jamat ${progress.version}\n${fmtMB(progress.transferred)} of ${fmtMB(progress.total)} · ${fmtMB(progress.bytesPerSecond)}/s`
          : 'Downloading update…'}
      >
        ⬇ {progress?.version ?? 'update'} · {pct}%
        <span className="update-progress"><span className="update-progress-fill" style={{ width: `${pct}%` }} /></span>
      </span>
    )
  }

  if (phase === 'ready') {
    // Source checkout: the newer build is on disk, a restart (which recompiles) loads it. Installed
    // build: the release is downloaded and the installer runs on restart. Same button, different verb.
    const isSource = channel === 'source'
    return (
      <span
        className="status-item update-chip update-chip-ready"
        title={isSource
          ? `A newer build (${pendingVersion}) is on disk — restarting loads it.`
          : `Jamat ${pendingVersion} is downloaded and installs on restart.`}
      >
        {isSource ? `New build ${pendingVersion} on disk` : `New version ${pendingVersion} ready`}
        <button
          className="status-btn"
          disabled={installing}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            setInstalling(true)
            void window.electronAPI?.installUpdate?.()
              .catch(() => {})
              .finally(() => setInstalling(false))
          }}
        >
          {isSource ? 'Restart' : 'Update'}
        </button>
      </span>
    )
  }

  if (phase === 'error')
    return (
      <span
        className="status-item update-chip update-chip-error"
        title={`Update failed: ${lastError ?? 'unknown error'}\n\nClick to try again.`}
        style={{ cursor: 'pointer' }}
        onClick={() => { void window.electronAPI?.checkForUpdates?.().catch(() => {}) }}
      >
        ⚠ Update failed
      </span>
    )

  throw new Error(`Unknown update phase: ${JSON.stringify(phase)}`)
}
