import { modelRates } from '../../../../../../core/pricing'
import { shortModel } from './format'

/** Model name chip with a per-1M pricing tooltip (reuses the canonical pricing.ts rates). */
export function ModelChip({ model, color }: { model: string; color?: string }) {
  const r = modelRates(model)
  const title = r
    ? `${model}\ninput $${r.input}/M · output $${r.output}/M · cache-write $${r.cacheCreate}/M · cache-read $${r.cacheRead}/M`
    : model
  return (
    <span className="usage-model-chip" title={title}>
      {color && <span className="usage-chart-dot" style={{ background: color }} />}
      {shortModel(model)}
    </span>
  )
}
