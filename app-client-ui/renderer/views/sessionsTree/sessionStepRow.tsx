import { useEffect, useState } from 'react'

import { ScriptDuration } from '../../../../lib-orchestrator/sessionManager/scripts/scriptDuration'
import type { SessionStepInfo } from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { SignalGlyph } from '../../widgets/signalGlyph'
import { SessionNodeState } from './sessionNodeState'

/**
 * What this client does for a session now, drawn as the first row under it: the library's text, its
 * detail muted, the seconds since the step began, and a thin bar when the library counted a total.
 * Every word is the library's; the row adds only the running glyph, the ticking seconds and the bar's
 * width.
 */
export function SessionStepRow(props: { step: SessionStepInfo }): React.JSX.Element {
  const { step } = props
  const fraction = SessionStepRows.fractionOf(step)
  const paint = SessionNodeState.runPaintOf('running')
  return (
    <div className="jamat-sessions__step" title={step.detail === null ? step.text : `${step.text}\n${step.detail}`}>
      <span className={`jamat-sessions__glyph jamat-sessions__glyph--paint-${paint}`} data-paint={paint} aria-hidden="true">
        <SignalGlyph glyph={SessionNodeState.runCharacterOf('running')} />
      </span>
      <span className="jamat-sessions__step-text">{step.text}</span>
      {step.detail !== null && <span className="jamat-sessions__step-detail">{step.detail}</span>}
      {step.startedAt !== null && <StepElapsed key={step.startedAt} startedAt={step.startedAt} />}
      {fraction !== null && (
        <span className="jamat-sessions__step-bar" aria-hidden="true">
          <span className="jamat-sessions__step-fill" style={{ '--step-fraction': fraction } as React.CSSProperties} />
        </span>
      )}
    </div>
  )
}

/**
 * The seconds since `startedAt`, ticked here once a second. The clock is this span's own state, so a
 * tick re-renders the span alone and never the tree or the snapshot; the key on `startedAt` makes a
 * new step a new span that counts again from `0 s`.
 */
function StepElapsed(props: { startedAt: number }): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [])
  return <span className="jamat-sessions__step-elapsed">{ScriptDuration.elapsedText(now - props.startedAt)}</span>
}

export class SessionStepRows {
  /** The share of the bar that is done, or null where no total was counted and no bar is drawn. */
  static fractionOf(step: SessionStepInfo): number | null {
    const progress = step.progress
    if (progress === null || progress.total === null || progress.total === 0) return null
    return Math.min(1, Math.max(0, progress.done / progress.total))
  }
}
