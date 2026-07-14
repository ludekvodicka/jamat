/**
 * The update dialog — one window that carries the WHOLE update: the offer, the download (with a real
 * progress bar), the hand-off to the installer, and any failure. It replaces a native message box that
 * could show none of that: the old flow downloaded 128 MB unasked, then asked, and the user's click was
 * followed by 10–20 silent seconds of teardown + installer hand-off. Now the order matches what a
 * person expects — ask, then work where they can watch it.
 *
 * It opens by itself when main offers an update (`update:prompt`), and can be opened from the status-bar
 * chip at any time (the `OPEN_UPDATE_DIALOG_EVENT`).
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { UpdatePrompt, UpdateStatus } from '../../../../core/update/update-status.types'

export const OPEN_UPDATE_DIALOG_EVENT = 'jamat:open-update-dialog'

const SNOOZE_HOURS = [1, 2, 4, 12]

function fmtMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function UpdateDialog() {
  const [prompt, setPrompt] = useState<UpdatePrompt | null>(null)
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [open, setOpen] = useState(false)
  const [snoozeHours, setSnoozeHours] = useState(SNOOZE_HOURS[0])

  useEffect(() => {
    void window.electronAPI?.getUpdateStatus?.().then(setStatus).catch(() => {})
    const offStatus = window.electronAPI?.onUpdateStatus?.(setStatus)
    const offPrompt = window.electronAPI?.onUpdatePrompt?.((p) => { setPrompt(p); setOpen(true) })
    const onOpen = () => setOpen(true)
    window.addEventListener(OPEN_UPDATE_DIALOG_EVENT, onOpen)
    return () => {
      offStatus?.()
      offPrompt?.()
      window.removeEventListener(OPEN_UPDATE_DIALOG_EVENT, onOpen)
    }
  }, [])

  if (!open || !status) return null
  const { phase, progress, pendingVersion, lastError, running, channel } = status
  const version = prompt?.version ?? pendingVersion ?? ''
  const isSource = (prompt?.channel ?? channel) === 'source'

  // An answered prompt is spent — a stale copy would otherwise re-arm the buttons mid-download.
  const answer = (choice: Parameters<NonNullable<typeof window.electronAPI.answerUpdatePrompt>>[0], keepOpen: boolean) => {
    setPrompt(null)
    if (!keepOpen) setOpen(false)
    void window.electronAPI?.answerUpdatePrompt?.(choice).catch(() => {})
  }

  const body = () => {
    if (phase === 'downloading') {
      const pct = progress?.percent ?? 0
      return (
        <>
          <div className="update-dialog-msg">Downloading Jamat {progress?.version ?? version}…</div>
          <div className="update-dialog-bar"><span className="update-dialog-bar-fill" style={{ width: `${pct}%` }} /></div>
          <div className="update-dialog-meta">
            {pct}% · {fmtMB(progress?.transferred ?? 0)} of {fmtMB(progress?.total ?? 0)}
            {progress?.bytesPerSecond ? ` · ${fmtMB(progress.bytesPerSecond)}/s` : ''}
          </div>
          <div className="update-dialog-meta">The installer starts as soon as the download finishes.</div>
          <div className="update-dialog-actions">
            <button className="abilities-confirm-cancel" onClick={() => setOpen(false)}>Hide</button>
          </div>
        </>
      )
    }

    if (phase === 'installing')
      return (
        <>
          <div className="update-dialog-msg">
            {isSource ? `Restarting into build ${version}…` : `Installing Jamat ${version}…`}
          </div>
          <div className="update-dialog-bar"><span className="update-dialog-bar-fill indeterminate" /></div>
          <div className="update-dialog-meta">
            {isSource
              ? 'Jamat is closing and will start again on the new build.'
              : 'Jamat is closing and the installer takes over. This can take up to a minute.'}
          </div>
        </>
      )

    if (phase === 'error')
      return (
        <>
          <div className="update-dialog-msg update-dialog-error">The update failed.</div>
          <div className="update-dialog-meta update-dialog-reason">{lastError ?? 'unknown error'}</div>
          <div className="update-dialog-actions">
            <button className="abilities-confirm-cancel" onClick={() => setOpen(false)}>Close</button>
            <button className="abilities-confirm-ok" onClick={() => { void window.electronAPI?.checkForUpdates?.().catch(() => {}) }}>Try again</button>
          </div>
        </>
      )

    if (phase === 'available') {
      // Without an open prompt (dialog opened from the chip) the consent goes through update:install —
      // the same path, minus the gate's snooze bookkeeping.
      const consent = () => prompt
        ? answer({ kind: 'action' }, true)
        : (setPrompt(null), void window.electronAPI?.installUpdate?.().catch(() => {}))
      return (
        <>
          <div className="update-dialog-msg">
            {isSource ? `A newer build is on disk (${version}).` : `Jamat ${version} is available.`}
          </div>
          <div className="update-dialog-meta">Running: {running} → New: {version}</div>
          {prompt?.busy && (
            <div className="update-dialog-meta update-dialog-busy">
              Restarting closes these terminals — some are still working:
              <pre>{prompt.busy}</pre>
            </div>
          )}
          <div className="update-dialog-meta">
            {isSource
              ? 'Restarting loads it (the launcher recompiles).'
              : 'The download starts when you accept, and its progress is shown here.'}
          </div>
          <div className="update-dialog-actions">
            {prompt && (
              <>
                <select
                  className="update-dialog-snooze"
                  value={snoozeHours}
                  onChange={(e) => setSnoozeHours(Number(e.target.value))}
                  title="Ask again later"
                >
                  {SNOOZE_HOURS.map((h) => <option key={h} value={h}>in {h}h</option>)}
                </select>
                <button className="abilities-confirm-cancel" onClick={() => answer({ kind: 'snooze', hours: snoozeHours }, false)}>Later</button>
              </>
            )}
            {!prompt && <button className="abilities-confirm-cancel" onClick={() => setOpen(false)}>Close</button>}
            <button className="abilities-confirm-ok" onClick={consent}>
              {prompt?.actionLabel ?? (isSource ? 'Restart now' : 'Download & install')}
            </button>
          </div>
        </>
      )
    }

    // idle / checking — only reachable when opened by hand from the chip.
    return (
      <>
        <div className="update-dialog-msg">{phase === 'checking' ? 'Checking for updates…' : `Jamat is up to date (${running}).`}</div>
        <div className="update-dialog-actions">
          <button className="abilities-confirm-cancel" onClick={() => setOpen(false)}>Close</button>
        </div>
      </>
    )
  }

  return createPortal(
    <div className="abilities-confirm-backdrop">
      <div className="abilities-confirm update-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="abilities-confirm-title">{isSource ? 'New build available' : 'Software update'}</div>
        {body()}
      </div>
    </div>,
    document.body,
  )
}
