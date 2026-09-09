import { TerminalInterrupt } from './terminalInterrupt'
import { TerminalPromptNewline } from './terminalPromptNewline'

/**
 * How many characters a person has standing in an agent's prompt, counted from the bytes their keys
 * produced.
 *
 * A count and not a flag, because a backspace has to be able to take one back: a flag raised by the
 * first keystroke would stay raised through a line that was deleted again, and the automatic compact
 * that reads this would be off for that session until something was submitted.
 *
 * It is a model of the input line and never a reading of one - the screen is not asked, and nothing
 * here knows what either agent draws. That buys a rule that holds for both of them and for whatever
 * their next build draws, and it costs accuracy in one direction on purpose. A delete this does not
 * know (`Ctrl+W`, `Alt+Backspace`) leaves the count too high, so an automatic compact stays off over
 * a line that is already empty and the Compact button beside it still works. The opposite mistake is
 * the one that must not happen: a count reaching zero while text is standing would type `/compact`
 * into the middle of somebody's message and send it.
 *
 * Escape sequences are the keys that move the caret rather than write to it, so they count nothing.
 * The wrapper around pasted text is one of them, which is why a paste needs no case of its own: the
 * markers are stripped with every other sequence and the text between them is counted as typed.
 */
export class TerminalDraft {
  /** xterm sends CR for Enter, and it is the only thing here that submits a line. */
  private static readonly submitConst = '\r'
  /** Ctrl+C, Ctrl+U and a bare Escape each leave an agent's prompt empty. */
  private static readonly clearConst = ['\x03', '\x15', '\x1b']
  // CSI parameters include < (mouse) and > (device replies); OSC replies carry printable payloads.
  private static readonly escapeConst = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|O.|.)/g
  private static readonly reportConst = /^(?:\x1b\[(?:[<=>?][0-?]*[ -/]*[@-~]|[0-9;]*[Rn]|[IO])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))+$/
  private static readonly deleteConst = /[\x08\x7f]/

  static after(characters: number, data: string): number {
    if (data === TerminalDraft.submitConst) return 0
    if (TerminalDraft.clearConst.includes(data)) return 0
    if (TerminalInterrupt.isSequence(data)) return 0
    if (TerminalPromptNewline.isSequence(data)) return characters + 1
    let next = characters
    for (const character of data.replace(TerminalDraft.escapeConst, '')) {
      if (TerminalDraft.deleteConst.test(character)) next -= 1
      else if (character >= ' ') next += 1
    }
    return Math.max(0, next)
  }

  static isReport(data: string): boolean {
    return TerminalDraft.reportConst.test(data)
  }
}
