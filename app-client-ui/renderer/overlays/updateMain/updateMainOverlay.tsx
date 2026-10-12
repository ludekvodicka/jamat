import { useEffect, useRef, useState } from 'react'

import type {
  SessionLiveBrief,
  SessionsOpResult,
} from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { IpcResult } from '../../../shared/appClientUiIpc'
import { ErrorText } from '../../../shared/errorText'
import { AppControl } from '../../ipc/appControl'
import { IpcFailure } from '../../ipc/ipcFailure'
import './updateMain.css'

/** An UPDATE the library refused because live sessions work in the main copy; the person confirms them. */
export interface UpdateMainAsk {
  sessionId: string
  sessionTitle: string
  live: readonly SessionLiveBrief[]
}

export interface UpdateMainOpenRequest {
  requestId: number
  ask: UpdateMainAsk
}

/** How a window asks for an UPDATE; a test hands in its own. */
export interface UpdateMainPorts {
  updateMain(sessionId: string, confirmLive?: readonly string[]): Promise<IpcResult<SessionsOpResult<{ sessionId: string; actionId: string }>>>
}

export class UpdateMainAsks {
  /** The live sessions a `live-sessions` refusal names, or null for every other answer. */
  static liveOf(answer: IpcResult<SessionsOpResult<unknown>>): readonly SessionLiveBrief[] | null {
    if (!answer.ok || answer.value.ok || answer.value.code !== 'live-sessions') return null
    return answer.value.liveSessions ?? []
  }

  /** The control API, which every UPDATE of this window goes through. */
  static readonly localPorts: UpdateMainPorts = {
    updateMain: (sessionId, confirmLive) => AppControl.sessions('sessions.updateMain', {
      session: AppControl.sessionOf(sessionId),
      ...(confirmLive === undefined ? {} : { confirmLive: [...confirmLive] }),
    }),
  }
}

/**
 * The confirmation an UPDATE needs while other sessions work in the main copy: it changes files
 * under them. Update names exactly the sessions listed; one started meanwhile refuses it again, and
 * the list then shows it too.
 */
export function UpdateMainOverlay(props: {
  request: UpdateMainOpenRequest
  ports?: UpdateMainPorts
  onClose(): void
}): React.JSX.Element {
  const ports = props.ports ?? UpdateMainAsks.localPorts
  const ask = props.request.ask
  const card = useRef<HTMLDivElement | null>(null)
  const mounted = useRef(false)
  const [live, setLive] = useState<readonly SessionLiveBrief[]>(ask.live)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    mounted.current = true
    const restore = document.activeElement
    card.current?.focus()
    return () => {
      mounted.current = false
      if (restore instanceof HTMLElement) restore.focus()
    }
  }, [])

  const close = (): void => {
    if (!busy) props.onClose()
  }

  const update = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const answer = await ports.updateMain(ask.sessionId, live.map((session) => session.sessionId))
      if (!mounted.current) return
      const again = UpdateMainAsks.liveOf(answer)
      if (again !== null) {
        setLive(again)
        setError('The sessions working in this main copy changed; confirm the list again.')
        setBusy(false)
        return
      }
      const failure = IpcFailure.of(answer, 'Update main copy')
      if (failure !== null) {
        setError(failure)
        setBusy(false)
        return
      }
      props.onClose()
    } catch (thrown: unknown) {
      if (!mounted.current) return
      setError(`Update main copy failed: ${ErrorText.of(thrown)}`)
      setBusy(false)
    }
  }

  return (
    <div
      className="jamat-update-main"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div
        ref={card}
        className="jamat-update-main__card"
        role="dialog"
        aria-modal="true"
        aria-label={`Update the main copy of ${ask.sessionTitle}`}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            close()
          }
        }}
      >
        <header className="jamat-update-main__head">
          <span className="jamat-update-main__title">Update main copy</span>
          <span className="jamat-update-main__session">{ask.sessionTitle}</span>
          <button className="jamat-update-main__close" type="button" aria-label="Close Update main copy" disabled={busy} onClick={close}>
            ×
          </button>
        </header>
        <div className="jamat-update-main__body">
          <p className="jamat-update-main__text">
            {live.length === 1 ? 'This session works' : `These ${live.length} sessions work`} in the main copy. The update
            changes files under {live.length === 1 ? 'it' : 'them'}; a conflict is resolved by Claude and shown as a diff.
          </p>
          <ul className="jamat-update-main__live" aria-label="Live sessions in the main copy">
            {live.map((session) => (
              <li key={session.sessionId}>
                {session.number === null ? '' : <span className="jamat-update-main__number">{session.number}</span>}
                {session.title || session.sessionId}
              </li>
            ))}
          </ul>
          {error !== null && <p className="jamat-update-main__error" role="alert">{error}</p>}
          <div className="jamat-update-main__actions">
            <button
              className="jamat-update-main__button jamat-update-main__button--primary"
              type="button"
              disabled={busy}
              onClick={() => void update()}
            >
              {busy ? 'Working…' : 'Update'}
            </button>
            <button className="jamat-update-main__button" type="button" disabled={busy} onClick={close}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
