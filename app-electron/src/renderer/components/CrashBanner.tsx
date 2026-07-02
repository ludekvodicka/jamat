import { useEffect, useState } from 'react'

interface CrashState {
  exitCode: number
  canResume: boolean
  crashCount: number
}

/**
 * Inline overlay shown when a Claude PTY exits unexpectedly. Sits above
 * the xterm container so the user can resume in-place rather than
 * losing context to the menu fallback. The toast in
 * `useTaskNotifications` still fires alongside this for cross-tab
 * awareness.
 *
 * Hidden by default; surfaces only when a `pty:crash` event arrives
 * for our `terminalId`. Auto-hides on:
 *   - successful resume (data starts flowing again from the new PTY)
 *   - manual dismiss
 *   - terminalId change (component remount)
 */
export function CrashBanner({ terminalId }: { terminalId: string }) {
  const [crash, setCrash] = useState<CrashState | null>(null)
  const [resuming, setResuming] = useState(false)
  const [resumeError, setResumeError] = useState<string | null>(null)

  useEffect(() => {
    const removeCrashListener = window.electronAPI?.onTerminalCrash?.((id, code, canResume, crashCount) => {
      if (id !== terminalId) return
      setCrash({ exitCode: code, canResume, crashCount })
      setResumeError(null)
      setResuming(false)
    })
    // Hide banner once new PTY data starts streaming — the resume
    // succeeded and Claude is talking again.
    const removeDataListener = window.electronAPI?.onTerminalData?.((id, _data) => {
      if (id !== terminalId) return
      setCrash(null)
    })
    return () => {
      removeCrashListener?.()
      removeDataListener?.()
    }
  }, [terminalId])

  if (!crash) return null

  const onResume = async () => {
    setResuming(true)
    setResumeError(null)
    const res = await window.electronAPI?.resumeCrashedSession?.(terminalId)
    if (!res?.ok) {
      setResumeError(res?.error ?? 'resume failed')
      setResuming(false)
    }
    // On success, onTerminalData will fire and clear the banner.
  }

  const onDismiss = () => setCrash(null)

  return (
    <div className="crash-banner" role="alert">
      <div className="crash-banner-icon">⚠</div>
      <div className="crash-banner-body">
        <div className="crash-banner-title">
          Claude crashed (exit code {crash.exitCode})
          {crash.crashCount > 1 ? ` · ${crash.crashCount} crashes` : ''}
        </div>
        {!crash.canResume ? (
          <div className="crash-banner-message">
            Too many crashes in a short window. Check your network / auth and close this tab.
          </div>
        ) : (
          <div className="crash-banner-message">
            Click Resume to respawn Claude with the same project / session.
          </div>
        )}
        {resumeError && <div className="crash-banner-error">{resumeError}</div>}
      </div>
      <div className="crash-banner-actions">
        {crash.canResume && (
          <button className="notes-btn notes-btn-primary" onClick={onResume} disabled={resuming}>
            {resuming ? 'Resuming…' : 'Resume'}
          </button>
        )}
        <button className="notes-btn" onClick={onDismiss}>Dismiss</button>
      </div>
    </div>
  )
}
