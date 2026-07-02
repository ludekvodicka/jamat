import { useEffect, useRef, useState } from 'react'

/**
 * Track a chart container's pixel width via ResizeObserver so the SVG can draw at
 * real device pixels (crisp lines + accurate hover hit-testing) instead of a
 * distorting `preserveAspectRatio="none"` viewBox. Renderer-only DOM observer —
 * NOT main-thread polling.
 */
export function useChartWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect
      if (cr) setWidth(cr.width)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width]
}
