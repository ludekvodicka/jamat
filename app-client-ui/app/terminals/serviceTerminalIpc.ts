import type { WebContents } from 'electron'

import type { SessionManager } from '../../../lib-orchestrator/sessionManager/sessionManager'
import type { TerminalFrame } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { ClipboardAccess } from '../shared/clipboardAccess'
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
    'terminal:clipboard-read': true,
    'terminal:clipboard-write': true,
  } as const

  private readonly owned = new Map<WebContents, Set<string>>()
  private readonly ownerByAttach = new Map<string, WebContents>()
  /** What the terminal menu reads instead of trusting a session id from the renderer. */
  private readonly sessionByAttach = new Map<string, string>()
  /** Which senders already have the pair of listeners, so a second attach does not add a second pair. */

  constructor(
    private readonly sessions: SessionManager,
    private readonly acceptsRenderer: (sender: WebContents) => boolean,
  ) {
    super()
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
    this.register('terminal:clipboard-read', (event, attachId) => {
      this.assertOwner(event.sender, attachId)
      return ClipboardAccess.readText()
    })
    this.register('terminal:clipboard-write', (event, attachId, text) => {
      this.assertOwner(event.sender, attachId)
      return ClipboardAccess.writeText(text)
    })
    this.assertComplete(ServiceTerminalIpc.channelsConst)
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
