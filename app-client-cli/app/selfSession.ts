import type { RuntimeChannel } from '../../lib-orchestrator/shared/configIdentity.types'
import { AppClientCliError } from './appClientCliError'

export interface SelfSessionValue {
  sessionId: string
  controller: { configIdentity: string; channel: RuntimeChannel } | null
}

export class SelfSession {
  static of(env: NodeJS.ProcessEnv): SelfSessionValue | null {
    const sessionId = env.JAMAT_V3_SESSION_ID?.trim()
    if (!sessionId) return null
    const configIdentity = env.JAMAT_V3_SESSION_CONTROLLER?.trim()
    const channel = env.JAMAT_V3_SESSION_CHANNEL?.trim()
    if (!configIdentity || !channel) return { sessionId, controller: null }
    if (channel !== 'development' && channel !== 'production')
      throw new AppClientCliError('invalid-request', 'JAMAT_V3_SESSION_CHANNEL must be development or production')
    return { sessionId, controller: { configIdentity, channel } }
  }
}
