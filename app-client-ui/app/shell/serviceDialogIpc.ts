import {
  type BrowserWindow,
  dialog,
  type MessageBoxOptions,
  type WebContents,
} from 'electron'

import type { RemoteInboundApprovalRequest } from '../remoteControl/remoteInboundApprovalManager'
import type { RemoteControlPairingConfirmRequest } from '../remoteControl/remoteControlPairingManager'
import { ServiceIpcBase } from '../shared/serviceIpcBase'

/**
 * The native dialogs: every one the renderer asks for, and every question the shell asks about
 * something it owns. `app/update/updateManager.ts` is the one other opener, because the three boxes
 * of an update are one conversation and half of it would be stranded here; what it shares with this
 * service is the convention rather than the code - first button affirmative, `cancelId` last, so a
 * dialog dismissed without an answer is a no. Anything else asking on its own would be a second
 * answer to what "cancelled" means and a second set of dialog options.
 */
export class ServiceDialogIpc extends ServiceIpcBase<typeof ServiceDialogIpc.channelsConst> {
  static readonly channelsConst = {
    'dialog:pick-directory': true,
    'dialog:confirm': true,
  } as const

  /** Read at call time so the picker follows the renderer that asked for it. */
  constructor(private readonly parent: (sender: WebContents) => BrowserWindow | null) {
    super()
  }

  initialize(): void {
    this.register('dialog:pick-directory', async (event, title) => {
      const parent = this.parent(event.sender)
      // Parented on purpose: an unparented picker on Windows is a window of its own that can end up
      // behind the shell, where it looks like a renderer that stopped answering.
      if (!parent)
        throw new Error('There is no window to open the directory picker over')
      const picked = await dialog.showOpenDialog(parent, { title, properties: ['openDirectory'] })
      // An empty selection reads as a cancel: the caller asked for a directory and has none.
      if (picked.canceled || picked.filePaths.length === 0)
        return null
      return { path: picked.filePaths[0] }
    })
    // Parented for the same reason the picker is, and unparented rather than refused when the window
    // has gone: a question nobody can see is worse than one in the wrong place, and the answer to a
    // dialog that never opens would be silence.
    this.register('dialog:confirm', async (event, message, detail) => {
      const parent = this.parent(event.sender)
      const options: MessageBoxOptions = {
        type: 'question',
        message,
        detail,
        buttons: ['Yes', 'Cancel'],
        // Cancel is what Escape and the close button both land on, which is the safe answer here.
        defaultId: 1,
        cancelId: 1,
      }
      return ServiceDialogIpc.askedYes(parent, options)
    })
    this.assertComplete(ServiceDialogIpc.channelsConst)
  }

  /**
   * The gate in front of trusting another machine, and the reason it is a dialog rather than a flag:
   * `remote.pairing.import` used to grant permanent inbound control behind the same bearer token as
   * a read, so an agent that was TOLD to import a bundle - by a README, an issue, the output of a
   * terminal it was reading - handed a stranger this computer with nothing asked of anyone.
   *
   * The fingerprint is on the dialog because it is the one field that cannot be guessed from a name,
   * and comparing it out of band is the whole of what makes pairing safe.
   */
  async confirmPairing(
    parent: BrowserWindow | null,
    request: RemoteControlPairingConfirmRequest,
  ): Promise<boolean> {
    const options: MessageBoxOptions = {
      type: 'warning',
      message: `Pair with "${request.displayName}"?`,
      detail: ServiceDialogIpc.identityLinesOf(request)
        + '\nCheck the fingerprint against the one shown on that computer.\n\n'
        + ServiceDialogIpc.sourceNoteOf(request.source),
      buttons: ['Pair', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    }
    return ServiceDialogIpc.askedYes(parent, options)
  }

  /**
   * The other side of the same act, and the only way inbound trust is granted: a caller nobody has
   * trusted yet, refused on the wire, put in front of whoever is at this computer.
   *
   * Nobody asked for this dialog, so it is the one that defaults to No rather than to its
   * affirmative button: anyone who can reach the port can raise it. The address says where the call
   * came from; the display name is the caller's own text, which is why it is quoted inside a
   * sentence this build wrote rather than being the sentence.
   */
  async confirmInboundAccess(
    parent: BrowserWindow | null,
    request: RemoteInboundApprovalRequest,
  ): Promise<boolean> {
    const options: MessageBoxOptions = {
      type: 'warning',
      message: `Let "${request.displayName}" control this computer?`,
      detail: ServiceDialogIpc.identityLinesOf(request)
        + `Calling from: ${request.remoteAddress}\n\n`
        + 'Check the fingerprint against the one shown on that computer. '
        + 'If you were not expecting this, click Deny.',
      buttons: ['Allow', 'Deny'],
      defaultId: 1,
      cancelId: 1,
    }
    return ServiceDialogIpc.askedYes(parent, options)
  }

  /**
   * Who is being trusted. Written once because every one of these questions shows the same three
   * lines, and a fingerprint laid out differently in one of them is a fingerprint somebody compares
   * less carefully.
   */
  private static identityLinesOf(request: {
    remoteComputerId: string
    remoteEndpointId: string
    fingerprint: string
  }): string {
    return `Computer: ${request.remoteComputerId}\n`
      + `Endpoint: ${request.remoteEndpointId}\n`
      + `Fingerprint: ${request.fingerprint}\n`
  }

  /**
   * The security difference between the two ways an endpoint reaches this dialog, said plainly: a
   * pasted bundle carried the key before anything was dialled, while a typed address pins whatever
   * answered at it.
   */
  private static sourceNoteOf(source: RemoteControlPairingConfirmRequest['source']): string {
    if (source === 'bundle')
      return 'Its key came with the pasted bundle, pinned before the first connection.'
    else if (source === 'address')
      return 'Its key was fetched from the address you typed. Compare the fingerprint with the one '
        + 'shown on that computer before you continue.'
    else
      throw new Error(`Unknown pairing source: ${String(source)}`)
  }

  async confirmMainWindowClose(
    parent: BrowserWindow | null,
    holderCount: number,
  ): Promise<boolean> {
    const options: MessageBoxOptions = {
      type: 'warning',
      message: 'This is the main window',
      detail: `Closing it also closes ${holderCount} other window${holderCount === 1 ? '' : 's'}.`,
      buttons: ['Close All Windows', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    }
    return ServiceDialogIpc.askedYes(parent, options)
  }

  /**
   * Every question this service asks, parented when there is a window and unparented rather than
   * refused when there is not: a question nobody can see is worse than one in the wrong place, and
   * the answer to a dialog that never opens would be silence.
   *
   * The first button is the affirmative one everywhere, and `cancelId` is what Escape and the close
   * button land on - so a dialog dismissed without an answer is a No.
   */
  private static async askedYes(
    parent: BrowserWindow | null,
    options: MessageBoxOptions,
  ): Promise<boolean> {
    const answer = parent === null
      ? await dialog.showMessageBox(options)
      : await dialog.showMessageBox(parent, options)
    return answer.response === 0
  }
}
