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
 * Which collapsible sections (`<details>`) of a drawn document are open. A section is known by the
 * text of its summary and how many sections before it carry the same text: an agent editing above
 * it shifts its line numbers, not its summary.
 */
export class FileViewerDisclosures {
  static of(element: HTMLElement): ReadonlyMap<string, boolean> {
    return new Map(FileViewerDisclosures.keyed(element).map(([key, details]) => [key, details.open]))
  }

  /** Sections the map does not know, new ones included, keep what the document draws for them. */
  static apply(element: HTMLElement, open: ReadonlyMap<string, boolean>): void {
    for (const [key, details] of FileViewerDisclosures.keyed(element)) {
      const wanted = open.get(key)
      if (wanted !== undefined && details.open !== wanted) details.open = wanted
    }
  }

  private static keyed(element: HTMLElement): (readonly [string, HTMLDetailsElement])[] {
    const seen = new Map<string, number>()
    return [...element.querySelectorAll('details')].map((details) => {
      const summary = details.querySelector(':scope > summary')?.textContent?.trim() ?? ''
      const occurrence = seen.get(summary) ?? 0
      seen.set(summary, occurrence + 1)
      return [`${summary}\0${occurrence}`, details] as const
    })
  }
}

/** Where a reader was in a document body, and which of its sections they had open. */
export class FileViewerPlace {
  readonly scrollTop: number
  readonly disclosures: ReadonlyMap<string, boolean>

  constructor(scrollTop: number, disclosures: ReadonlyMap<string, boolean>) {
    this.scrollTop = scrollTop
    this.disclosures = disclosures
  }

  /** An offset alone, as a visit or a split item keeps it; absent for the top. */
  static at(scrollTop: number | undefined): FileViewerPlace | undefined {
    return scrollTop === undefined ? undefined : new FileViewerPlace(scrollTop, new Map())
  }

  /**
   * What the body shows now, read before a reload draws the document again: the new grant remounts
   * the whole rendered tree, which closes every section and lets the offset fall while it regrows.
   */
  static of(body: HTMLElement | null): FileViewerPlace | undefined {
    return body === null ? undefined : new FileViewerPlace(body.scrollTop, FileViewerDisclosures.of(body))
  }

  /** Sections first: opening them is what gives the offset room to land. */
  apply(body: HTMLElement): void {
    FileViewerDisclosures.apply(body, this.disclosures)
    body.scrollTop = this.scrollTop
  }
}

/**
 * Puts `body` back at `place` once `ready` holds, then calls `onDone`. Diagrams and images draw
 * after the text, so the place is applied again whenever the body's content changes size, until the
 * reader scrolls, presses a key or clicks, or the settle time passes. Without that the offset would
 * land in a shorter document and stop short of where the reader was.
 */
export function useFileViewerPlaceRestore(
  body: React.RefObject<HTMLElement | null>,
  place: FileViewerPlace | undefined,
  ready: boolean,
  onDone: () => void,
): void {
  const onDoneRef = useRef(onDone)
  useEffect(() => { onDoneRef.current = onDone })

  useEffect(() => {
    const element = body.current
    if (!ready || place === undefined || element === null) return
    const owner = element.ownerDocument
    const inputs = ['wheel', 'pointerdown', 'touchstart'] as const
    const apply = (): void => place.apply(element)
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
  }, [body, ready, place])
}
