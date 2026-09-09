import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface FileViewerFreshnessModel {
  /** The file behind the open document is gone; what is drawn is the last copy that was read. */
  missing: boolean
}

/**
 * Whether the file on screen is still the file on disk, and the reload when it is not.
 *
 * The cadence lives here rather than in the library, the same bargain `vcsStatusView` makes: the
 * subsystem answers one `stat` over a grant the window already holds and owns no timer, so nothing
 * in the main process keeps polling for a panel somebody closed. A watcher was considered and not
 * built - one per open document, per window, with rename and network-share behaviour of its own -
 * for an answer this cheap.
 *
 * Reloading is bounded to one attempt per distinct disk version: a reload that fails leaves the
 * document as it was, and without the bound the same failure would be retried on every tick for as
 * long as the panel is open.
 */
export function useFileViewerFreshness(
  documentId: string | null,
  reload: () => void,
): FileViewerFreshnessModel {
  const [missing, setMissing] = useState(false)
  const reloadRef = useRef(reload)

  useLayoutEffect(() => {
    reloadRef.current = reload
  })

  useEffect(() => {
    if (documentId === null) {
      setMissing(false)
      return
    }
    let alive = true
    let asking = false
    let reloadedVersion: string | null = null
    const ask = async (): Promise<void> => {
      // A hidden window is a window nobody is reading. The listener below asks again the moment it
      // comes back, so nothing is missed - it is only not asked for while it cannot be seen.
      if (!alive || asking || document.visibilityState !== 'visible') return
      asking = true
      try {
        // The call is invoked as `void ask()` on a timer, so nothing downstream would catch a
        // rejection and it would surface as an unhandled one. A poll that loses its answer is not
        // worth that: the main-process handler can be gone while the window is being torn down, and
        // the next tick asks again anyway. An unknown result SHAPE is a different matter and still
        // throws below, because that one is a programming error rather than a lost round trip.
        const answer = await window.appClient.fileViewer.version(documentId).catch(() => null)
        if (!alive || answer === null || !answer.ok || !answer.value.ok) return
        const value = answer.value
        if (value.kind === 'unchanged') setMissing(false)
        else if (value.kind === 'missing') setMissing(true)
        else if (value.kind === 'changed') {
          setMissing(false)
          if (reloadedVersion === value.contentVersion) return
          reloadedVersion = value.contentVersion
          reloadRef.current()
        }
        else throw new Error(`Unknown file version result: ${JSON.stringify(value)}`)
      }
      finally { asking = false }
    }
    setMissing(false)
    const timer = window.setInterval(
      () => { void ask() },
      FileViewerFreshness.pollMillisecondsConst,
    )
    const onVisibility = (): void => { void ask() }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      alive = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [documentId])

  return { missing }
}

export class FileViewerFreshness {
  /**
   * Close enough that a file an agent just wrote is on screen before the next sentence is read, and
   * far enough apart that a window of open files is a handful of `stat` calls a second.
   */
  static readonly pollMillisecondsConst = 2_000
}
