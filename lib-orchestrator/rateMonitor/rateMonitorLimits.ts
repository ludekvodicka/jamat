/**
 * The window durations both ends of this wire have to agree on.
 *
 * A window is identified by its length: the library NAMES one by matching this, and the status bar
 * RECOGNISES one by matching the same. Written twice, the two drift apart the day a provider moves a
 * duration - the mapper is corrected, the bar stops recognising the window, and a real percentage is
 * replaced on screen by the "nothing was read" placeholder. Web-safe on purpose, so the drawing side
 * can import the value rather than restate it, the way `sessionLimits` and `fileViewerLimits` are.
 */
export class RateMonitorLimits {
  static readonly sessionMinutes = 300
  static readonly weeklyMinutes = 10_080
}
