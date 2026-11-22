import { z } from 'zod'

import type { AppOperationMap } from '../../../lib-orchestrator/clientApi/appOperationMap'
import type { LimitRecovery } from '../../../lib-orchestrator/limitRecovery/limitRecovery'
import type { RemoteControlRegistry } from '../../../lib-orchestrator/remoteControl/remoteControlRegistry'
import { RemoteControlZod } from '../../../lib-orchestrator/remoteControl/remoteControlSchemas'

export class LimitRecoveryOperations {
  private readonly recovery: Pick<LimitRecovery, 'act'>

  constructor(recovery: Pick<LimitRecovery, 'act'>) {
    this.recovery = recovery
  }

  register(registry: Pick<RemoteControlRegistry, 'registrar'>): void {
    const op = registry.registrar<AppOperationMap>()
    op('sessions.limitRecovery', {
      kind: 'write',
      description: "Answer a session's usage-limit popup: start the switch now, cancel it, or close a failure.",
      input: z.strictObject({ sessionId: RemoteControlZod.text(), action: z.enum(['now', 'cancel', 'dismiss']) }),
      run: async (body) => {
        const result = await this.recovery.act(body.sessionId, body.action)
        return result.ok ? { ok: true, value: {} } : { ok: false, error: { code: 'operation-failed', detail: result.detail } }
      },
    })
  }
}
