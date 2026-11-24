import * as fs from 'node:fs'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AgentAccounts, type StoredAccount } from '../../../lib-orchestrator/agentAccounts/agentAccounts'
import { RemoteControl, type RemoteControlDeps } from '../../../lib-orchestrator/remoteControl/remoteControl'
import { RemoteControlConst } from '../../../lib-orchestrator/remoteControl/remoteControlProtocol'
import { RemoteControlPeerConst } from '../../../lib-orchestrator/remoteControl/remoteControlPeerProtocol'
import { AccountBrokerAnswers } from '../../../lib-orchestrator/agentAccounts/accountBrokerAnswer'
import type { AccountBrokerRequest, AccountUsageReport } from '../../../lib-orchestrator/agentAccounts/accountBrokerApi.types'
import { AccountBroker } from '../../../lib-orchestrator/agentAccounts/accountBroker'
import type { AccountView } from '../../../lib-orchestrator/agentAccounts/agentAccountsApi.types'
import { AccountCallerLog } from '../../../lib-orchestrator/agentAccounts/accountCallerLogView'
import { RegistryBench } from '../remoteControl/fixtures/registryBench'
import { AccountsOperations } from './accountsOperations'

vi.mock('node:fs', async original => {
  const actual = await original<typeof fs>()
  return { ...actual, symlinkSync: vi.fn(actual.symlinkSync) }
})

