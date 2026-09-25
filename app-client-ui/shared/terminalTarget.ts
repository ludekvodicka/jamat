export type TerminalTarget =
  | { kind: 'local'; sessionId: string }
  | { kind: 'remote'; remoteEndpointId: string; sessionId: string }

export interface TerminalPanelReading {
  target: TerminalTarget
}

export class TerminalTargetCodec {
  /**
   * Which endpoint a target belongs to, or null for this machine's own Host.
   *
   * One place, because the surface used to answer it with a two-armed ternary at three call sites
   * and `local` was the implicit half of each. The one at the top of the attachment effect decides
   * EVERY channel that surface uses - attach, input, resize, clipboard, detach, frames - so a third
   * kind of target would not have arrived as an unknown there; it would have arrived as a local one,
   * and the bytes would have gone to this machine's Host under a foreign session id.
   */
  static endpointOf(target: TerminalTarget): string | null {
    if (target.kind === 'local') return null
    else if (target.kind === 'remote') return target.remoteEndpointId
    else
      throw new Error(`Unknown terminal target: ${JSON.stringify(target)}`)
  }

  static key(target: TerminalTarget): string {
    if (target.kind === 'local') return target.sessionId
    else if (target.kind === 'remote')
      return `remote:${JSON.stringify([target.remoteEndpointId, target.sessionId])}`
    else
      throw new Error(`Unknown terminal target: ${JSON.stringify(target)}`)
  }

  static params(target: TerminalTarget): Record<string, unknown> {
    if (target.kind === 'local')
      return { sessionId: target.sessionId }
    else if (target.kind === 'remote') {
      return {
        target: {
          kind: 'remote',
          remoteEndpointId: target.remoteEndpointId,
          sessionId: target.sessionId,
        },
      }
    } else
      throw new Error(`Unknown terminal target: ${JSON.stringify(target)}`)
  }

  /**
   * A saved layout is the one reader this codec cannot change under: a window restored from one
   * written before 2026-09-23 still carries `presentation: "tab"` on its terminal panels. That
   * panel is an ordinary terminal now, so the key is READ and ignored rather than refused, which
   * would have left the tab out of the restored window without a word.
   */
  static read(params: unknown): TerminalPanelReading | null {
    if (!TerminalTargetCodec.record(params)) return null
    if (typeof params.sessionId === 'string' && params.sessionId.length > 0)
      return { target: { kind: 'local', sessionId: params.sessionId } }
    const target = params.target
    if (!TerminalTargetCodec.record(target)
      || target.kind !== 'remote'
      || typeof target.remoteEndpointId !== 'string'
      || target.remoteEndpointId.length === 0
      || typeof target.sessionId !== 'string'
      || target.sessionId.length === 0)
      return null
    return {
      target: {
        kind: 'remote',
        remoteEndpointId: target.remoteEndpointId,
        sessionId: target.sessionId,
      },
    }
  }

  private static record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }
}
