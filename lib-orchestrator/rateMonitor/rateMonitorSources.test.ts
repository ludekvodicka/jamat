import { describe, expect, it } from 'vitest'

import type { RateAgentId } from './rateMonitorApi.types'
import { RateMonitorSources } from './rateMonitorSources'

describe('lib-orchestrator/rateMonitor/rateMonitorSources', () => {
  // The list a client actually runs on: `appHub` passes no `sources`, so this is what decides which
  // providers exist and where the Codex push is wired. Every other test in this subsystem hands the
  // monitor a fake pair, and the smoke picks its own, so nothing else exercises it at all - drop one
  // provider here and the bar draws its placeholder for ever with no failure anywhere.
  it('builds both providers, and wires the push to the one that pushes', () => {
    const nudged: RateAgentId[] = []
    const sources = RateMonitorSources.of({ nudge: (agentId) => nudged.push(agentId) })

    expect(sources.map((source) => source.agentId)).toEqual(['claude', 'codex'])

    const codex = RateMonitorSources.codex({ nudge: (agentId) => nudged.push(agentId) })
    expect(codex.agentId).toBe('codex')
    for (const source of [...sources, codex]) source.stop()
    expect(nudged).toEqual([])
  })
})
