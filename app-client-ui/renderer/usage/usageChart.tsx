import { useEffect, useRef, useState } from 'react'
import type { View } from 'vega'
import type { TopLevelSpec } from 'vega-lite'
import type { UsageChartTheme } from './poolGraphSpec'

export function usageChartTheme(): UsageChartTheme {
  const style = getComputedStyle(document.documentElement)
  return { text: style.getPropertyValue('--color-text-2').trim(), grid: style.getPropertyValue('--color-border-frame').trim(),
    accent: style.getPropertyValue('--color-accent').trim() }
}

export function UsageChart({ spec, label }: { spec: TopLevelSpec; label: string }): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let disposed = false
    let view: View | null = null
    let observer: ResizeObserver | null = null
    setError(null)
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
      observer = new ResizeObserver(() => {
        if (!disposed && container.current && view)
          void view.width(Math.max(200, container.current.clientWidth - 70)).runAsync().catch(error => { if (!disposed) setError(String(error)) })
      })
      observer.observe(container.current)
    }).catch(error => { if (!disposed) setError(String(error)) })
    return () => { disposed = true; observer?.disconnect(); view?.finalize() }
  }, [spec])
  return <div>{error && <p role="alert">{error}</p>}<div className="jamat-usage__graph" role="img" aria-label={label} ref={container} /></div>
}
