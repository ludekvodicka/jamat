import { useEffect, useRef } from 'react'

/** Where a reader was in a document body: its vertical scroll offset in CSS pixels. */
export class FileViewerScrollTop {
  /** How long a restored offset is applied again while late content (diagrams, images) grows the body. */
  static readonly settleMillisecondsConst = 3_000

  /** Absent for the top: a document opens there anyway, so zero is not worth remembering. */
  static read(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.round(value) : undefined
  }

  static of(element: HTMLElement | null): number | undefined {
    return element === null ? undefined : FileViewerScrollTop.read(element.scrollTop)
  }

  /** The offset of the body of a viewer section (`FileViewerPane`), for a caller that holds the section. */
  static inViewer(viewer: HTMLElement | null): number | undefined {
    return FileViewerScrollTop.of(viewer?.querySelector<HTMLElement>(':scope > .file-viewer-body') ?? null)
  }
}

/**
 * Scrolls `body` to `scrollTop` once `ready` holds, then calls `onDone`. Diagrams and images draw
 * after the text, so the offset is applied again whenever the body's content changes size, until the
 * reader scrolls, presses a key or clicks, or the settle time passes. Without that the offset would
 * land in a shorter document and stop short of where the reader was.
 */
export function useFileViewerScrollRestore(
  body: React.RefObject<HTMLElement | null>,
  scrollTop: number | undefined,
  ready: boolean,
  onDone: () => void,
): void {
  const onDoneRef = useRef(onDone)
  useEffect(() => { onDoneRef.current = onDone })

  useEffect(() => {
    const element = body.current
    if (!ready || scrollTop === undefined || element === null) return
    const owner = element.ownerDocument
    const inputs = ['wheel', 'pointerdown', 'touchstart'] as const
    const apply = (): void => { element.scrollTop = scrollTop }
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(apply)
    const observeChildren = (): void => { for (const child of element.children) resize?.observe(child) }
    const mutation = new MutationObserver(() => { observeChildren(); apply() })
    const detach = (): void => {
      resize?.disconnect()
      mutation.disconnect()
      window.clearTimeout(timer)
      for (const type of inputs) element.removeEventListener(type, finish)
      owner.removeEventListener('keydown', finish, true)
    }
    const finish = (): void => {
      detach()
      onDoneRef.current()
    }
    const timer = window.setTimeout(finish, FileViewerScrollTop.settleMillisecondsConst)
    apply()
    observeChildren()
    mutation.observe(element, { childList: true, subtree: true })
    for (const type of inputs) element.addEventListener(type, finish, { passive: true })
    owner.addEventListener('keydown', finish, true)
    // A restore cut short by a new target or an unmount is not done: `onDone` would clear the new one.
    return detach
  }, [body, ready, scrollTop])
}
