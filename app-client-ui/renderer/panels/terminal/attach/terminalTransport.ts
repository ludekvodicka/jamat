import type {
  TerminalFrame,
} from '../../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type {
  TerminalDetectResult,
  TerminalMenuCapture,
} from '../../../../../lib-orchestrator/terminalDetector/terminalDetectorApi.types'
import type {
  RemoteControlErrorCode,
} from '../../../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { IpcResult } from '../../../../shared/appClientUiIpc'
import { AppClientUiReport } from '../../../../shared/appClientUiReport'
import type { TerminalTarget } from '../../../../shared/terminalTarget'
import { IpcFailure } from '../../../ipc/ipcFailure'

/**
 * Why a screen was lost, where the answer had a code to give.
 *
 * It is what decides whether starting the session again is worth offering, which reading the
 * sentence would be a guess at. Null means the loss came with no code of its own.
 */
export type TerminalRefusalCode = 'not-live' | 'unknown-session' | 'host-unreachable' | null

export interface TerminalAttachRefusal {
  detail: string
  code: TerminalRefusalCode
}

/** The geometry an attach asks for, or null from a panel that measured 0x0 and has none. */
export type TerminalSize = { cols: number; rows: number } | null

/**
 * One attach, over whichever channel the target chose.
 *
 * **Two members are optional, and that is the point.** The peer protocol carries attach, input,
 * resize, active and detach, and neither a clipboard read nor a detector: a remote arm that
 * implemented them by returning nothing would look complete to every caller. Missing, they make the
 * caller say what it does without them - the paste key leaves itself to xterm rather than being
 * swallowed into a handler that returns at once, which is the bug this shape exists to prevent.
 */
export interface TerminalAttachTransport {
  /** Null means it worked. A refused attach publishes no frame, so this is all that is ever said. */
  attach(size: TerminalSize): Promise<TerminalAttachRefusal | null>
  input(data: string): void
  resize(cols: number, rows: number): void
  /** Whether this attach is the one being looked at, which decides who owns the PTY's geometry. */
  setActive(active: boolean): void
  detach(): void
  clipboardWrite(text: string): void
  clipboardRead?(): Promise<string | null>
  /** What was under a right click, sent to be given meaning. */
  detect?(capture: TerminalMenuCapture): Promise<IpcResult<TerminalDetectResult>>
  /** Frames for THIS attach only; the returned function stops them. */
  onFrame(handler: (frame: TerminalFrame) => void): () => void
}

/**
 * One session's terminal from this surface's side, with local or remote already decided.
 *
 * The fact was branched on sixteen times across the hook and the panel, each branch written the day
 * its own line was, and nothing tied them together - so leaving one unfinished compiled. One of them
 * WAS left unfinished: paste took the key from xterm and then returned at once for a remote target,
 * so Ctrl+V on a remote screen did nothing and did not even reach the agent as a byte.
 *
 * Now it is decided once, here, exhaustively on the target's own discriminant with a throwing
 * `else`. A third kind of target is a loud failure in one factory rather than sixteen quiet
 * half-working paths.
 */
export interface TerminalTransport {
  /**
   * Whether the surfaces only this machine's Host can answer belong on this panel: the file changes
   * it reads, the file tools sidebar, the post-mortem block and the bar's input registry. A remote
   * session has none of them, because every one of those subsystems answers for this machine alone.
   */
  readonly localTools: boolean
  /** What a screen reader is told this panel is. */
  readonly label: string
  /** Start the session again. The refusal sentence, or null where it worked. */
  reopen(): Promise<string | null>
  attachment(attachId: string): TerminalAttachTransport
}

export class TerminalTransports {
  static of(target: TerminalTarget): TerminalTransport {
    if (target.kind === 'local') return TerminalTransports.local(target.sessionId)
    else if (target.kind === 'remote')
      return TerminalTransports.remote(target.remoteEndpointId, target.sessionId)
    else
      throw new Error(`Unknown terminal target: ${JSON.stringify(target)}`)
  }

