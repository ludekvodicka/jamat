import type { ILinkHandler } from '@xterm/xterm'

import { AppClientUiReport } from '../../../../shared/appClientUiReport'

/**
 * What a hyperlink an agent printed does when it is clicked.
 *
 * Without this xterm uses its own: a `confirm()` reading "Do you want to navigate to <url>? WARNING:
 * This link could potentially be dangerous", and then `window.open()`. In a browser that opens a
 * tab; in this shell `setWindowOpenHandler` denies every window a page asks for, so the answer to
 * that question was the end of it - the dialog appeared, OK did nothing, and only the console said
 * why. Measured 2026-09-08 on a link Codex printed.
 *
 * The link therefore takes the path every other URL in this app takes: main opens it in the
 * desktop's own browser and refuses anything that is not http(s). `allowNonHttpProtocols` stays at
 * its default, so a `javascript:` or `file:` link never reaches this handler in the first place -
 * two locks, because the text comes from whatever the session decided to print.
 */
export class TerminalLinks {
  static readonly handlerConst: ILinkHandler = {
    activate: (_event: MouseEvent, text: string): void => { void TerminalLinks.open(text) },
  }

  private static async open(url: string): Promise<void> {
    const answer = await window.appClient.fileViewer.openExternal(url)
    if (!answer.ok) AppClientUiReport.error(`terminal link: ${answer.error}`)
    else if (!answer.value) AppClientUiReport.error(`terminal link refused: ${url}`)
  }
}
