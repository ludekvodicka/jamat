/**
 * The update dialog — one window that carries the whole update: the offer, the download (with a real
 * progress bar), the hand-off to the installer, and any failure.
 *
 * The PROMPT, not the phase, decides whether the answer buttons are shown. Main blocks on the answer,
 * so a prompt rendered as anything else (an `error` body, an "up to date" body) is an offer the user
 * cannot answer — which wedges the gate and kills every later offer for the session.
 *
 * It opens by itself when main offers an update (`update:prompt`), and can be opened from the
 * status-bar chip at any time (`OPEN_UPDATE_DIALOG_EVENT`).
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { SNOOZE_HOURS } from '../../../../core/update/update-const'
import type { UpdateChoice, UpdatePrompt, UpdateStatus } from '../../../../core/update/update-status.types'

export const OPEN_UPDATE_DIALOG_EVENT = 'jamat:open-update-dialog'

function fmtMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function UpdateDialog() {
  const [prompt, setPrompt] = useState<UpdatePrompt | null>(null)
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [open, setOpen] = useState(false)
  const [snoozeHours, setSnoozeHours] = useState<number>(SNOOZE_HOURS[0])

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
  const { phase, progress, pendingVersion, lastError, running, channel, busy } = status
  const version = prompt?.version ?? pendingVersion ?? ''
  const isSource = (prompt?.channel ?? channel) === 'source'

  // An answered prompt is spent — a stale copy would re-arm the buttons mid-download.
  const answer = (choice: UpdateChoice, keepOpen: boolean) => {
    setPrompt(null)
    if (!keepOpen) setOpen(false)
    void window.electronAPI?.answerUpdatePrompt?.(choice).catch(() => {})
  }

  const busyBlock = (list: string) => (
    <div className="update-dialog-meta update-dialog-busy">
      Restarting closes these terminals — some are still working:
      <pre>{list}</pre>
    </div>
  )

  /** The offer: main is waiting for an answer, so this wins over whatever the phase says. */
  const offerBody = (p: UpdatePrompt) => (
    <>
      <div className="update-dialog-msg">
        {p.channel === 'source' ? `A newer build is on disk (${p.version}).` : `Jamat ${p.version} is available.`}
      </div>
      <div className="update-dialog-meta">Running: {p.running} → New: {p.version}</div>
      {p.busy && busyBlock(p.busy)}
      <div className="update-dialog-meta">
        {p.channel === 'source'
          ? 'Restarting loads it (the launcher recompiles).'
          : p.actionLabel.startsWith('Restart')
            ? 'It is already downloaded — the installer runs after the restart.'
            : 'The download starts when you accept, and its progress is shown here.'}
      </div>
      <div className="update-dialog-actions">
        <select
          className="update-dialog-snooze"
          value={snoozeHours}
          onChange={(e) => setSnoozeHours(Number(e.target.value))}
          title="Ask again later"
        >
          {SNOOZE_HOURS.map((h) => <option key={h} value={h}>in {h}h</option>)}
        </select>
        <button className="abilities-confirm-cancel" onClick={() => answer({ kind: 'snooze', hours: snoozeHours }, false)}>Later</button>
        <button className="abilities-confirm-ok" onClick={() => answer({ kind: 'action' }, true)}>{p.actionLabel}</button>
      </div>
    </>
  )

  const phaseBody = () => {
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
          <div className="update-dialog-meta">The install follows as soon as the download finishes.</div>
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
            <button
              className="abilities-confirm-ok"
              // A known version means the DOWNLOAD failed — retry that, not the check (which would
              // just find the same release again).
              onClick={() => {
                const retry = pendingVersion ? window.electronAPI?.installUpdate?.() : window.electronAPI?.checkForUpdates?.()
                void retry?.catch(() => {})
              }}
            >
              Try again
            </button>
          </div>
        </>
      )

    if (phase === 'available' || phase === 'ready') {
      // Opened from the chip: no prompt behind it, so consent goes through update:install. The busy
      // warning still shows — it comes from the status, not from the prompt.
      const downloaded = phase === 'ready'
      return (
        <>
          <div className="update-dialog-msg">
            {isSource ? `A newer build is on disk (${version}).` : `Jamat ${version} is ${downloaded ? 'downloaded' : 'available'}.`}
          </div>
          <div className="update-dialog-meta">Running: {running} → New: {version}</div>
          {busy && busyBlock(busy)}
          <div className="update-dialog-meta">
            {isSource
              ? 'Restarting loads it (the launcher recompiles).'
              : downloaded
                ? 'It installs on the restart.'
                : 'The download starts when you accept, and its progress is shown here.'}
          </div>
          <div className="update-dialog-actions">
            <button className="abilities-confirm-cancel" onClick={() => setOpen(false)}>Close</button>
            <button className="abilities-confirm-ok" onClick={() => { void window.electronAPI?.installUpdate?.().catch(() => {}) }}>
              {isSource || downloaded ? 'Restart & install' : 'Download & install'}
            </button>
          </div>
        </>
      )
    }

    if (phase === 'checking' || phase === 'idle')
      return (
        <>
          <div className="update-dialog-msg">{phase === 'checking' ? 'Checking for updates…' : `Jamat is up to date (${running}).`}</div>
          <div className="update-dialog-actions">
            <button className="abilities-confirm-cancel" onClick={() => setOpen(false)}>Close</button>
          </div>
        </>
      )

    throw new Error(`Unknown update phase: ${JSON.stringify(phase)}`)
  }

  return createPortal(
    <div className="abilities-confirm-backdrop">
      <div className="abilities-confirm update-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="abilities-confirm-title">{isSource ? 'New build available' : 'Software update'}</div>
        {prompt ? offerBody(prompt) : phaseBody()}
      </div>
    </div>,
    document.body,
  )
}
