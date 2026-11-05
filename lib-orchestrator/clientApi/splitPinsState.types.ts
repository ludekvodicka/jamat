
/** One pinned inner split item. The main process keeps it opaque: `PanelSplitParams` owns the item
 *  shape and reads every field again when the panel restores it. */
export type SplitPinRecord = { readonly key: string } & Readonly<Record<string, unknown>>

export type SplitPinsBySession = Readonly<Record<string, readonly SplitPinRecord[]>>
