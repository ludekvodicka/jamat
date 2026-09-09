import { clipboard } from 'electron'

/**
 * The clipboard, written so that it actually lands.
 *
 * The Windows clipboard is one shared OS resource, and while another process holds it open - a
 * clipboard-history tool, `rdpclip` under Remote Desktop - `clipboard.writeText` silently does
 * nothing: Chromium neither retries nor reports it. So the write is read back and repeated until it
 * sticks. V1 measured that; here it is written once rather than in each of the two services that
 * copy something.
 *
 * It is the main process's clipboard on purpose. `navigator.clipboard` is gated on a secure origin
 * and on focus, so in the packaged `file://` renderer it rejects without a sound - working in
 * development and no-opping in a release, which is the worse of the two failures.
 */
export class ClipboardAccess {
  private static readonly attemptsConst = 8
  private static readonly backoffMillisecondsConst = 25

  static readText(): string {
    return clipboard.readText()
  }

  /** false = another process held the clipboard for the whole window and the text is not there. */
  static async writeText(text: string): Promise<boolean> {
    for (let attempt = 0; attempt < ClipboardAccess.attemptsConst; attempt++) {
      clipboard.writeText(text)
      if (clipboard.readText() === text) return true
      await new Promise((resolve) => setTimeout(resolve, ClipboardAccess.backoffMillisecondsConst))
    }
    return false
  }
}
