import { useEffect, useRef, useState } from 'react'
import type { View } from 'vega'
import type { TopLevelSpec } from 'vega-lite'
import type { UsageChartTheme } from './poolGraphSpec'

/** What the hover line says about one x value. */
export interface ChartReadout { title: string; detail?: string; rows: readonly { label: string; value: string }[] }
export type ChartReadoutOf = (x: number | string) => ChartReadout | null

/** The part of a Vega scale this chart reads: continuous (time, quantity) or band (ordinal bars). */
export interface ChartScale {
  (value: unknown): number
  range(): number[]
  domain(): unknown[]
  invert?(position: number): Date | number
  bandwidth?(): number
  step?(): number
}

interface Hover { left: number; top: number; height: number; flip: boolean; readout: ChartReadout }

export function usageChartTheme(): UsageChartTheme {
  const style = getComputedStyle(document.documentElement)
  return { text: style.getPropertyValue('--color-text-2').trim(), grid: style.getPropertyValue('--color-border-frame').trim(),
    accent: style.getPropertyValue('--color-accent').trim() }
}

/**
 * The x value under a pointer at `position` pixels into the plot, and where its line goes: the
 * pointer itself on a time axis, the middle of the bar on a band axis. Null outside the plot.
 */
export function chartHoverPoint(scale: ChartScale, position: number): { value: number | string; at: number } | null {
  const [start, end] = scale.range()
  if (position < Math.min(start, end) || position > Math.max(start, end)) return null
  if (scale.bandwidth && scale.step) {
    const band = scale.bandwidth(), gap = (scale.step() - band) / 2
    const hit = scale.domain().find(value => position >= scale(value) - gap && position < scale(value) + band + gap)
    return typeof hit === 'string' || typeof hit === 'number' ? { value: hit, at: scale(hit) + band / 2 } : null
  }
  if (scale.invert)
    return { value: Number(scale.invert(position)), at: position }
  throw new Error('The x scale is neither a band nor an invertible scale')
}

export function UsageChart({ spec, label, readout }: { spec: TopLevelSpec; label: string; readout?: ChartReadoutOf }): React.JSX.Element {
  const frame = useRef<HTMLDivElement>(null)
  const container = useRef<HTMLDivElement>(null)
  const current = useRef<View | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hover, setHover] = useState<Hover | null>(null)
  useEffect(() => {
    let disposed = false
    let view: View | null = null
    let observer: ResizeObserver | null = null
    setError(null)
    setHover(null)
    // The interpreter, not Vega's default code generator: the workspace CSP has no 'unsafe-eval'.
    void Promise.all([import('vega-lite'), import('vega'), import('vega-interpreter')]).then(async ([lite, vega, interpreter]) => {
      if (disposed || !container.current) return
      const loader = vega.loader()
      loader.load = () => Promise.reject(new Error('External chart resources are disabled'))
      loader.sanitize = () => Promise.reject(new Error('External chart resources are disabled'))
      view = new vega.View(vega.parse(lite.compile(spec).spec, undefined, { ast: true }),
        { renderer: 'svg', loader, expr: interpreter.expressionInterpreter })
        .initialize(container.current).width(Math.max(200, container.current.clientWidth - 70))
      await view.runAsync()
      if (disposed) return
      current.current = view
      observer = new ResizeObserver(() => {
        if (!disposed && container.current && view) {
          setHover(null)
          void view.width(Math.max(200, container.current.clientWidth - 70)).runAsync().catch(error => { if (!disposed) setError(String(error)) })
        }
      })
      observer.observe(container.current)
    }).catch(error => { if (!disposed) setError(String(error)) })
    return () => { disposed = true; current.current = null; observer?.disconnect(); view?.finalize() }
  }, [spec])

  const track = (event: React.PointerEvent): void => {
    const view = current.current, svg = container.current?.querySelector('svg'), box = frame.current
    if (!readout || !view || !svg || !box) return
    // The plot starts at the view's origin inside its padding; both come from Vega, not the DOM.
    const [originX, originY] = view.origin()
    const padding = view.padding()
    const left = svg.getBoundingClientRect().left - box.getBoundingClientRect().left + originX + (typeof padding === 'number' ? padding : padding.left ?? 0)
    const top = svg.getBoundingClientRect().top - box.getBoundingClientRect().top + originY + (typeof padding === 'number' ? padding : padding.top ?? 0)
    const point = chartHoverPoint(view.scale('x') as ChartScale, event.clientX - box.getBoundingClientRect().left - left)
    const content = point && readout(point.value)
    if (!point || !content) { setHover(null); return }
    const [bottom, upper] = (view.scale('y') as ChartScale).range()
    setHover({ left: left + point.at, top: top + Math.min(bottom, upper), height: Math.abs(bottom - upper), flip: left + point.at > box.clientWidth / 2, readout: content })
  }

  return <div>{error && <p role="alert">{error}</p>}
    <div className="jamat-usage__plot" ref={frame} onPointerMove={track} onPointerLeave={() => setHover(null)}>
      <div className="jamat-usage__graph" role="img" aria-label={label} ref={container} />
      {hover && <>
        <div className="jamat-usage__hover-rule" style={{ left: hover.left, top: hover.top, height: hover.height }} />
        <div role="tooltip" className={`jamat-usage__hover-box${hover.flip ? ' jamat-usage__hover-box--flip' : ''}`} style={{ left: hover.left, top: hover.top }}>
          <div className="jamat-usage__hover-title">{hover.readout.title}{hover.readout.detail && <span className="jamat-usage__muted"> · {hover.readout.detail}</span>}</div>
          {hover.readout.rows.map(row => <div key={row.label} className="jamat-usage__hover-row"><span className="jamat-usage__muted">{row.label}</span><span>{row.value}</span></div>)}
        </div>
      </>}
    </div>
  </div>
}
