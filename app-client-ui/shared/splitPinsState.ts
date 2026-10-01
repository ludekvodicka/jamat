/** One pinned inner split item. The main process keeps it opaque: `PanelSplitParams` owns the item
 *  shape and reads every field again when the panel restores it. */
export type SplitPinRecord = { readonly key: string } & Readonly<Record<string, unknown>>

export type SplitPinsBySession = Readonly<Record<string, readonly SplitPinRecord[]>>

/**
 * The pinned split items of every session, kept apart from the layout so that they outlive a closed
 * tab, a Reset Layout and a restart. The main process checks only the envelope it can check without
 * renderer code: a session id, a bounded list of objects with unique keys, and a bounded size.
 */
export class SplitPinsState {
  /** Eight files and eight commit dialogs, the two per-kind limits of the split together. */
  static readonly itemsMaxConst = 16
  /** A session that is never opened again keeps its entry, so the oldest written one goes first. */
  static readonly sessionsMaxConst = 200
  private static readonly sessionIdMaxConst = 256
  private static readonly keyMaxConst = 4096
  private static readonly itemsBytesMaxConst = 65_536

  static isValidSessionId(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= SplitPinsState.sessionIdMaxConst
  }

  static isValidItems(value: unknown): value is readonly SplitPinRecord[] {
    if (!Array.isArray(value) || value.length > SplitPinsState.itemsMaxConst) return false
    const keys = new Set<string>()
    for (const item of value) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false
      const key = (item as { key?: unknown }).key
      if (typeof key !== 'string' || key.length === 0 || key.length > SplitPinsState.keyMaxConst || keys.has(key))
        return false
      keys.add(key)
    }
    return JSON.stringify(value).length <= SplitPinsState.itemsBytesMaxConst
  }

  static coerce(value: unknown, report: (message: string) => void): SplitPinsBySession {
    if (value === undefined) return {}
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      report('Stored split pins are invalid; using no split pins')
      return {}
    }
    const entries = Object.entries(value).filter(([sessionId, items]) =>
      SplitPinsState.isValidSessionId(sessionId) && SplitPinsState.isValidItems(items) && items.length > 0)
    if (entries.length !== Object.keys(value).length)
      report('Some stored split pins are invalid; dropping them')
    return Object.fromEntries(entries.slice(-SplitPinsState.sessionsMaxConst).map(([sessionId, items]) =>
      [sessionId, structuredClone(items as readonly SplitPinRecord[])]))
  }

  /** An empty list removes the session's entry; a written one moves to the end of the order. */
  static stored(
    pins: SplitPinsBySession,
    sessionId: string,
    items: readonly SplitPinRecord[],
  ): SplitPinsBySession {
    const others = Object.entries(pins).filter(([held]) => held !== sessionId)
    const entries = items.length === 0 ? others : [...others, [sessionId, structuredClone(items)] as const]
    return Object.fromEntries(entries.slice(-SplitPinsState.sessionsMaxConst))
  }
}
