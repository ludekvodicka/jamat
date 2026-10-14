import type { WebContents } from 'electron'

import { PastedFileStore } from '../../../lib-orchestrator/pastedFiles/pastedFileStore'
import type { SessionManager } from '../../../lib-orchestrator/sessionManager/sessionManager'
import type { TerminalFrame } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { TerminalClipboardPaste } from '../../shared/terminalClipboardPaste'
import { ClipboardAccess } from '../shared/clipboardAccess'
import { ClipboardPastePaths } from '../shared/clipboardPastePaths'
import { ServiceIpcBase } from '../shared/serviceIpcBase'

/**
 * The terminal's share of the named allowlist, and the one service that owns state of its own.
 *
 * Every other service is delegation only, because a renderer that goes away leaves nothing behind:
 * a snapshot it never read costs nothing. An attach is different. It holds a socket on the Host,
 * the Host allows sixty-four of them, and a window that reloads never says goodbye - so without
 * something here remembering which attaches belong to which window, every reload during development
 * would leak one per open terminal until the Host refused the next.
 *
 * What it remembers is only that: whose attach it is. What an attach means, when it reconnects and
 * what its cursor is worth all stay in the library, where the smoke run and the unit tests reach
 * them without an Electron process.
 */
export class ServiceTerminalIpc extends ServiceIpcBase<typeof ServiceTerminalIpc.channelsConst> {
  static readonly channelsConst = {
    'terminal:attach': true,
    'terminal:input': true,
    'terminal:resize': true,
    'terminal:active': true,
    'terminal:detach': true,
    'terminal:clipboard-paste': true,
    'terminal:clipboard-write': true,
  } as const

  private readonly owned = new Map<WebContents, Set<string>>()
  private readonly ownerByAttach = new Map<string, WebContents>()
  /** What the terminal menu reads instead of trusting a session id from the renderer. */
  private readonly sessionByAttach = new Map<string, string>()
  private readonly images: Pick<PastedFileStore, 'saveImage'>
  /** Which senders already have the pair of listeners, so a second attach does not add a second pair. */

  constructor(
    private readonly sessions: SessionManager,
    private readonly acceptsRenderer: (sender: WebContents) => boolean,
    images: Pick<PastedFileStore, 'saveImage'>,
  ) {
    super()
    this.images = images
  }

  initialize(): void {
    this.register('terminal:attach', (event, attachId, spec) => {
      if (!this.acceptsRenderer(event.sender))
        throw new Error('The workspace window is closing')
      if (this.ownerByAttach.has(attachId))
        throw new Error(`Attach id already claimed: ${attachId}`)
      this.claim(event.sender, attachId, spec.sessionId)
      try {
        const answer = this.sessions.terminalAttach(attachId, spec, {
          source: 'local',
          onFrame: (frame) => this.publishFrame(attachId, frame),
        })
        if (!answer.ok) this.release(event.sender, attachId)
        return answer
      } catch (error) {
        this.release(event.sender, attachId)
        throw error
      }
    })
    this.register('terminal:input', (event, attachId, data) => {
      this.assertOwner(event.sender, attachId)
      this.sessions.terminalInput(attachId, data)
    })
    this.register('terminal:resize', (event, attachId, cols, rows) => {
      this.assertOwner(event.sender, attachId)
      this.sessions.terminalResize(attachId, cols, rows)
    })
    // The same owner check `terminal:input` uses: an attach is spoken for by the renderer that
    // took it, and nobody else may hand its geometry away.
    this.register('terminal:active', (event, attachId, active) => {
      this.assertOwner(event.sender, attachId)
      this.sessions.terminalSetGeometryActive(attachId, active)
    })
    this.register('terminal:detach', (event, attachId) => {
      this.assertOwner(event.sender, attachId)
      try {
        this.sessions.terminalDetach(attachId)
      } finally {
        this.release(event.sender, attachId)
      }
    })
    // Through the same ownership check as the bytes: the clipboard is the user's, and the only
    // renderer with a reason to reach it is the one holding the terminal it is being pasted into.
    this.register('terminal:clipboard-paste', async (event, attachId) => {
      this.assertOwner(event.sender, attachId)
      return this.paste(attachId)
    })
    this.register('terminal:clipboard-write', (event, attachId, text) => {
      this.assertOwner(event.sender, attachId)
      return ClipboardAccess.writeText(text)
    })
    this.assertComplete(ServiceTerminalIpc.channelsConst)
  }

