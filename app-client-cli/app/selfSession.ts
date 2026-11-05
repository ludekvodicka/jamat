import type { RuntimeChannel } from '../../lib-orchestrator/shared/configIdentity.types'
import { AppClientCliError } from './appClientCliError'

export interface SelfSessionValue {
  sessionId: string
  controller: SelfSessionController | null
}

export interface SelfSessionController {
  configIdentity: string
  channel: RuntimeChannel
}

export class SelfSession {
  static of(env: NodeJS.ProcessEnv): SelfSessionValue | null {
    const sessionId = env.JAMAT_V3_SESSION_ID?.trim()
    if (!sessionId) return null
    return { sessionId, controller: SelfSession.controllerOf(env) }
  }

  /** The controller a Jamat session's terminal names, when it names both halves of the pair. */
  static controllerOf(env: NodeJS.ProcessEnv): SelfSessionController | null {
    const configIdentity = env.JAMAT_V3_SESSION_CONTROLLER?.trim()
    const channel = env.JAMAT_V3_SESSION_CHANNEL?.trim()
    if (!configIdentity || !channel) return null
    if (channel !== 'development' && channel !== 'production')
      throw new AppClientCliError('invalid-request', 'JAMAT_V3_SESSION_CHANNEL must be development or production')
    return { configIdentity, channel }
  }
}
