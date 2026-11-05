import type { ShellPort } from '../../../lib-orchestrator/shared/shellPort.types'
import type { WebContents } from 'electron'
import { PastedFileStore } from '../../../lib-orchestrator/pastedFiles/pastedFileStore'
import type { TerminalClipboardPaste } from '../../../lib-orchestrator/sessionManager/terminalClipboardPaste'
import { ClipboardAccess } from '../shared/clipboardAccess'
import { ClipboardPastePaths } from '../shared/clipboardPastePaths'
import { ElectronServiceIpcBase } from '../shell/electronServiceIpcBase'
import type { WindowPorts } from '../processes/windowPorts'

export class ServiceTerminalIpc extends ElectronServiceIpcBase<typeof ServiceTerminalIpc.channelsConst> {
  static readonly channelsConst = {
    'terminal:clipboard-paste': true,
    'terminal:clipboard-write': true,
  } as const

  private readonly images: Pick<PastedFileStore, 'saveImage'>
  private readonly windows: Pick<WindowPorts, 'authorize'>
  private readonly shell: Pick<ShellPort, 'clipboardForPaste'>

  constructor(windows: Pick<WindowPorts, 'authorize'>,
    images: Pick<PastedFileStore, 'saveImage'>, shell: Pick<ShellPort, 'clipboardForPaste'>) {
    super()
    this.images = images
    this.windows = windows
    this.shell = shell
  }

  initialize(): void {
    this.register('terminal:clipboard-paste', async (event, attachId) => {
      const sessionId = await this.authorize(this.sender(event), attachId)
      if (sessionId === null) throw new Error(`Terminal attach has no session: ${attachId}`)
      return this.paste(sessionId)
    })
    this.register('terminal:clipboard-write', async (event, attachId, text) => {
      if (await this.authorize(this.sender(event), attachId) === null) throw new Error(`Terminal attach has no session: ${attachId}`)
      return ClipboardAccess.writeText(text)
    })
    this.assertComplete(ServiceTerminalIpc.channelsConst)
  }

  async authorize(sender: WebContents, attachId: string): Promise<string | null> {
    return this.windows.authorize(sender, attachId)
  }

  /**
   * Text as it is, paths included: the agent runs on this computer and reads them. A file copied in
   * Explorer pastes its path; an image is saved for the agent, which reads it from the path pasted.
   * Text wins where both are held, because a spreadsheet copies its cells as text and as a picture.
   */
  private async paste(sessionId: string): Promise<TerminalClipboardPaste> {
    const read = await this.shell.clipboardForPaste()
    if (read.kind === 'text') return read
    else if (read.kind === 'file') return { kind: 'text', text: ClipboardPastePaths.textOf(read.path) }
    else if (read.kind === 'empty') return read
    else if (read.kind === 'too-large') throw new Error('The clipboard image is too large to paste')
    else if (read.kind === 'image') {
      const saved = await this.images.saveImage(sessionId, read.bytes)
      if (!saved.ok) throw new Error(saved.detail)
      return { kind: 'text', text: ClipboardPastePaths.textOf(saved.path) }
    } else
      throw new Error(`Unknown clipboard read: ${JSON.stringify(read)}`)
  }

}
