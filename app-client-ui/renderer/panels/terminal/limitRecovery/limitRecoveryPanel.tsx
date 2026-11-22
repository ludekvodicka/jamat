import { useEffect, useState } from 'react'

import type {
  LimitRecoveryAction,
  SessionLimitRecoveryInfo,
} from '../../../../../lib-orchestrator/limitRecovery/limitRecoveryApi.types'
import { LimitRecoveryText } from './limitRecoveryText'
import './limitRecoveryPanel.css'

/**
 * The usage-limit popup of one terminal tab. It draws the state the orchestrator owns and ticks its
 * own clock for the countdown; `act` is absent on a remote tab, whose computer runs the recovery.
 */
export function LimitRecoveryPanel(props: {
  info: SessionLimitRecoveryInfo
  act?: (action: LimitRecoveryAction) => Promise<string | null>
}): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => setError(null), [props.info.state])
  const view = LimitRecoveryText.of(props.info, now)
  const act = props.act
  const press = async (action: LimitRecoveryAction): Promise<void> => {
    if (act === undefined) return
    setBusy(true)
    try { setError(await act(action)) }
    finally { setBusy(false) }
  }
  return (
    <div className="jamat-limit-recovery" role="alertdialog" aria-label="Usage limit" data-limit-recovery={props.info.state}>
      <p className="jamat-limit-recovery__title">{view.title}</p>
      {view.lines.map((line) => <p className="jamat-limit-recovery__line" key={line}>{line}</p>)}
      {act !== undefined && view.buttons.length > 0 && (
        <div className="jamat-limit-recovery__actions">
          {view.buttons.map((button) => (
            <button className="jamat-limit-recovery__button" type="button" key={button.action} disabled={busy}
              onClick={() => void press(button.action)}>{button.label}</button>
          ))}
        </div>
      )}
      {error !== null && <p className="jamat-limit-recovery__error">{error}</p>}
    </div>
  )
}
