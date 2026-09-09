import type { SessionOutcome } from '../sessionManagerApi.types'
import type { SessionRecord } from './sessionRecord.types'

/**
 * How a session ended, read off the record it left behind.
 *
 * The two witnesses come first because they are the only ones that mean anything on their own.
 * `stopRequested` is this client's own memory of having asked, written before the record could be
 * lost; `exitReason` is the Host's, and covers the ending this client never got to write down. Only
 * with both absent does the exit code get a say, and then only as `0`: a session somebody finished
 * is killed to end it, and a kill reports `0xC000013A` on Windows and a signalled `0` on POSIX, so
 * on one platform the number reads as a crash and on the other as a clean finish. Neither is true.
 */
export class SessionOutcomes {
  /**
   * Whether somebody asked for this ending, by either witness on its own.
   *
   * It is asked apart from `of` wherever the question is not how the session ended but whether its
   * ending was WANTED - those are different sentences, and `of` answers `finished` for a clean exit
   * nobody asked for as well.
   */
  static endingWasAsked(record: Pick<SessionRecord, 'stopRequested' | 'exitReason'>): boolean {
    return record.stopRequested === true || record.exitReason === 'stopped'
  }

  static of(
    record: Pick<SessionRecord, 'life' | 'stopRequested' | 'exitReason' | 'exitCode'>,
  ): SessionOutcome | null {
    const life = record.life
    if (life === 'starting' || life === 'live') return null
    // Before the two lives below, not inside one of them: a person who pressed Finish and then lost
    // the Host had still finished with the session, and the row must not send them to run it again.
    if (SessionOutcomes.endingWasAsked(record)) return 'finished'
    if (life === 'lost') return 'interrupted'
    else if (life === 'ended') {
      if (record.exitReason === 'host-lost') return 'interrupted'
      else if (record.exitCode === 0) return 'finished'
      else return 'failed'
    }
    else
      throw new Error(`Unknown session life: ${JSON.stringify(life)}`)
  }
}
