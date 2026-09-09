import { DetectionRefusal } from '../shared/detectionRefusal'
import { realpath } from 'node:fs/promises'

import type { WebContents } from 'electron'

import { FileViewer } from '../../../lib-orchestrator/fileViewer/fileViewer'
import type { SessionManager } from '../../../lib-orchestrator/sessionManager/sessionManager'
import type {
  TerminalDetectionHit,
  TerminalDetector,
} from '../../../lib-orchestrator/terminalDetector/terminalDetector'
import { TerminalDetectorLimits } from '../../../lib-orchestrator/terminalDetector/terminalDetectorLimits'
import { ServiceIpcBase } from '../shared/serviceIpcBase'
import { ExternalOpener } from './externalOpener'
import type { ServiceTerminalIpc } from './serviceTerminalIpc'
import { VsCodeLauncher } from './vsCodeLauncher'

/**
 * The action half of the terminal menu, and the reason the renderer never names a path here.
 *
 * A detection answers with ids, and every open channel below turns an id back into a path through
 * the detector's own store and nowhere else. Two proofs guard that: the attach must belong to the
 * sender before anything is detected, and the request must belong to the sender before anything is
 * opened.
 *
 * What that is NOT is a confinement of which paths can be reached. The capture the detect is given
 * is a renderer string, and any absolute path that exists on disk becomes a detection - so the
 * proofs bind the request to the window that made it, and nothing binds the path to what the
 * terminal actually printed. It costs nothing that it does not: a renderer able to forge a capture
 * also holds `terminal.input`, so it can type any command into the agent's own shell.
 *
 * `terminal:menu-open-project-vscode` has neither proof and does not need the first: it names a
 * session rather than a detection, and the path it opens is the one the library reports as that
 * session's cwd. The only check it makes is that the sender is a window this app knows.
 */
export class ServiceTerminalMenuIpc extends ServiceIpcBase<
  typeof ServiceTerminalMenuIpc.channelsConst
