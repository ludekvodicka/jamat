import { useEffect, useLayoutEffect, useRef } from 'react'

/**
 * How much larger one open document is drawn than every other one in the window.
 *
 * A multiplier over the configured size rather than a size of its own: `ui.fileViewerFontScalePercent`
 * says how big a file is read at everywhere, and this says how much bigger THIS panel wants it right
 * now. 100 % therefore means "exactly what the settings say", which is what a panel that was never
 * zoomed carries and what the readout resets to.
 *
 * A ladder, not a step: the same one browsers zoom on, so one press is a visible change at every
 * size instead of five presses at the small end and a jump at the large one.
 */
export class FileViewerZoom {
  static readonly defaultPercentConst = 100
  static readonly stepsConst: readonly number[] = [
    50, 67, 75, 90, 100, 110, 125, 150, 175, 200, 250, 300,
  ]

  /** Read out of saved panel parameters, which anyone may have edited by hand. */
  static read(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value))
      return FileViewerZoom.defaultPercentConst
    return FileViewerZoom.snap(value)
  }

  /** Onto the ladder, so a value between two rungs keeps the intent instead of falling to 100 %. */
  static snap(percent: number): number {
    const steps = FileViewerZoom.stepsConst
    let nearest = steps[0]
    for (const step of steps)
      if (Math.abs(step - percent) < Math.abs(nearest - percent)) nearest = step
    return nearest
  }

  static larger(percent: number): number {
    const steps = FileViewerZoom.stepsConst
    const current = FileViewerZoom.snap(percent)
    return steps.find((step) => step > current) ?? steps[steps.length - 1]
  }

  static smaller(percent: number): number {
    const steps = FileViewerZoom.stepsConst
    const current = FileViewerZoom.snap(percent)
    return steps.findLast((step) => step < current) ?? steps[0]
  }

  static isLargest(percent: number): boolean {
    return FileViewerZoom.snap(percent) >= FileViewerZoom.stepsConst[FileViewerZoom.stepsConst.length - 1]
  }

  static isSmallest(percent: number): boolean {
    return FileViewerZoom.snap(percent) <= FileViewerZoom.stepsConst[0]
  }

  /** The CSS multiplier both the text tokens and the media frame are built from. */
  static scaleOf(percent: number): string {
    return String(FileViewerZoom.snap(percent) / 100)
  }
}

/**
 * Ctrl + wheel over the document, on the element it is aimed at.
 *
 * A native listener rather than React's `onWheel`, and non-passive: without `preventDefault` the
 * same gesture is Chromium's own page zoom, which scales the whole window - tab bar, sessions tree
 * and terminal included - instead of the file somebody is reading.
 */
export function useFileViewerZoomWheel(
  percent: number,
  onChange: (percent: number) => void,
): React.RefObject<HTMLDivElement | null> {
  const body = useRef<HTMLDivElement | null>(null)
  const percentRef = useRef(percent)
  const onChangeRef = useRef(onChange)

  useLayoutEffect(() => {
    percentRef.current = percent
    onChangeRef.current = onChange
  })

  useEffect(() => {
    const element = body.current
    if (element === null) return
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey || event.deltaY === 0) return
      event.preventDefault()
      onChangeRef.current(event.deltaY < 0
        ? FileViewerZoom.larger(percentRef.current)
        : FileViewerZoom.smaller(percentRef.current))
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [])

  return body
}
