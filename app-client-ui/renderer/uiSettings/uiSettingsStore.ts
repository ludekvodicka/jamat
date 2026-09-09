import { UiSettings, type UiSettingsValue } from '../../shared/uiSettings'
import { IpcSnapshotReader } from '../ipc/ipcSnapshotReader'

/**
 * The UI scale of one document: what is on disk, what a slider is showing while it is dragged, and
 * the single CSS property both end up in.
 *
 * Statics rather than an instance, the shape `TerminalTheme` uses: there is one document per window
 * and one `documentElement` in it, so a second store would be a second answer to what size the text
 * is. It is started once per document (`main.tsx`, `debugWindow/debugMain.tsx`) and read from
 * wherever the value is needed, without threading it through the React tree it is not part of.
 *
 * Three things reach the document, and none of them is a colour or a size: `--ui-font-scale`, which
 * every size in `tokens.css` is a `calc` over, `--file-viewer-font-scale`, which the viewer's body
 * multiplies those same sizes by once more, and `data-terminal-theme`, which selects the blocks at
 * the foot of that file. A window whose store never runs computes all three to what it always had.
 */
export class UiSettingsStore {
  /** Past the point where waiting for the size costs more than drawing once at the wrong one. */
  private static readonly firstReadMillisecondsConst = 400
  private static persisted = UiSettings.defaultValue()
  private static previewValue: UiSettingsValue | null = null
  private static firstSnapshot: (() => void) | null = null
  private static readonly subscribers = new Set<(value: UiSettingsValue) => void>()

  /**
   * The stored size, in place before the document is drawn rather than one repaint later.
   *
   * Without this the window paints at the CSS default of 1 and jumps the moment the first read
   * answers, on every open, for everyone whose scale is not 100 %. The wait is bounded because a
   * window that never draws is worse than one that draws twice: if the main process does not answer
   * in time the render goes ahead at the default, which is exactly what happened before this existed.
   */
  static async startSettled(): Promise<() => void> {
    let settle = (): void => {}
    const first = new Promise<void>((resolve) => { settle = resolve })
    UiSettingsStore.firstSnapshot = settle
    const stop = UiSettingsStore.start()
    const timer = setTimeout(settle, UiSettingsStore.firstReadMillisecondsConst)
    await first
    clearTimeout(timer)
    return stop
  }

  /** Subscribes and reads once; the returned function undoes both. One call per document. */
  static start(): () => void {
    const reader = new IpcSnapshotReader<UiSettingsValue>(
      {
        subject: 'The UI settings',
        read: () => window.appClient.ui.getSettings(),
        subscribe: (onChanged) => window.appClient.onUiSettingsChanged(onChanged),
        reportError: (message) => console.error(message),
      },
      (snapshot) => UiSettingsStore.arrived(snapshot),
      // A reader that has given up leaves the last known scale on screen. Text nobody can resize is
      // still text; a window that reported the failure on its surface would be neither.
      () => {},
    )
    return reader.start()
  }

  static current(): UiSettingsValue {
    return UiSettingsStore.previewValue ?? UiSettingsStore.persisted
  }

  /** A slider being dragged: seen at once and by everything, without anything being written. */
  static preview(value: UiSettingsValue): void {
    UiSettingsStore.previewValue = value
    UiSettingsStore.apply(value)
  }

  /** Dropping the preview, which is what closing the tab without saving means. */
  static clearPreview(): void {
    UiSettingsStore.previewValue = null
    UiSettingsStore.apply(UiSettingsStore.persisted)
  }

  /**
   * What this window itself just wrote. It is told rather than left to hear it back, because the
   * broadcast returns through a reader that coalesces for 100 ms first: until that read lands,
   * `persisted` still holds the pre-save size, and anything falling back to it in between - closing
   * the card, switching group - would drop the window to the old size and then jump forward again.
   * The read that follows arrives at the same value and changes nothing.
   *
   * The preview goes only if it IS this value. One that says something else was chosen after the
   * write left, and applying what was written would leave the window at one size while the slider
   * and the readout beside it hold another. What is on disk is remembered either way, so dropping
   * that preview later still lands on it.
   */
  static committed(value: UiSettingsValue): void {
    UiSettingsStore.persisted = value
    const preview = UiSettingsStore.previewValue
    if (preview !== null && !UiSettingsStore.equals(preview, value))
      return
    UiSettingsStore.previewValue = null
    UiSettingsStore.apply(value)
  }

  /**
   * Back to the state a document starts in. Everything here is static and outlives any one test, so
   * without this the next one reads what the previous one previewed or committed as if it had come
   * from disk - and `clearPreview` would apply that stranger before dropping it.
   */
  static reset(): void {
    UiSettingsStore.persisted = UiSettings.defaultValue()
    UiSettingsStore.previewValue = null
    UiSettingsStore.firstSnapshot = null
    UiSettingsStore.subscribers.clear()
  }

  static subscribe(callback: (value: UiSettingsValue) => void): () => void {
    UiSettingsStore.subscribers.add(callback)
    return () => {
      UiSettingsStore.subscribers.delete(callback)
    }
  }

  /**
   * The snapshot is remembered either way, and applied only when no preview is up: the save of the
   * other window arrives on this same channel, and it must not pull the slider out of the hands of
   * whoever is dragging it here. What was stored is what `clearPreview` then falls back to.
   */
  private static arrived(snapshot: UiSettingsValue): void {
    UiSettingsStore.persisted = snapshot
    if (UiSettingsStore.previewValue === null)
      UiSettingsStore.apply(snapshot)
    UiSettingsStore.firstSnapshot?.()
    UiSettingsStore.firstSnapshot = null
  }

  /** Field by field. `SidebarsState` carries why two of these are never compared as JSON text. */
  private static equals(one: UiSettingsValue, other: UiSettingsValue): boolean {
    return one.fontScalePercent === other.fontScalePercent
      && one.fileViewerFontScalePercent === other.fileViewerFontScalePercent
      && one.terminalFontScalePercent === other.terminalFontScalePercent
      && one.terminalTheme === other.terminalTheme
  }

  private static apply(value: UiSettingsValue): void {
    document.documentElement.style.setProperty(
      '--ui-font-scale',
      String(value.fontScalePercent / 100),
    )
    // The viewer's extra multiplier, on the document rather than on the panel: a window holds any
    // number of file viewers and they all read one size, so the property that carries it is the one
    // every panel already inherits from.
    document.documentElement.style.setProperty(
      '--file-viewer-font-scale',
      String(value.fileViewerFontScalePercent / 100),
    )
    // The chosen palette, as an attribute rather than as colours: `tokens.css` holds the blocks it
    // selects, so this writes a NAME and no module here learns what any theme is made of. What reads
    // the pair it redirects is the panel around the canvas, in CSS, and `TerminalTheme` beside it.
    document.documentElement.dataset.terminalTheme = value.terminalTheme
    // The terminal's half of the value leaves through here: xterm paints into a canvas, where no
    // stylesheet of ours reaches, so it is told rather than restyled. After the attribute, not
    // before: the callback reads the computed pair, and it has to be the one just chosen.
    for (const callback of UiSettingsStore.subscribers)
      callback(value)
  }
}
