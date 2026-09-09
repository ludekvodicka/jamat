import type { IDockviewPanelProps } from 'dockview'
import { useCallback, useLayoutEffect, useRef } from 'react'

export interface PanelParametersHandle {
  current(): Record<string, unknown>
  update(next: Record<string, unknown>): void
}

export function usePanelParameters(props: IDockviewPanelProps): PanelParametersHandle {
  const api = props.api
  const live = useRef(PanelParametersShape.of(props.params))

  useLayoutEffect(() => {
    live.current = PanelParametersShape.of(props.params)
  }, [props.params])

  useLayoutEffect(() => {
    const disposable = api.onDidParametersChange((patch) => {
      live.current = PanelParametersShape.applied(live.current, patch)
    })
    return () => disposable.dispose()
  }, [api])

  return {
    current: useCallback(() => live.current, []),
    update: useCallback((next: Record<string, unknown>): void => {
      const stored = PanelParametersShape.of(next)
      live.current = stored
      api.updateParameters(stored)
    }, [api]),
  }
}

class PanelParametersShape {
  static of(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object'
      ? { ...value as Record<string, unknown> }
      : {}
  }

  static applied(current: Record<string, unknown>, patch: unknown): Record<string, unknown> {
    const values = PanelParametersShape.of(patch)
    const next = { ...current, ...values }
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined)
        delete next[key]
    }
    return next
  }
}
