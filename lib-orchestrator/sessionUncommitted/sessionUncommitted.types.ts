/** The grey mark of one session: what it changed and has not committed yet. Browser-safe: no imports. */
export interface SessionUncommittedEntry {
  /** Claimed paths currently dirty. */
  files: number
  /** At most 5, the most recently written first, relative to the session directory with forward slashes. */
  sample: readonly string[]
}

export interface SessionUncommittedSnapshot {
  /** Bumped only when an entry changes. */
  revision: number
  /** Session id to its entry; an absent session has no mark. */
  sessions: Readonly<Record<string, SessionUncommittedEntry>>
}