describe('AccountsOperations', () => {
  it('validates requests and runs the real registry, facade and filesystem chain', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jamat-account-ops-'))
    const main = join(root, 'main')
    mkdirSync(main)
    let stored: readonly StoredAccount[] = []
    let busy = false
    const accounts = new AgentAccounts({ mainHomes: { claude: main, codex: main },
      specs: [{ agentId: 'claude', mainHome: () => main,
        shareTable: { directories: [], files: ['settings.json'], neverShared: [] }, homeVariable: 'CLAUDE_CONFIG_DIR',
        extraEnv: () => ({}), loginCommand: 'fixture', probe: async () => ({ kind: 'logged-out' }) }],
      stored: () => stored, store: value => { stored = value }, accountsRoot: join(root, 'accounts'),
      hasRunningSession: () => busy, onChanged: () => {},
    })
    try {
      const bench = new RegistryBench()
      new AccountsOperations(accounts, { pick: async () => AccountBrokerAnswers.main('chosen'), report: async () => {},
        callers: async () => ({ capturedAt: 0, windowDays: 30, callers: [], recent: [] }) }, () => null).register(bench.registry)
      const deps: Pick<RemoteControlDeps, 'accounts' | 'onError'> = {
        accounts, onError: message => { throw new Error(message) },
      }
      const protocol = new RemoteControl(deps as RemoteControlDeps)
      expect(await protocol.execute({ protocol: RemoteControlConst.protocol, requestId: 'accounts', operation: 'accounts.list', body: {} },
        { callerId: 'fixture', callerKind: 'window', allowedOperations: ['accounts.list'] }))
        .toMatchObject({ ok: true, value: [{ accountId: 'main' }, { accountId: 'main' }] })
      expect(await bench.call('accounts.add', { agentId: 'bad', label: 'Test' })).toMatchObject({ ok: false })
      fs.writeFileSync(join(main, 'settings.json'), '{}')
      vi.mocked(fs.symlinkSync).mockImplementationOnce(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) })
      expect(await bench.call('accounts.add', { agentId: 'claude', label: 'Denied' })).toMatchObject({ ok: false, error: { detail: 'Windows Developer Mode is required to share profile files' } })
      expect(stored).toEqual([])
      expect(await bench.call('accounts.add', { agentId: 'codex', label: 'Unavailable' })).toMatchObject({ ok: false, error: { detail: 'Adding codex accounts is not available' } })
      const added = await bench.call('accounts.add', { agentId: 'claude', label: 'Test' })
      expect(added.ok).toBe(true)
      const accountId = stored[0]!.id
      expect(await bench.call('accounts.rename', { accountId, label: 'Renamed' })).toEqual({ ok: true, value: {} })
      expect(stored[0]!.label).toBe('Renamed')
      expect(await bench.call('accounts.setEnabled', { accountId, enabled: false })).toEqual({ ok: true, value: {} })
      expect(stored[0]!.enabled).toBe(false)
      busy = true
      expect(await bench.call('accounts.remove', { accountId })).toMatchObject({ ok: false, error: { detail: 'a session runs on Renamed' } })
      expect(bench.errors).toEqual([])
      busy = false
      expect(await bench.call('accounts.remove', { accountId })).toEqual({ ok: true, value: {} })
      expect(stored).toEqual([])
      expect(await bench.call('accounts.remove', { accountId: 'main' })).toMatchObject({ ok: false })
    } finally {
      busy = false
      for (const account of [...stored]) await accounts.remove(account.id)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('answers accounts.pick with the broker answer and refuses a malformed body', async () => {
    const picks: AccountBrokerRequest[] = []
    const answer = AccountBrokerAnswers.main('no-eligible-account')
    const bench = new RegistryBench()
    new AccountsOperations({} as AgentAccounts, { pick: async request => { picks.push(request); return answer },
      report: async () => { throw new Error('not reported') }, callers: async () => { throw new Error('not read') } }, () => null).register(bench.registry)
    expect(bench.registry.isWrite('accounts.pick')).toBe(true)
    expect(await bench.call('accounts.pick', { caller: 'probe.v1_x-2', purpose: 'background' })).toEqual({ ok: true, value: answer })
    expect(picks).toEqual([{ caller: 'probe.v1_x-2', purpose: 'background' }])
    for (const body of [
      { caller: 'a b', purpose: 'interactive' },
      { caller: '', purpose: 'interactive' },
      { caller: 'x'.repeat(65), purpose: 'interactive' },
      { caller: 'probe', purpose: 'nightly' },
      { caller: 'probe', purpose: 'interactive', extra: 1 },
      { purpose: 'interactive' },
    ]) expect(await bench.call('accounts.pick', body)).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    expect(await bench.call('accounts.pick', { caller: 'x'.repeat(64), purpose: 'interactive' })).toMatchObject({ ok: true })
    expect(picks).toHaveLength(2)
    expect(bench.errors).toEqual([])
  })

  it('records accounts.report through the broker and refuses a malformed body', async () => {
    const reports: AccountUsageReport[] = []
    const bench = new RegistryBench()
    new AccountsOperations({} as AgentAccounts, { pick: async () => { throw new Error('not picked') },
      report: async report => { reports.push(report) }, callers: async () => { throw new Error('not read') } }, () => null).register(bench.registry)
    expect(bench.registry.isWrite('accounts.report')).toBe(true)
    const counts = { input: 3, output: 40, cacheRead: 600, cacheWrite: 9_000 }
    const valid = { caller: 'indexer', purpose: 'background', accountId: 'mhc-claude-1fbcc96f', models: { 'claude-opus-5-5': counts } }
    expect(await bench.call('accounts.report', valid)).toEqual({ ok: true, value: { recorded: true } })
    expect(reports).toEqual([valid])
    for (const body of [
      { ...valid, accountId: 'a b' },
      { ...valid, purpose: 'nightly' },
      { ...valid, models: {} },
      { ...valid, models: { 'claude opus': counts } },
      { ...valid, models: { m: { ...counts, input: -1 } } },
      { ...valid, models: { m: { ...counts, output: 1.5 } } },
      { ...valid, models: { m: { ...counts, extra: 1 } } },
      { ...valid, models: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`m${index}`, counts])) },
      { ...valid, extra: 1 },
    ]) expect(await bench.call('accounts.report', body)).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    expect(reports).toHaveLength(1)
    expect(bench.errors).toEqual([])
  })

  it('keeps accounts.pick, accounts.report and accounts.antigravity.* off the paired-computer allowlist', () => {
    for (const op of [
      'accounts.pick',
      'accounts.report',
      'accounts.antigravity.list',
      'accounts.antigravity.store',
      'accounts.antigravity.update',
      'accounts.antigravity.clear',
      'accounts.antigravity.login',
      'accounts.antigravity.switch',
      'accounts.antigravity.remove',
    ]) expect(RemoteControlPeerConst.controlOperations).not.toContain(op)
  })

  it('routes accounts.antigravity.* operations with strict validation and AccountProblem mapping', async () => {
    const calls: string[] = []
    const view = {
      available: true,
      unavailableReason: null,
      currentPresent: true,
      activeSlotId: 'alice-1234',
      currentEmail: 'alice@example.com',
      currentPlanTier: 'Pro',
      runningSessionCount: 1,
      reopenableSessionCount: 1,
      loginInProgress: false,
      capturedAt: 100,
      logins: [{ id: 'alice-1234', label: 'Alice', email: 'alice@example.com', planTier: 'Pro', savedAt: 1, active: true, quota: null }],
    }
    const bench = new RegistryBench()
    new AccountsOperations(
      {} as AgentAccounts,
      { pick: async () => { throw new Error('not picked') }, report: async () => {}, callers: async () => ({ capturedAt: 0, windowDays: 30, callers: [], recent: [] }) },
      () => null,
      {
        list: async () => { calls.push('list'); return view },
        store: async label => { calls.push(`store:${label}`); return { slotId: 'alice-1234' } },
        update: async slotId => { calls.push(`update:${slotId}`) },
        clear: async () => { calls.push('clear') },
        login: async () => { calls.push('login'); return { sessionId: 'login-1' } },
        switchTo: async (slotId, options) => { calls.push(`switch:${slotId}:${options?.reopenRunning === true}`); return { reopened: options?.reopenRunning ? 1 : 0, failed: [] } },
        remove: async slotId => { calls.push(`remove:${slotId}`) },
      },
    ).register(bench.registry)
    expect(bench.registry.isWrite('accounts.antigravity.list')).toBe(false)
    for (const op of ['accounts.antigravity.store', 'accounts.antigravity.update', 'accounts.antigravity.clear',
      'accounts.antigravity.login', 'accounts.antigravity.switch', 'accounts.antigravity.remove'])
      expect(bench.registry.isWrite(op)).toBe(true)

    expect(await bench.call('accounts.antigravity.list', {})).toEqual({ ok: true, value: view })
    expect(await bench.call('accounts.antigravity.store', { label: 'Alice' })).toEqual({ ok: true, value: { slotId: 'alice-1234' } })
    expect(await bench.call('accounts.antigravity.update', { slotId: 'alice-1234' })).toEqual({ ok: true, value: {} })
    expect(await bench.call('accounts.antigravity.clear', {})).toEqual({ ok: true, value: {} })
    expect(await bench.call('accounts.antigravity.login', {})).toEqual({ ok: true, value: { sessionId: 'login-1' } })
    expect(await bench.call('accounts.antigravity.switch', { slotId: 'alice-1234' })).toEqual({ ok: true, value: { reopened: 0, failed: [] } })
    expect(await bench.call('accounts.antigravity.switch', { slotId: 'alice-1234', reopenRunning: true })).toEqual({ ok: true, value: { reopened: 1, failed: [] } })
    expect(await bench.call('accounts.antigravity.remove', { slotId: 'alice-1234' })).toEqual({ ok: true, value: {} })
    expect(await bench.call('accounts.antigravity.switch', { slotId: '../bad' })).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    expect(calls).toEqual(['list', 'store:Alice', 'update:alice-1234', 'clear', 'login', 'switch:alice-1234:false', 'switch:alice-1234:true', 'remove:alice-1234'])
    expect(bench.errors).toEqual([])
  })

  it('lists the caller of a pick made just before through usage.callers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jamat-account-callers-'))
    try {
      const views: AccountView[] = [{ agentId: 'claude', accountId: 'main', label: 'Main', isMain: true, state: 'active',
        identity: null, profileProblem: null }]
      const accounts = { list: async () => views, defaultAccount: async () => ({ accountId: 'main', noFreeAccount: false, resetsAt: null }),
        launchEnv: async () => ({}) }
      let logged = 0
      const broker = new AccountBroker({ accounts, mainConfigDir: null, log: new AccountCallerLog(join(root, 'account-callers')),
        usage: { append: async () => {} }, reportCommand: () => null,
        now: Date.now, onLogged: () => { logged++ }, onReported: () => {}, onError: message => { throw new Error(message) } })
      const bench = new RegistryBench()
      let command: string | null = null
      new AccountsOperations({} as AgentAccounts, broker, () => command).register(bench.registry)
      expect(bench.registry.isWrite('usage.callers')).toBe(false)
      expect(await bench.call('usage.callers', { extra: 1 })).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
      expect(await bench.call('accounts.pick', { caller: 'probe', purpose: 'interactive' })).toMatchObject({ ok: true, value: { reason: 'chosen' } })
      await vi.waitFor(() => expect(logged).toBe(1))
      expect(await bench.call('usage.callers')).toMatchObject({ ok: true, value: { windowDays: 30, command: null,
        callers: [{ caller: 'probe', calls: 1, fallbacks: 0, purposes: { interactive: 1, background: 0 }, accounts: [{ accountId: 'main', label: 'Main', calls: 1 }] }],
        recent: [{ caller: 'probe', accountId: 'main', reason: 'chosen' }] } })
      command = 'node "C:/home/.claude/skills/appjamat-v3/scripts/jamat-v3.mjs" accounts pick --caller {caller} --purpose {purpose}'
      expect(await bench.call('usage.callers')).toMatchObject({ ok: true, value: { command } })
      expect(bench.errors).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
