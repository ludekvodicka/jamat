import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AccountView } from '../../../../lib-orchestrator/agentAccounts/agentAccountsApi.types'
import { AppControl } from '../../ipc/appControl'
import { ErrorText } from '../../../shared/errorText'
import '../../overlays/sessionDetails/sessionDetails.css'

export function SwitchAccountDialog(props: { sessionId: string; accounts: readonly AccountView[]; onClose(): void }): React.JSX.Element {
  const [accountId, setAccountId] = useState(() => props.accounts.find(account => account.defaultChoice)?.accountId ?? props.accounts[0]?.accountId ?? '')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])
  const submit = async (): Promise<void> => {
    if (running.current || !accountId) return
    running.current = true
    setBusy(true)
    setProblem(null)
    try {
      const result = await AppControl.value('sessions.switchAccount', { session: AppControl.sessionOf(props.sessionId), accountId })
      if (!active.current) return
      if (result.ok) props.onClose()
      else setProblem(result.error)
    } catch (error) { if (active.current) setProblem(ErrorText.of(error)) }
    finally { running.current = false; if (active.current) setBusy(false) }
  }
  const close = (): void => { if (!running.current) props.onClose() }
  return createPortal(<div className="jamat-session-details" onMouseDown={event => { if (event.target === event.currentTarget) close() }}>
    <div className="jamat-session-details__card" role="dialog" aria-modal="true" aria-label="Continue on another account"
      onKeyDown={event => {
        event.stopPropagation()
        if (event.key === 'Escape') { event.preventDefault(); close() }
        else if (event.key === 'Tab') {
          const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('select:not(:disabled), button:not(:disabled)')]
          const index = controls.indexOf(document.activeElement as HTMLElement)
          if (controls.length > 0) {
            event.preventDefault()
            controls[(index + (event.shiftKey ? controls.length - 1 : 1)) % controls.length]?.focus()
          }
        }
      }}>
      <header className="jamat-session-details__head"><span className="jamat-session-details__title">Continue on another account</span></header>
      <div className="jamat-session-details__body">
        <p>The session will restart and resume the same conversation on the selected account.</p>
        <label className="jamat-session-details__field">Account
          <select autoFocus aria-label="Account" value={accountId} disabled={busy} onChange={event => setAccountId(event.target.value)}>
            {props.accounts.map(account => <option key={account.accountId} value={account.accountId}>{account.label}</option>)}
          </select>
        </label>
        {problem && <p className="jamat-session-details__error" role="alert">{problem}</p>}
        <div className="jamat-session-details__actions">
          <button className="jamat-session-details__button jamat-session-details__button--primary" type="button" disabled={busy || !accountId} onClick={() => void submit()}>Continue</button>
          <button className="jamat-session-details__button" type="button" disabled={busy} onClick={close}>Cancel</button>
        </div>
      </div>
    </div>
  </div>, document.body)
}