> {
  static readonly channelsConst = {
    'terminal:menu-detect': true,
    'terminal:menu-open-file': true,
    'terminal:menu-open-directory': true,
    'terminal:menu-open-external': true,
    'terminal:menu-open-vscode': true,
    'terminal:menu-open-project-vscode': true,
  } as const

  private readonly ownersByRequest = new Map<string, WebContents>()
  /** Which senders already have the pair of listeners, so a second request adds no second pair. */

  constructor(
    private readonly detector: TerminalDetector,
    private readonly viewer: FileViewer,
    private readonly sessions: SessionManager,
    private readonly terminals: ServiceTerminalIpc,
    private readonly ownerIdOf: (sender: WebContents) => string | null,
  ) {
    super()
  }

  initialize(): void {
    this.register('terminal:menu-detect', async (event, attachId, capture) => {
      if (!this.terminals.ownsAttach(event.sender, attachId))
        throw new Error(`Terminal attach is not owned by this renderer: ${attachId}`)
      const sessionId = this.terminals.sessionOfAttach(attachId)
      if (sessionId === null)
        throw new Error(`Terminal attach has no session: ${attachId}`)
      const result = await this.detector.detect(sessionId, capture)
      // The detect is the slow tier and the window can go during it. Claiming for a destroyed sender
      // stores a WebContents whose `destroyed` and `did-start-navigation` have both already fired,
      // so nothing ever releases it and it sits there until the ring evicts it - which is the leak
      // the two listeners below exist to prevent.
      if (event.sender.isDestroyed()) return result
      this.claimRequest(result.requestId, event.sender)
      return result
    })
    this.register('terminal:menu-open-file', async (event, requestId, detectionId) => {
      const ownerId = this.ownerId(event.sender)
      const hit = this.provenHit(event.sender, requestId, detectionId)
      if (hit === null)
        return {
          ok: false,
          code: 'proof-expired',
          detail: DetectionRefusal.detailOf('file'),
        }
      if (hit.kind !== 'file')
        return { ok: false, code: 'not-file', detail: `The detection is a ${hit.kind}` }
      const context = await this.sessions.workingContext(hit.sessionId)
      const answer = await this.viewer.openDetected(
        ownerId,
        hit.sessionId,
        context.ok ? context.value.cwd : null,
        hit.path,
      )
      if (answer.ok) this.detector.markOpened(answer.value.path, 'file')
      return answer
    })
    this.register('terminal:menu-open-directory', async (event, requestId, detectionId) => {
      const hit = this.provenHit(event.sender, requestId, detectionId)
      if (hit === null)
        return {
          ok: false,
          code: 'expired',
          detail: DetectionRefusal.detailOf('directory'),
        }
      if (hit.kind !== 'directory')
        return { ok: false, code: 'not-directory', detail: `The detection is a ${hit.kind}` }
      // Resolved before it is registered: `directory-at` proves a panel against the real path, so a
      // register holding a link path would refuse the very directory this open just proved.
      let path: string
      try { path = await realpath(hit.path) }
      catch {
        return { ok: false, code: 'not-directory', detail: 'The detected directory no longer exists' }
      }
      this.detector.markOpened(path, 'directory')
      return {
        ok: true,
        value: {
          sessionId: hit.sessionId,
          path,
          directoryKey: FileViewer.panelKeyOf(hit.sessionId, path),
        },
      }
    })
    this.register('terminal:menu-open-external', async (event, requestId, detectionId) => {
      const hit = this.provenHit(event.sender, requestId, detectionId)
      if (hit === null)
        return { ok: false, code: 'expired', detail: DetectionRefusal.detailOf('file') }
      // The detector answers this the same way it answered the row, so a renderer asking for the
      // desktop over anything else is asking for a row it was never shown - and the desktop is the
      // one door here that runs what it opens.
      if (!hit.opensExternally)
        return { ok: false, code: 'not-external', detail: 'The detection is not opened outside' }
      const refusal = await ExternalOpener.open(hit.path)
      if (refusal !== null) return { ok: false, code: 'failed', detail: refusal }
      return { ok: true }
    })
    this.register('terminal:menu-open-vscode', (event, requestId, detectionId) => {
      const hit = this.provenHit(event.sender, requestId, detectionId)
      if (hit === null) return false
      if (hit.kind === 'file') VsCodeLauncher.open(hit.path, hit.line)
      else if (hit.kind === 'directory') VsCodeLauncher.open(hit.path, null)
      else if (hit.kind === 'url') return false
      else
        throw new Error(`Unknown detection kind: ${JSON.stringify(hit)}`)
      return true
    })
    this.register('terminal:menu-open-project-vscode', async (event, sessionId) => {
      // Called for its refusal: a sender from no known window throws here. The id it returns is of
      // no use, because the path comes from the session's own working context below.
      this.ownerId(event.sender)
      const context = await this.sessions.workingContext(sessionId)
      if (!context.ok) return false
      VsCodeLauncher.open(context.value.cwd, null)
      return true
    })
    this.assertComplete(ServiceTerminalMenuIpc.channelsConst)
  }

  /**
   * A request another window opened is a thrown channel, not a refusal: the renderer asking for it
   * is out of contract. An id this window does own but the store has forgotten is only expired.
   */
  private provenHit(
    sender: WebContents,
    requestId: string,
    detectionId: string,
  ): TerminalDetectionHit | null {
    const owner = this.ownersByRequest.get(requestId)
    // Forgotten is not the same as somebody else's, which is what the comment above has always said
    // and what this line did not do: the ring drops the oldest owner past its ceiling, so an id this
    // window really did own came back as a thrown channel - the wording reserved for a renderer out
    // of contract - instead of the expiry refusal a person who right-clicked often enough deserves.
    if (owner === undefined) return null
    if (owner !== sender)
      throw new Error(`Terminal detection is not owned by this renderer: ${requestId}`)
    return this.detector.pathOf(requestId, detectionId)
  }

  private claimRequest(requestId: string, sender: WebContents): void {
    this.ownersByRequest.set(requestId, sender)
    for (const oldest of this.ownersByRequest.keys()) {
      if (this.ownersByRequest.size <= TerminalDetectorLimits.requestsMax) break
      this.ownersByRequest.delete(oldest)
    }
    this.watchSender(sender, () => this.releaseAll(sender))
  }

  private releaseAll(sender: WebContents): void {
    for (const [requestId, owner] of this.ownersByRequest)
      if (owner === sender) this.ownersByRequest.delete(requestId)
  }

  private ownerId(sender: WebContents): string {
    const ownerId = this.ownerIdOf(sender)
    if (ownerId === null) throw new Error('Terminal menu request came from an unknown workspace')
    return ownerId
  }
}