  private static local(sessionId: string): TerminalTransport {
    return {
      localTools: true,
      label: `Terminal for session ${sessionId}`,
      reopen: async () => IpcFailure.of(await window.appClient.sessions.reopen(sessionId)),
      attachment: (attachId) => ({
        attach: async (size) => {
          const answer = await window.appClient.terminal.attach(attachId, { sessionId, size })
          const detail = IpcFailure.of(answer)
          if (detail === null) return null
          return { detail, code: IpcFailure.codeOf(answer) }
        },
        input: (data) => { void window.appClient.terminal.input(attachId, data) },
        resize: (cols, rows) => { void window.appClient.terminal.resize(attachId, cols, rows) },
        setActive: (active) => { void window.appClient.terminal.active(attachId, active) },
        detach: () => { void window.appClient.terminal.detach(attachId) },
        clipboardWrite: (text) => {
          // The answer is read, because it means something: false is another process holding the
          // clipboard for all eight attempts, so the copy is NOT there. Dropped, the user watched a
          // copy silently not happen while main already knew and had said so.
          void window.appClient.terminal.clipboardWrite(attachId, text).then((answer) => {
            if (answer.ok && !answer.value)
              AppClientUiReport.error('Another program held the clipboard; the copy did not go')
          })
        },
        clipboardRead: async () => {
          const answer = await window.appClient.terminal.clipboardRead(attachId)
          return answer.ok ? answer.value : null
        },
        detect: (capture) => window.appClient.terminalMenu.detect(attachId, capture),
        onFrame: (handler) => window.appClient.onTerminalFrame((id, frame) => {
          if (id === attachId) handler(frame)
        }),
      }),
    }
  }

  private static remote(remoteEndpointId: string, sessionId: string): TerminalTransport {
    return {
      localTools: false,
      label: `Remote terminal ${remoteEndpointId} for session ${sessionId}`,
      reopen: async () =>
        IpcFailure.of(await window.appClient.remote.reopenSession(remoteEndpointId, sessionId)),
      attachment: (attachId) => ({
        attach: async (size) => {
          const answer = await window.appClient.remote
            .terminalAttach(remoteEndpointId, attachId, { sessionId, size })
          const detail = IpcFailure.of(answer)
          if (detail === null) return null
          const refused = IpcFailure.codeOf(answer)
          // A call that never arrived has no code to read, and nothing about it is ignorable.
          const code = refused === null ? null : TerminalRemoteRefusal.of(refused)
          if (code === 'ignore') return null
          return { detail, code }
        },
        input: (data) => {
          void window.appClient.remote.terminalInput(remoteEndpointId, attachId, data)
        },
        resize: (cols, rows) => {
          void window.appClient.remote.terminalResize(remoteEndpointId, attachId, cols, rows)
        },
        setActive: (active) => {
          void window.appClient.remote.terminalActive(remoteEndpointId, attachId, active)
        },
        detach: () => { void window.appClient.remote.terminalDetach(remoteEndpointId, attachId) },
        // The general clipboard rather than the attach-bound one: this machine is where the copy
        // has to land, and there is nothing on the far side to hold a clipboard against.
        clipboardWrite: (text) => { void window.appClient.clipboard.writeText(text) },
        onFrame: (handler) => window.appClient.onRemoteTerminalFrame((endpointId, id, frame) => {
          if (endpointId === remoteEndpointId && id === attachId) handler(frame)
        }),
      }),
    }
  }
}

/**
 * What a remote refusal means to a terminal surface.
 *
 * Every arm is named, and the closing `else` throws, because `RemoteControlErrorCode` is a closed
 * list whose own comment promises that a new code "cannot be added to one and forgotten in the
 * others". Three maps over it already fail to compile when one is added; this was the fourth and it
 * did not, so a ninth code would have been drawn as a loss with no code of its own - which is
 * exactly what decides whether a restart is offered.
 */
class TerminalRemoteRefusal {
  static of(code: RemoteControlErrorCode): TerminalRefusalCode | 'ignore' {
    // The peer is merely not reachable right now, which is not a fact about the session.
    if (code === 'unavailable') return 'ignore'
    else if (code === 'not-found') return 'unknown-session'
    else if (code === 'invalid-request'
      || code === 'protocol-mismatch'
      || code === 'forbidden'
      || code === 'conflict'
      || code === 'timeout'
      || code === 'operation-failed')
      return null
    else
      throw new Error(`Unknown remote control error code: ${JSON.stringify(code)}`)
  }
}
