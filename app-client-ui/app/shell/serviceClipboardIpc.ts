import { clipboard } from 'electron'

import { ClipboardAccess } from '../shared/clipboardAccess'
import { ServiceIpcBase } from '../shared/serviceIpcBase'

/**
 * Putting text into the system clipboard.
 *
 * A file of its own rather than a second job for the dialog service, which says it owns the native
 * dialogs and is the only place that opens one; a clipboard write is neither.
 *
 * `navigator.clipboard` is not the alternative it looks like: in a packaged renderer served over
 * `file://` it fails without saying so, which the terminal's own copy path already had to work
 * around. This is write only, deliberately - reading the clipboard stays tied to an attach, because
 * a page that can read it can read whatever the person last copied from anywhere.
 */
export class ServiceClipboardIpc extends ServiceIpcBase<typeof ServiceClipboardIpc.channelsConst> {
  static readonly channelsConst = {
    'clipboard:write-text': true,
    'clipboard:write-rich': true,
  } as const

  initialize(): void {
    this.register('clipboard:write-text', (_event, text) => { clipboard.writeText(text) })
    this.register('clipboard:write-rich', (_event, text, html) => ClipboardAccess.writeRich(text, html))
    this.assertComplete(ServiceClipboardIpc.channelsConst)
  }
}
