export type TerminalDetectorAgentId = 'claude' | 'codex'

export type TerminalDetectionOrigin = 'direct' | 'changed' | 'search'

export interface TerminalMenuCapture {
  token: string | null
  selection: string | null
  contextText: string
  /**
   * The single-row run, when the scan stitched a wrapped path out of several rows and got something
   * else. Both are resolved against the disk, so a stitch that guessed wrong costs one `stat`
   * instead of the path that was actually under the pointer.
   */
  fallbackToken: string | null
}

export interface TerminalDetectionChild {
  detectionId: string
  name: string
  opensExternally: boolean
}

/**
 * `path` is display data - a label and what Copy path writes. It is never the authority an
 * action runs on: every action channel carries `detectionId` and main resolves the path itself.
 */
export type TerminalDetection =
  | {
    kind: 'file'
    detectionId: string
    path: string
    name: string
    line: number | null
    column: number | null
    via: TerminalDetectionOrigin
    /**
     * The built-in viewer has nothing to show for this one and the desktop has a reader for it, so
     * the menu offers that reader instead of a viewer tab. A PDF opens here as a hex dump.
     */
    opensExternally: boolean
  }
  | {
    kind: 'directory'
    detectionId: string
    path: string
    name: string
    via: TerminalDetectionOrigin
    children: readonly TerminalDetectionChild[]
    childrenTruncated: boolean
  }
  | { kind: 'url'; detectionId: string; url: string }

export interface TerminalDetectResult {
  requestId: string
  detections: readonly TerminalDetection[]
}

/**
 * What the desktop did with a file the menu handed it. `failed` carries what the shell said: a
 * machine with no reader for the type refuses the open, and silence would look like a dead row.
 */
export type TerminalExternalOpenResult =
  | { ok: true }
  | { ok: false; code: 'expired' | 'not-external' | 'failed'; detail: string }

export type TerminalDirectoryOpenResult =
  | { ok: true; value: { sessionId: string; path: string; directoryKey: string } }
  | { ok: false; code: 'expired' | 'not-directory'; detail: string }

/**
 * A name the session's own change log knows. What it IS comes from the disk, not from the log: the
 * log lists what an agent touched, including what it deleted.
 *
 * It lives out here rather than in `resolve/` because `TerminalDetectorDeps.changedPaths` returns
 * it, so everyone who builds a detector has to be able to name it, and reaching into the subsystem's
 * internals to do that is what rule 8 exists to stop.
 */
export interface ChangedPathHint {
  path: string
}
