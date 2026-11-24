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

  it('dispatches every Antigravity login switcher action to its control operation', async () => {
    const call = vi.spyOn(AppControl, 'value')
      .mockResolvedValueOnce({ ok: true, value: { slotId: 'alice-1234' } })
      .mockResolvedValueOnce({ ok: true, value: {} })
      .mockResolvedValueOnce({ ok: true, value: {} })
      .mockResolvedValueOnce({ ok: true, value: { sessionId: 'agy-login' } })
      .mockResolvedValueOnce({ ok: true, value: { reopened: 0, failed: [] } })
      .mockResolvedValueOnce({ ok: true, value: { reopened: 1, failed: ['Session A: locked'] } })
      .mockResolvedValueOnce({ ok: true, value: {} })
    expect(await AccountsTabModel.run({ kind: 'antigravity-store', label: ' Alice ' })).toBeNull()
    expect(await AccountsTabModel.run({ kind: 'antigravity-update', slotId: 'alice-1234' })).toBeNull()
    expect(await AccountsTabModel.run({ kind: 'antigravity-clear' })).toBeNull()
    expect(await AccountsTabModel.run({ kind: 'antigravity-login' })).toBeNull()
    expect(await AccountsTabModel.run({ kind: 'antigravity-switch', slotId: 'alice-1234' })).toBeNull()
    expect(await AccountsTabModel.run({ kind: 'antigravity-switch', slotId: 'alice-1234', reopenRunning: true }))
      .toBe('Switched login (reopened 1); failed to reopen: Session A: locked')
    expect(await AccountsTabModel.run({ kind: 'antigravity-remove', slotId: 'alice-1234' })).toBeNull()
    expect(call.mock.calls).toEqual([
      ['accounts.antigravity.store', { label: 'Alice' }],
      ['accounts.antigravity.update', { slotId: 'alice-1234' }],
      ['accounts.antigravity.clear', {}],
      ['accounts.antigravity.login', {}],
      ['accounts.antigravity.switch', { slotId: 'alice-1234' }],
      ['accounts.antigravity.switch', { slotId: 'alice-1234', reopenRunning: true }],
      ['accounts.antigravity.remove', { slotId: 'alice-1234' }],
    ])
  })
})
