import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AccountCallerEntry } from './accountBrokerApi.types'
import { AccountCallerLog } from './broker/accountCallerLog'
import { AccountBroker } from './accountBroker'
import { AccountProblem } from './accountProblem'
import type { AccountView } from './agentAccountsApi.types'
import type { DefaultAccountChoice } from './defaultAccount'

const view = (accountId: string, key: string, tier: string): AccountView => ({ agentId: 'claude', accountId, label: accountId === 'main' ? 'Main' : 'Work',
  isMain: accountId === 'main', state: 'active', identity: { key, label: key }, profileProblem: null, capacity: { weight: 5, tier } })
const views = [view('main', 'org/main@example.test', 'default_claude_max_20x'), view('work', 'org/work@example.test', 'default_claude_max_5x')]

function brokerOf(choice: DefaultAccountChoice, options: { mainConfigDir?: string | null; launchEnv?: () => Promise<Record<string, string>>
  log?: AccountCallerLog } = {}) {
  const accounts = { list: vi.fn(async () => views), defaultAccount: vi.fn(async () => choice),
    launchEnv: vi.fn(options.launchEnv ?? (async () => ({ CLAUDE_CONFIG_DIR: 'C:/accounts/claude/work' }))) }
  const entries: AccountCallerEntry[] = []
  const logged = vi.fn()
  const errors: string[] = []
  let clock = 1_000
  const broker = new AccountBroker({ accounts, mainConfigDir: options.mainConfigDir ?? null,
    log: options.log ?? { append: async entry => { entries.push(entry) }, view: async now => ({ capturedAt: now, windowDays: 30, callers: [], recent: [] }) }, now: () => (clock += 25),
    onLogged: logged, onError: message => errors.push(message) })
  return { accounts, broker, entries, logged, errors }
}

describe('AccountBroker', () => {
  it('answers Main as a fallback when no account is eligible', async () => {
    const { broker } = brokerOf({ accountId: 'main', noFreeAccount: true, resetsAt: null })
    expect(await broker.pick({ caller: 'indexer', purpose: 'background' })).toMatchObject({ fallback: true, reason: 'no-eligible-account',
      reuseSeconds: 60, account: { id: 'main', identityKey: 'org/main@example.test' } })
  })

  it('answers an added account with its home and without the credential variables', async () => {
    const { broker, accounts } = brokerOf({ accountId: 'work', noFreeAccount: false, resetsAt: null })
    expect(await broker.pick({ caller: 'indexer', purpose: 'background' })).toEqual({ brokerVersion: 1, provider: 'claude',
      account: { id: 'work', label: 'Work', identityKey: 'org/work@example.test', tier: 'default_claude_max_5x' },
      env: { set: { CLAUDE_CONFIG_DIR: 'C:/accounts/claude/work' }, unset: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] },
      fallback: false, reason: 'chosen', reuseSeconds: 300 })
    expect(accounts.defaultAccount).toHaveBeenCalledWith('claude', 'soonest-reset')
    expect(accounts.launchEnv).toHaveBeenCalledWith('claude', 'work')
  })

  it('answers a chosen Main by the home the orchestrator runs with', async () => {
    const choice = { accountId: 'main', noFreeAccount: false, resetsAt: null }
    const plain = await brokerOf(choice).broker.pick({ caller: 'assistant', purpose: 'interactive' })
    expect(plain).toMatchObject({ fallback: false, reason: 'chosen', reuseSeconds: 300, account: { tier: 'default_claude_max_20x' },
      env: { set: {}, unset: ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] } })
    const own = await brokerOf(choice, { mainConfigDir: 'C:/home/main' }).broker.pick({ caller: 'assistant', purpose: 'interactive' })
    expect(own.env).toEqual({ set: { CLAUDE_CONFIG_DIR: 'C:/home/main' }, unset: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] })
  })

  it('answers Main when the chosen profile cannot launch', async () => {
    const choice = { accountId: 'work', noFreeAccount: false, resetsAt: null }
    const unusable = brokerOf(choice, { launchEnv: async () => { throw new AccountProblem('login in progress') } })
    expect(await unusable.broker.pick({ caller: 'x', purpose: 'interactive' })).toMatchObject({ fallback: true, reason: 'account-unusable', account: { id: 'main' } })
    const broken = brokerOf(choice, { launchEnv: async () => { throw new Error('disk') } })
    expect(await broken.broker.pick({ caller: 'x', purpose: 'interactive' })).toMatchObject({ fallback: true, reason: 'error' })
  })

  it('maps each purpose to its rule and refuses any other', () => {
    expect([AccountBroker.ruleOf('interactive'), AccountBroker.ruleOf('background')]).toEqual(['paced', 'soonest-reset'])
    expect(() => AccountBroker.ruleOf('batch' as 'interactive')).toThrow('Unknown broker purpose')
  })

  it('logs each pick with its answer and duration, then says it was logged', async () => {
    const { broker, entries, logged } = brokerOf({ accountId: 'work', noFreeAccount: false, resetsAt: null })
    await broker.pick({ caller: 'indexer', purpose: 'background' })
    await vi.waitFor(() => expect(logged).toHaveBeenCalledTimes(1))
    expect(entries).toEqual([{ at: 1_025, caller: 'indexer', purpose: 'background', accountId: 'work', accountLabel: 'Work',
      fallback: false, reason: 'chosen', durationMs: 25 }])
    const fallback = brokerOf({ accountId: 'main', noFreeAccount: true, resetsAt: null })
    await fallback.broker.pick({ caller: 'assistant', purpose: 'interactive' })
    await vi.waitFor(() => expect(fallback.entries).toMatchObject([{ accountId: 'main', accountLabel: 'Main', fallback: true, reason: 'no-eligible-account' }]))
  })

  it('answers although the log directory is a file, and reports the error once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jamat-broker-log-'))
    try {
      const file = join(root, 'account-callers')
      writeFileSync(file, 'not a directory')
      const { broker, errors, logged } = brokerOf({ accountId: 'work', noFreeAccount: false, resetsAt: null }, { log: new AccountCallerLog(file) })
      expect(await broker.pick({ caller: 'indexer', purpose: 'background' })).toMatchObject({ fallback: false, reason: 'chosen' })
      await vi.waitFor(() => expect(errors).toHaveLength(1))
      expect(errors[0]).toMatch(/^Caller log: /)
      expect(logged).not.toHaveBeenCalled()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
