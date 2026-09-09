export type TerminalTarget =
  | { kind: 'local'; sessionId: string }
  | { kind: 'remote'; remoteEndpointId: string; sessionId: string }

export type TerminalPresentation = 'session' | 'tab'

export interface TerminalPanelReading {
  target: TerminalTarget
  presentation: TerminalPresentation
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

  static params(
    target: TerminalTarget,
    presentation: TerminalPresentation = 'session',
  ): Record<string, unknown> {
    if (target.kind === 'local')
      return presentation === 'tab'
        ? { sessionId: target.sessionId, presentation: 'tab' }
        : { sessionId: target.sessionId }
    else if (target.kind === 'remote') {
      if (presentation === 'tab')
        throw new Error('A remote terminal cannot use plain-tab presentation')
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

  static read(params: unknown): TerminalPanelReading | null {
    if (!TerminalTargetCodec.record(params)) return null
    if (typeof params.sessionId === 'string' && params.sessionId.length > 0) {
      if (params.presentation === undefined)
        return { target: { kind: 'local', sessionId: params.sessionId }, presentation: 'session' }
      else if (params.presentation === 'tab')
        return { target: { kind: 'local', sessionId: params.sessionId }, presentation: 'tab' }
      else return null
    }
    const target = params.target
    if (!TerminalTargetCodec.record(target)
      || target.kind !== 'remote'
      || typeof target.remoteEndpointId !== 'string'
      || target.remoteEndpointId.length === 0
      || typeof target.sessionId !== 'string'
      || target.sessionId.length === 0
      || params.presentation !== undefined)
      return null
    return {
      target: {
        kind: 'remote',
        remoteEndpointId: target.remoteEndpointId,
        sessionId: target.sessionId,
      },
      presentation: 'session',
    }
  }

  private static record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }
}
