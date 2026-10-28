import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentAccounts, type StoredAccount } from '../../agentAccounts/agentAccounts'
import { FakeCodexAppServer } from './fixtures/fakeCodexAppServer'
import { RateLimitSourceCodex } from './rateLimitSourceCodex'
import type { AccountIdentity } from '../../agentAccounts/agentAccountsApi.types'

afterEach(() => vi.useRealTimers())

async function fixture() {
  const temp = resolve(import.meta.dirname, '../../../.aidocs/temp')
  mkdirSync(temp, { recursive: true })
  const root = mkdtempSync(join(temp, 'codex-profile-lifetime-')), main = join(root, 'main')
  mkdirSync(main)
  let stored: readonly StoredAccount[] = []
  let prepare: () => Promise<void> = async () => {}
  let probe: () => Promise<AccountIdentity> = async () => ({ key: 'fixture', label: 'fixture' })
  const accounts = new AgentAccounts({ mainHomes: { codex: main, claude: main },
    specs: [{ agentId: 'codex', mainHome: () => main, shareTable: { directories: [], files: [], neverShared: [] },
      homeVariable: 'CODEX_HOME', extraEnv: () => ({}), loginCommand: 'unused',
      probe: async home => ({ kind: 'logged-in', identity: home === main ? { key: 'fixture', label: 'fixture' } : await probe() }), beforeLaunch: () => prepare() }],
    stored: () => stored, store: value => { stored = value }, accountsRoot: join(root, 'accounts'),
    hasRunningSession: () => false, onChanged: () => {} })
  const { accountId } = await accounts.add('codex', 'Fixture')
  stored = stored.map(account => ({ ...account, identity: { key: 'fixture', label: 'fixture' } }))
  return { accounts, accountId, setPrepare: (value: () => Promise<void>) => { prepare = value },
    setProbe: (value: () => Promise<AccountIdentity>) => { probe = value },
    dispose: () => { accounts.stop(); rmSync(root, { recursive: true, force: true }) } }
}

it.each(['success', 'failed-read', 'failed-close'] as const)('holds the profile through quota read and close, releasing after %s', async outcome => {
  const context = await fixture(), server = new FakeCodexAppServer({ autoAnswer: outcome !== 'failed-read' })
  const source = new RateLimitSourceCodex({ onNudge: () => {}, keepAlive: false, platform: 'linux', environment: {},
    spawnImpl: server.spawnImpl, withProfile: read => context.accounts.withProfile('codex', context.accountId, read) })
  vi.useFakeTimers()
  try {
    const reading = source.read()
    await vi.waitFor(() => expect(server.children).toHaveLength(1))
    await expect(context.accounts.remove(context.accountId)).rejects.toThrow('operation in progress')
    if (outcome === 'failed-read') {
      server.child.refuse(1, 'first refused')
      await vi.advanceTimersByTimeAsync(0)
      server.child.refuse(2, 'second refused')
    }
    await vi.advanceTimersByTimeAsync(0)
    await expect(context.accounts.remove(context.accountId)).rejects.toThrow('operation in progress')
    if (outcome === 'failed-close') await vi.advanceTimersByTimeAsync(2_000)
    else for (const child of server.children) child.exit(0)
    const answer = await reading
    expect(answer.kind).toBe(outcome === 'success' ? 'ok' : 'failed')
    if (outcome === 'failed-close') {
      expect(answer).toMatchObject({ reason: 'The Codex quota child did not stop' })
      for (const child of server.children) child.exit(0)
      await vi.advanceTimersByTimeAsync(0)
    }
    await context.accounts.remove(context.accountId)
  } finally { source.stop(); context.dispose() }
})

it('holds an added profile while an Accounts list identity inspector is pending', async () => {
  const context = await fixture()
  let release!: (identity: AccountIdentity) => void
  const inspect = vi.fn(() => new Promise<AccountIdentity>(resolve => { release = resolve }))
  context.setProbe(inspect)
  try {
    const listing = context.accounts.list()
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledOnce())
    await expect(context.accounts.remove(context.accountId)).rejects.toThrow('operation in progress')
    release({ key: 'fixture', label: 'fixture' })
    await listing
    await context.accounts.remove(context.accountId)
  } finally { context.dispose() }
})

it.each(['preflight', 'read'] as const)('retires a source during %s without releasing its profile before shutdown', async phase => {
  const context = await fixture(), server = new FakeCodexAppServer({ autoAnswer: true })
  let release!: () => void
  const prepared = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
  if (phase === 'preflight') context.setPrepare(prepared)
  const source = new RateLimitSourceCodex({ onNudge: () => {}, keepAlive: false, platform: 'linux', environment: {},
    spawnImpl: server.spawnImpl, withProfile: read => context.accounts.withProfile('codex', context.accountId, read) })
  try {
    const reading = source.read()
    if (phase === 'preflight') await vi.waitFor(() => expect(prepared).toHaveBeenCalledOnce())
    else await vi.waitFor(() => expect(server.child.stdin.ended).toBe(true))
    source.stop()
    await expect(context.accounts.remove(context.accountId)).rejects.toThrow('operation in progress')
    if (phase === 'preflight') release()
    else server.child.exit(0)
    await reading
    expect(server.children).toHaveLength(phase === 'preflight' ? 0 : 1)
    await context.accounts.remove(context.accountId)
    expect((await source.read()).kind).toBe('failed')
    expect(server.children).toHaveLength(phase === 'preflight' ? 0 : 1)
  } finally { source.stop(); context.dispose() }
})
