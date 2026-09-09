import { AppClientUiReport } from '../../shared/appClientUiReport'
import { PanelKeysConst } from '../../shared/tabTransfer'
import { TerminalTargetCodec } from '../../shared/terminalTarget'
import { IpcFailure } from '../ipc/ipcFailure'

/**
 * Whether a tab a PERSON is closing may go, which for one panel is a question about a runtime
 * rather than about a panel.
 *
 * A class of its own, because it was unreachable while it was a private static in the shell:
 * driving it needs a dockview panel whose params carry no readable session id, and the shell's test
 * dockview has no way to land one. The decision it makes is not small, so it is now a decision
 * about `(key, params)` plus one call, with a test.
 */
export class TabClosePolicy {
  /**
   * The one close that ends what is behind it. A plain tab is drawn by its tab and by nothing else,
   * so a tab closed without this would leave an agent running where nobody could ever see it again.
   *
   * The panel goes only after the library says the runtime is gone. A refusal it cannot act on -
   * an unreachable Host, a records file it could not write - leaves the tab where it is and says
   * why; a record that is no longer a plain tab (promoted, or already removed) is closed normally,
   * because there is nothing left to end.
   */
  static async mayClose(
    key: string,
    params: Record<string, unknown>,
  ): Promise<boolean> {
    if (key !== PanelKeysConst.terminal || params.presentation !== 'tab')
      return true
    // Read through the codec the rest of the shell reads panel params with, not `String(...)`.
    // A tab whose params carry no session id used to be closed on the strength of
    // `closePlain("undefined")` answering `not-found`, which this method reads as "nothing to
    // keep" - and the plain session whose only place on screen was that tab went on running with
    // no way back to it. An unreadable shape keeps the tab instead.
    // The second arm is total rather than reachable: no params can read as a remote target AND
    // plain presentation today, because the codec refuses to write that pair and refuses to read it
    // back. It is the arm that would carry the decision the day one can.
    const reading = TerminalTargetCodec.read(params)
    if (reading === null || reading.target.kind !== 'local')
      return false
    const answer = await window.appClient.sessions.closePlain(reading.target.sessionId)
    if (answer.ok && answer.value.ok)
      return true
    if (answer.ok && !answer.value.ok
      && (answer.value.code === 'not-found' || answer.value.code === 'invalid-spec'))
      return true
    const reason = IpcFailure.of(answer, 'Closing the tab')
    AppClientUiReport.error(`${reason ?? 'the tab could not be closed'}`)
    return false
  }
}
