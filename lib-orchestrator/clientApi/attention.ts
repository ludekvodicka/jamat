/**
 * What wants the person, as the status bar reads it. A name rather than text: the bar words it,
 * and the queue never branches on it.
 */
export type AttentionKind = 'commit-review' | 'finish-wait' | 'session-opened' | 'session-mark'

export interface AttentionItemView {
  key: string
  kind: AttentionKind
  sessionId: string
  title: string
  /** Comes forward by itself after the person stops typing; otherwise only a click brings it. */
  automatic: boolean
}

/** The waiting items in the order a click takes them: automatic ones first, each kind by arrival. */
export interface AttentionSnapshot {
  /** Moves whenever the items do, so a reader redraws only for a list that changed. */
  revision: number
  items: readonly AttentionItemView[]
}
