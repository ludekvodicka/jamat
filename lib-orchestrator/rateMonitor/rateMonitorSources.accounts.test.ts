import { afterEach, expect, it, vi } from 'vitest'
import { RateMonitorSources } from './rateMonitorSources'
import type { AccountView } from '../agentAccounts/agentAccountsApi.types'

const captured = vi.hoisted(() => [] as { environment?: NodeJS.ProcessEnv; keepAlive?: boolean }[])
vi.mock('./codex/rateLimitSourceCodex', () => ({ RateLimitSourceCodex: class {
  readonly agentId = 'codex'
  constructor(deps: { environment?: NodeJS.ProcessEnv; keepAlive?: boolean }) { captured.push(deps) }
  read() { return Promise.resolve({ kind: 'failed', reason: 'fixture', oauthExpiresAt: null }) }
  stop() {}
} }))
afterEach(() => { captured.length = 0 })

  it('creates distinct Codex sources and keeps only Main alive with its original environment', () => {
    const main: AccountView = { agentId: 'codex', accountId: 'main', label: 'Main', isMain: true,
      state: 'active', identity: null, profileProblem: null }
    const added = { ...main, accountId: 'work', label: 'Work', isMain: false }
    const hooks = { nudge: () => {} }
    const sources = [RateMonitorSources.forAccount(main, '/main', hooks, '/main'),
      RateMonitorSources.forAccount(added, '/added', hooks, '/main')]
    expect(sources.map(source => [source.agentId, source.accountId, source.label])).toEqual([['codex', 'main', 'Main'], ['codex', 'work', 'Work']])
    expect(captured[0].environment).toBe(process.env)
    expect(captured[0].keepAlive).toBe(true)
    expect(captured[1]).toMatchObject({ keepAlive: false, environment: { CODEX_HOME: '/added', CODEX_SQLITE_HOME: '/main' } })
    for (const source of sources) source.stop()
  })