  /**
   * Text as it is, paths included: the agent runs on this computer and reads them. A file copied in
   * Explorer pastes its path; an image is saved for the agent, which reads it from the path pasted.
   * Text wins where both are held, because a spreadsheet copies its cells as text and as a picture.
   */
  private async paste(attachId: string): Promise<TerminalClipboardPaste> {
    const text = ClipboardAccess.readText()
    if (text.length > 0) return { kind: 'text', text }
    const dropped = ClipboardAccess.readFileDrop()
    if (dropped !== null) return { kind: 'text', text: ClipboardPastePaths.textOf(dropped) }
    const read = ClipboardAccess.readImage(PastedFileStore.imageBytesMaxConst)
    if (read.kind === 'none') return { kind: 'empty' }
    else if (read.kind === 'too-large') throw new Error('The clipboard image is too large to paste')
    else if (read.kind === 'image') {
      const sessionId = this.sessionByAttach.get(attachId)
      if (sessionId === undefined) throw new Error(`Terminal attach has no session: ${attachId}`)
      const saved = await this.images.saveImage(sessionId, read.bytes)
      if (!saved.ok) throw new Error(saved.detail)
      return { kind: 'text', text: ClipboardPastePaths.textOf(saved.path) }
    } else
      throw new Error(`Unknown clipboard read: ${JSON.stringify(read)}`)
  }

  publishFrame(attachId: string, frame: TerminalFrame): void {
    const sender = this.ownerByAttach.get(attachId)
    if (sender && !sender.isDestroyed()) sender.send('terminal:frame', attachId, frame)
  }

  ownsAttach(sender: WebContents, attachId: string): boolean {
    return this.ownerByAttach.get(attachId) === sender
  }

  sessionOfAttach(attachId: string): string | null {
    return this.sessionByAttach.get(attachId) ?? null
  }

  private claim(sender: WebContents, attachId: string, sessionId: string): void {
    this.ownerByAttach.set(attachId, sender)
    this.sessionByAttach.set(attachId, sessionId)
    const held = this.owned.get(sender)
    if (held) {
      held.add(attachId)
      return
    }
    this.owned.set(sender, new Set([attachId]))
    this.watchSender(sender, () => this.releaseAll(sender))
  }

  private release(sender: WebContents, attachId: string): void {
    if (this.ownerByAttach.get(attachId) !== sender) return
    this.ownerByAttach.delete(attachId)
    this.sessionByAttach.delete(attachId)
    const held = this.owned.get(sender)
    if (!held) return
    held.delete(attachId)
    // The sender is dropped from the map rather than kept with an empty set: this is what stops the
    // map from holding a WebContents alive after its last terminal is closed.
    if (held.size === 0) this.owned.delete(sender)
  }

  private releaseAll(sender: WebContents): void {
    const held = this.owned.get(sender)
    if (!held) return
    this.owned.delete(sender)
    for (const attachId of held) {
      if (this.ownerByAttach.get(attachId) !== sender) continue
      this.ownerByAttach.delete(attachId)
      this.sessionByAttach.delete(attachId)
    }
    this.sessions.terminalDetachAll([...held])
  }

  private assertOwner(sender: WebContents, attachId: string): void {
    if (!this.ownsAttach(sender, attachId))
      throw new Error(`Terminal attach is not owned by this renderer: ${attachId}`)
  }
}
