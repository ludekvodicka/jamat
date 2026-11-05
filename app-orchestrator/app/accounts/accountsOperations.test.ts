import * as fs from 'node:fs'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AgentAccounts, type StoredAccount } from '../../../lib-orchestrator/agentAccounts/agentAccounts'
import { RemoteControl, type RemoteControlDeps } from '../../../lib-orchestrator/remoteControl/remoteControl'
import { RemoteControlConst } from '../../../lib-orchestrator/remoteControl/remoteControlProtocol'
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
      new AccountsOperations(accounts).register(bench.registry)
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
})
