import { DurationFormat } from '../../../shared/durationFormat'

/**
 * Times as the debug screens read them: a clock time, and a length.
 *
 * The clock time is this file's own - only a debug screen shows one. The length is not: the status
 * bar's tooltip describes the same reading's age, and the two used to round differently at the
 * bottom, so `DurationFormat` beside the rest of the shared client code decides it for both.
 */
export class DebugTimeFormat {
  static at(value: number | null): string {
    if (value === null)
      return '—'
    return new Date(value).toLocaleTimeString()
  }

  /** The status bar describes the same reading, so the two tiers are `DurationFormat`'s to decide. */
  static duration(milliseconds: number): string {
    return DurationFormat.of(milliseconds)
  }
}
