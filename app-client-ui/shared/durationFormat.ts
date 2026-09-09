/**
 * A length of time as the two units that matter at its size, in the one place that decides them.
 *
 * There were two, over the same fields of the same reading: the status bar's tooltip described
 * `fetchedAt` and the Debug window described `lastSuccessAt` and `lastAttemptAt` beside it, and they
 * rounded differently at the bottom - `12m` in one and `12m 5s` in the other - so one reading's age
 * had two answers depending on where it was read.
 *
 * Relative rather than a clock time: both surfaces are read where no locale has been agreed. The day
 * tier exists because an OAuth token is days from expiring, and `36h 0m` is a number somebody has to
 * divide.
 */
export class DurationFormat {
  private static readonly secondConst = 1_000
  private static readonly minuteConst = 60 * DurationFormat.secondConst
  private static readonly hourConst = 60 * DurationFormat.minuteConst
  private static readonly dayConst = 24 * DurationFormat.hourConst

  /** A negative length is clamped to none: a reset already past is `0s`, never `-3m`. */
  static of(milliseconds: number): string {
    const held = Math.max(0, milliseconds)
    const days = Math.floor(held / DurationFormat.dayConst)
    const hours = Math.floor((held % DurationFormat.dayConst) / DurationFormat.hourConst)
    const minutes = Math.floor((held % DurationFormat.hourConst) / DurationFormat.minuteConst)
    const seconds = Math.floor((held % DurationFormat.minuteConst) / DurationFormat.secondConst)
    if (days > 0) return `${days}d ${hours}h`
    if (hours > 0) return `${hours}h ${minutes}m`
    if (minutes > 0) return `${minutes}m ${seconds}s`
    return `${seconds}s`
  }

  static ago(milliseconds: number): string {
    return `${DurationFormat.of(milliseconds)} ago`
  }
}
