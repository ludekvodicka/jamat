import type { ReactNode } from 'react'
import { UsageModel } from './usageModel'

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

/** A used-percent bar coloured by what is left. */
export function Meter(props: { usedPercent: number; label: string }): React.JSX.Element {
  const used = Math.min(100, Math.max(0, props.usedPercent))
  const tone = UsageModel.level(100 - used)
  return <div className={`jamat-usage__meter jamat-usage__meter--${tone}`} role="progressbar" aria-label={props.label}
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(used)}>
    <div style={{ width: `${used}%` }} />
  </div>
}
