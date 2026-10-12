import { z } from 'zod'

import type { RateMonitor } from '../../../lib-orchestrator/rateMonitor/rateMonitor'
import type { RemoteControlRegistry } from '../../../lib-orchestrator/remoteControl/remoteControlRegistry'
import type { AppOperationMap } from '../../shared/appOperationMap'

/** How much of each provider's rate limit is spent, as the status bar and the Debug window read it. */
export class RateMonitorOperations {
  constructor(private readonly rateMonitor: RateMonitor) {}

  register(registry: Pick<RemoteControlRegistry, 'registrar'>): void {
    const op = registry.registrar<AppOperationMap>()
    op('rate.get', {
      kind: 'read',
      description: 'The latest rate-limit reading of every provider, with its revision.',
      input: z.strictObject({}),
      run: async () => ({ ok: true, value: this.rateMonitor.snapshot() }),
    })
    op('rate.refresh', {
      kind: 'read',
      description: 'Read the providers again and answer once the reads settled; the monitor keeps its own floor.',
      input: z.strictObject({}),
      run: async () => ({ ok: true, value: await this.rateMonitor.refresh() }),
    })
    op('rate.debugStatus', {
      kind: 'read',
      description: 'Every window the providers answered, both timestamps and when the OAuth token expires; never a token.',
      input: z.strictObject({}),
      run: async () => ({ ok: true, value: this.rateMonitor.debugStatus() }),
    })
  }
}
