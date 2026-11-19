import type { ReactNode } from 'react'
import type { RateWindow } from '../../../lib-orchestrator/rateMonitor/rateMonitorApi.types'
import { UsageModel } from './usageModel'
import './usagePanel.css'

export interface SegmentedOption<T extends string | number> { value: T; label: string }

/** A row of buttons for a short fixed choice; the pressed one is the value. */
export function Segmented<T extends string | number>(props: {
  label: string
  options: readonly SegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
}): React.JSX.Element {
  return <div className="jamat-usage__segmented" role="group" aria-label={props.label}>
    {props.options.map((option) => <button key={option.value} type="button" aria-pressed={option.value === props.value}
      onClick={() => props.onChange(option.value)}>{option.label}</button>)}
  </div>
}

/** One figure: a quiet label, the value, and an optional line under it. */
export function Tile(props: { label: string; value: ReactNode; detail?: ReactNode; tone?: 'ok' | 'warn' | 'danger'; title?: string }): React.JSX.Element {
  return <div className={`jamat-usage__tile${props.tone ? ` jamat-usage__tile--${props.tone}` : ''}`} title={props.title}>
    <span className="jamat-usage__tile-label">{props.label}</span>
    <span className="jamat-usage__tile-value">{props.value}</span>
    {props.detail !== undefined && <span className="jamat-usage__tile-detail">{props.detail}</span>}
  </div>
}

/** The short line beside a name that says which chart line is its. */
export function Swatch({ color }: { color: string }): React.JSX.Element {
  return <span className="jamat-usage__swatch" style={{ background: color }} aria-hidden="true" />
}

/** A used-percent bar coloured by what is left. */
export function Meter(props: { usedPercent: number; label: string }): React.JSX.Element {
  const used = Math.min(100, Math.max(0, props.usedPercent))
  const tone = UsageModel.level(100 - used)
  return <div className={`jamat-usage__meter jamat-usage__meter--${tone}`} role="progressbar" aria-label={props.label}
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(used)}>
    <div style={{ width: `${used}%` }} />
  </div>
}

/** One quota window of one account: the bar, the used percent and when it resets; a missing reading shows only its name. */
export function QuotaWindow(props: { label: string; name: string; window: RateWindow | null; now: number; role?: 'cell' }): React.JSX.Element {
  if (!props.window)
    return <span role={props.role} className="jamat-usage__window jamat-usage__muted" title="No reading">{props.name}</span>
  const reset = props.window.resetsAt === null ? null : new Date(props.window.resetsAt).getTime()
  const title = `${props.window.usedPercent.toFixed(0)}% used${reset === null ? '' : `, resets ${new Date(reset).toLocaleString()}`}`
  return <span role={props.role} className="jamat-usage__window" title={title}>
    <span className="jamat-usage__window-name">{props.name}</span>
    <Meter usedPercent={props.window.usedPercent} label={props.label} />
    <span className="jamat-usage__window-value">{props.window.usedPercent.toFixed(0)}%</span>
    {reset !== null && <span className="jamat-usage__muted">{UsageModel.when(reset, props.now)}</span>}
  </span>
}
