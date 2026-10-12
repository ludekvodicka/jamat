import { z } from 'zod'

import { RemoteControlOutcome } from '../../../lib-orchestrator/remoteControl/remoteControlOutcome'
import type { RemoteControlRegistry } from '../../../lib-orchestrator/remoteControl/remoteControlRegistry'
import { RemoteControlZod } from '../../../lib-orchestrator/remoteControl/remoteControlSchemas'
import type { AppOperationMap } from '../../shared/appOperationMap'
import type { HistoricSessions } from './history/historicSessions'

/** The launcher's history: every agent conversation this client ran, and the ones of one project. */
export class HistoricSessionsOperations {
  static register(registry: Pick<RemoteControlRegistry, 'registrar'>, history: HistoricSessions): void {
    const op = registry.registrar<AppOperationMap>()
    const lastUsedSince = RemoteControlZod.integer(0, Number.MAX_SAFE_INTEGER).nullable().optional()
    op('historicSessions.appJamat', {
      kind: 'read',
      description: 'Every agent conversation this client ran, grouped by project; `lastUsedSince` cuts older ones.',
      input: z.strictObject({ lastUsedSince }),
      run: async (body) => ({ ok: true, value: await history.appJamat(body.lastUsedSince ?? null) }),
    })
    op('historicSessions.project', {
      kind: 'read',
      description: 'The agent conversations of one project, from the providers and from this client.',
      input: z.strictObject({ categoryId: RemoteControlZod.text(), projectName: RemoteControlZod.text(1_024), lastUsedSince }),
      run: async (body) => RemoteControlOutcome.of(
        await history.project(body.categoryId, body.projectName, body.lastUsedSince ?? null),
      ),
    })
  }
}
