import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppControl } from '../../../../ipc/appControl'
import { AccountsTabModel } from './accountsTabModel'

afterEach(() => vi.restoreAllMocks())
describe('AccountsTabModel', () => {
  it('adds the label then opens login for the new fixed id', async () => {
    const call = vi.spyOn(AppControl, 'value').mockResolvedValueOnce({ ok: true, value: { accountId: 'work' } })
      .mockResolvedValueOnce({ ok: true, value: { sessionId: 'terminal' } })
    expect(await AccountsTabModel.run({ kind: 'add', agentId: 'claude', label: ' Work ' })).toBeNull()
    expect(call.mock.calls).toEqual([['accounts.add', { agentId: 'claude', label: 'Work' }], ['accounts.login', { accountId: 'work' }]])
  })
  it('keeps actionable add and login refusals', async () => {
    const call = vi.spyOn(AppControl, 'value').mockResolvedValueOnce({ ok: false, error: 'Windows Developer Mode is required' })
    expect(await AccountsTabModel.run({ kind: 'add', agentId: 'claude', label: 'Work' })).toBe('Windows Developer Mode is required')
    expect(call).toHaveBeenCalledTimes(1)
    call.mockResolvedValueOnce({ ok: false, error: 'Login terminal unavailable' })
    expect(await AccountsTabModel.run({ kind: 'login', accountId: 'work' })).toBe('Login terminal unavailable')
  })
  it('offers login for each enabled state, including retained active metadata', () => {
    expect(AccountsTabModel.canLogin('active')).toBe(true)
    expect(AccountsTabModel.canLogin('pending-login')).toBe(true)
    expect(AccountsTabModel.canLogin('needs-login')).toBe(true)
    expect(AccountsTabModel.canLogin('disabled')).toBe(false)
  })

  it('maps all account states explicitly', () => {
    expect(['active', 'pending-login', 'needs-login', 'disabled'].map(state => AccountsTabModel.stateLabel(state as Parameters<typeof AccountsTabModel.stateLabel>[0])))
      .toEqual(['Active', 'Pending login', 'Needs login', 'Disabled'])
  })
  it('adds a Codex account and opens its login using the returned account id', async () => {
    const call = vi.spyOn(AppControl, 'value').mockResolvedValueOnce({ ok: true, value: { accountId: 'codex-work' } })
      .mockResolvedValueOnce({ ok: true, value: { sessionId: 'terminal' } })
    expect(await AccountsTabModel.run({ kind: 'add', agentId: 'codex', label: ' Work ' })).toBeNull()
    expect(call.mock.calls).toEqual([['accounts.add', { agentId: 'codex', label: 'Work' }], ['accounts.login', { accountId: 'codex-work' }]])
  })
})
