import { ErrorText } from '../../shared/errorText'
import type { PanelOpenOutcome } from './appShell.types'

export type OpenTerminalPort = (
  sessionId: string,
  title: string,
  options?: { preview?: true },
) => Promise<PanelOpenOutcome>

/**
 * Opening a tab for a session that has just been created.
 *
 * It used to clear up after itself too: a plain tab was the only place its session was drawn, so one
 * that never appeared left a runtime nobody could see or stop. Every session has a row in the tree
 * now, so a tab that fails to open strands nothing and the failure is only reported.
 *
 * It lives beside the shell rather than inside the launcher because the launcher stopped being the
 * only caller: the tab menu creates sessions too, and one sequence with two callers is better than
 * two sequences that agree today.
 */
export class SessionTabOpener {
  /** `null` when the tab is up. Otherwise the sentence to report. */
  static async open(
    openTerminal: OpenTerminalPort,
    sessionId: string,
    title: string,
  ): Promise<string | null> {
    const outcome = await openTerminal(sessionId, title)
      .catch((error: unknown): PanelOpenOutcome => ({ kind: 'failed', detail: ErrorText.of(error) }))
    if (outcome.kind === 'opened' || outcome.kind === 'focusedExisting')
      return null
    else if (outcome.kind === 'failed')
      return outcome.detail
    else
      throw new Error(`Unknown panel open outcome: ${JSON.stringify(outcome)}`)
  }
}
