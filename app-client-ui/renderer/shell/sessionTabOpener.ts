import { ErrorText } from '../../shared/errorText'
import type { PanelOpenOutcome } from './appShell.types'

export type OpenTerminalPort = (
  sessionId: string,
  title: string,
  options?: { plain?: true; preview?: true },
) => Promise<PanelOpenOutcome>

/**
 * Opening a tab for a session that has just been created, and clearing up after the one case where
 * failing to open it strands something.
 *
 * A plain tab is the only place its session is drawn, so a plain tab that never appeared leaves a
 * runtime nobody can see or stop. A session of the tree has a row whatever happens to its tab, so
 * there is nothing to clear up there and nothing is attempted.
 *
 * It lives beside the shell rather than inside the launcher because the launcher stopped being the
 * only caller: the tab menu creates sessions too, and one sequence with two callers is better than
 * two sequences that agree today.
 */
export class SessionTabOpener {
  /** `null` when the tab is up. Otherwise the sentence to report, cleanup failures included. */
  static async open(
    openTerminal: OpenTerminalPort,
    sessionId: string,
    title: string,
    options: { plain: boolean; closePlain(sessionId: string): Promise<string | null> },
  ): Promise<string | null> {
    const outcome = await openTerminal(
      sessionId,
      title,
      options.plain ? { plain: true } : undefined,
    ).catch((error: unknown): PanelOpenOutcome => ({ kind: 'failed', detail: ErrorText.of(error) }))
    if (outcome.kind === 'opened' || outcome.kind === 'focusedExisting')
      return null
    else if (outcome.kind === 'failed') {
      if (!options.plain) return outcome.detail
      const cleanup = await options.closePlain(sessionId)
      return cleanup === null ? outcome.detail : `${outcome.detail}; ${cleanup}`
    }
    else
      throw new Error(`Unknown panel open outcome: ${JSON.stringify(outcome)}`)
  }

  /**
   * The cleanup itself, over the bridge. `null` says the session is gone; anything else is the half
   * of the failure the caller could not have known about.
   */
  static async closePlain(sessionId: string): Promise<string | null> {
    try {
      const cleanup = await window.appClient.sessions.closePlain(sessionId)
      if (!cleanup.ok) return `closing the unshown session failed: ${cleanup.error}`
      if (!cleanup.value.ok)
        return `closing the unshown session was refused: ${cleanup.value.detail}`
      return null
    } catch (error) {
      return `closing the unshown session failed: ${ErrorText.of(error)}`
    }
  }
}
