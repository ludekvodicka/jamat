import { describe, expect, it } from 'vitest'

import type { LimitRecoveryAction } from '../../../lib-orchestrator/limitRecovery/limitRecoveryApi.types'
import { RegistryBench } from '../remoteControl/fixtures/registryBench'
import { LimitRecoveryOperations } from './limitRecoveryOperations'

describe('app-orchestrator/app/limitRecovery/limitRecoveryOperations', () => {
  function bench(answer: { ok: true } | { ok: false; detail: string }) {
    const acts: [string, LimitRecoveryAction][] = []
    const registry = new RegistryBench()
    new LimitRecoveryOperations({ act: async (sessionId, action) => { acts.push([sessionId, action]); return answer } }).register(registry.registry)
    return { registry, acts }
  }

  it('registers one write that hands the action to the recovery', async () => {
    const { registry, acts } = bench({ ok: true })
    expect(registry.registry.names()).toEqual(['sessions.limitRecovery'])
    expect(registry.registry.isWrite('sessions.limitRecovery')).toBe(true)
    expect(await registry.call('sessions.limitRecovery', { sessionId: 's1', action: 'now' })).toEqual({ ok: true, value: {} })
    expect(acts).toEqual([['s1', 'now']])
  })

  it('answers a refusal as a failed operation and rejects an unknown action before the recovery sees it', async () => {
    const { registry, acts } = bench({ ok: false, detail: 'The switch is already running' })
    expect(await registry.call('sessions.limitRecovery', { sessionId: 's1', action: 'cancel' }))
      .toMatchObject({ ok: false, error: { code: 'operation-failed', detail: 'The switch is already running' } })
    expect((await registry.call('sessions.limitRecovery', { sessionId: 's1', action: 'later' })).ok).toBe(false)
    expect(acts).toEqual([['s1', 'cancel']])
  })
})
