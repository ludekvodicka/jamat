import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountView } from '../../../../../../lib-orchestrator/agentAccounts/agentAccountsApi.types'
import type { AppClientUiBridge } from '../../../../../shared/appClientUiIpc'
import type { UsageSnapshot } from '../../../../../../lib-orchestrator/rateMonitor/usageApi.types'
import { ControlBridgeFixture } from '../../../../ipc/fixtures/controlBridgeFixture'
import { AccountsTab } from './accountsTab'
import { ConfigurationOverlay } from '../../configurationOverlay'
import { WorktreeSetupIntentStore } from '../../worktreeSetupIntentStore'
import { ConfigurationLastTab } from '../../configurationLastTab'

const main: AccountView = { agentId: 'claude', accountId: 'main', label: 'Main', isMain: true, state: 'active', identity: null, profileProblem: null }
let views: readonly AccountView[]
let bridge: ControlBridgeFixture
let changed: () => void
let usageChanged: () => void
let usage: UsageSnapshot
let unsubscribe = vi.fn<() => void>()
beforeEach(() => {
  views = [main, { ...main, accountId: 'work', label: 'Work', isMain: false, state: 'pending-login', profileProblem: 'Profile needs attention' }]
  usage = { capturedAt: Date.parse('2026-11-17T12:00:00Z'), pools: [], accounts: [{ key: { agentId: 'claude', accountId: 'main' }, label: 'Main',
    enabled: true, accountState: 'active', source: 'poll', estimated: null, capacity: { weight: 1, tier: null }, state: { kind: 'ok', fetchedAt: 1, windows: [
      { durationMinutes: 300, usedPercent: 12, resetsAt: '2026-11-17T15:00:00Z' }, { durationMinutes: 10080, usedPercent: 64, resetsAt: '2026-11-22T15:00:00Z' },
      { durationMinutes: 10080, usedPercent: 20, resetsAt: '2026-11-22T15:00:00Z', model: 'fable' }] } }] }
  bridge = new ControlBridgeFixture().on('accounts.list', () => ({ ok: true, value: views })).on('usage.get', () => ({ ok: true, value: usage }))
    .on('accounts.add', { ok: true, value: { accountId: 'new' } }).on('accounts.login', { ok: true, value: { sessionId: 'terminal' } })
    .on('accounts.rename', { ok: true, value: {} }).on('accounts.setEnabled', { ok: true, value: {} }).on('accounts.remove', { ok: true, value: {} })
  unsubscribe = vi.fn<() => void>()
  vi.stubGlobal('appClient', { control: bridge.bridge(), onAgentSettingsChanged: listener => { changed = listener; return unsubscribe },
    onUsageChanged: listener => { usageChanged = listener; return () => {} } } satisfies Pick<AppClientUiBridge, 'control' | 'onAgentSettingsChanged' | 'onUsageChanged'>)
})
afterEach(() => { cleanup(); ConfigurationLastTab.reset(); vi.unstubAllGlobals(); vi.useRealTimers() })
describe('AccountsTab', () => {
  it('reports dirty changes through ConfigurationOverlay without a parent feedback loop', async () => {
    const close = vi.fn()
    await act(async () => { render(<ConfigurationOverlay request={{ requestId: 1, tab: 'accounts' }}
      worktreeSetupIntents={new WorktreeSetupIntentStore()} onClose={close} />) })
    expect(screen.queryByLabelText('Unsaved changes')).toBeNull()
    fireEvent.change(screen.getByLabelText('Account label'), { target: { value: 'Second' } })
    expect(screen.getAllByLabelText('Unsaved changes')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Close Settings' }))
    expect(screen.getByRole('alertdialog').textContent).toContain('Accounts has unsaved changes')
    fireEvent.click(screen.getByRole('button', { name: 'Stay' }))
    fireEvent.change(screen.getByLabelText('Account label'), { target: { value: '' } })
    expect(screen.queryByLabelText('Unsaved changes')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close Settings' }))
    expect(close).toHaveBeenCalledOnce()
    expect(bridge.bodiesOf('accounts.list')).toHaveLength(1)
  })

  it('offers enabled active accounts a fresh login while disabled accounts have no login action', async () => {
    views = [main, { ...views[1]!, state: 'active' }, { ...views[1]!, accountId: 'disabled', label: 'Disabled', state: 'disabled' }]
    await act(async () => { render(<AccountsTab onDirtyChange={() => {}} />) })
    expect(screen.getAllByRole('button', { name: 'Log in again' })).toHaveLength(1)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Log in again' })) })
    expect(bridge.bodiesOf('accounts.login')).toEqual([{ accountId: 'work' }])
  })

  it('shows main without mutations, profiles with problems, and confirms safe removal', async () => {
    await act(async () => { render(<AccountsTab onDirtyChange={() => {}} />) })
    const mainSection = screen.getByText('claude: Main').closest('section')!
    expect(within(mainSection).queryByRole('button')).toBeNull()
    expect(screen.getByRole('alert').textContent).toBe('Profile needs attention')
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(bridge.bodiesOf('accounts.remove')).toEqual([])
    expect(screen.getByText(/The main profile stays untouched/)).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm remove' })) })
    expect(bridge.bodiesOf('accounts.remove')).toEqual([{ accountId: 'work' }])
  })
  it('adds and logs in, renames, disables and retries login through operations', async () => {
    await act(async () => { render(<AccountsTab onDirtyChange={() => {}} />) })
    fireEvent.change(screen.getByLabelText('Account label'), { target: { value: 'Second' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add Claude account' })) })
    expect(bridge.bodiesOf('accounts.add')).toEqual([{ agentId: 'claude', label: 'Second' }])
    expect(bridge.bodiesOf('accounts.login')).toEqual([{ accountId: 'new' }])
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    fireEvent.change(screen.getByLabelText('New label'), { target: { value: 'Office' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save label' })) })
    expect(bridge.bodiesOf('accounts.rename')).toEqual([{ accountId: 'work', label: 'Office' }])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Disable' })) })
    expect(bridge.bodiesOf('accounts.setEnabled')).toEqual([{ accountId: 'work', enabled: false }])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Log in again' })) })
    expect(bridge.bodiesOf('accounts.login')).toEqual([{ accountId: 'new' }, { accountId: 'work' }])
  })
  it('refreshes completion pushes and unsubscribes on navigation', async () => {
    vi.useFakeTimers()
    const view = await act(async () => render(<AccountsTab onDirtyChange={() => {}} />))
    views = [main, { ...views[1]!, state: 'active', identity: { key: 'org/second', label: 'second@test' }, profileProblem: null }]
    await act(async () => { changed(); await vi.advanceTimersByTimeAsync(100) })
    expect(screen.getByText(/second@test/)).toBeTruthy()
    view.unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('adds Codex and opens its managed login terminal through the Codex button', async () => {
    await act(async () => { render(<AccountsTab onDirtyChange={() => {}} />) })
    fireEvent.change(screen.getByLabelText('Account label'), { target: { value: 'Codex work' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add Codex account' })) })
    expect(bridge.bodiesOf('accounts.add')).toEqual([{ agentId: 'codex', label: 'Codex work' }])
    expect(bridge.bodiesOf('accounts.login')).toEqual([{ accountId: 'new' }])
  })

  it('shows each account its used 5-hour and weekly limits and follows usage pushes', async () => {
    vi.useFakeTimers()
    await act(async () => { render(<AccountsTab onDirtyChange={() => {}} />) })
    const mainQuota = screen.getByRole('group', { name: 'Main quota' })
    expect(within(mainQuota).getByRole('progressbar', { name: 'Main 5-hour used' }).getAttribute('aria-valuenow')).toBe('12')
    expect(within(mainQuota).getByRole('progressbar', { name: 'Main weekly used' }).getAttribute('aria-valuenow')).toBe('64')
    expect(within(screen.getByText('claude: Work').closest('section')!).getByText('No quota reading')).toBeTruthy()
    usage = { ...usage, accounts: [...usage.accounts, { key: { agentId: 'claude', accountId: 'work' }, label: 'Work', enabled: true,
      accountState: 'pending-login', source: null, estimated: null, capacity: { weight: 1, tier: null }, state: { kind: 'never-read' } }] }
    await act(async () => { usageChanged(); await vi.advanceTimersByTimeAsync(100) })
    const workQuota = screen.getByRole('group', { name: 'Work quota' })
    expect(within(workQuota).queryByRole('progressbar')).toBeNull()
    expect(within(workQuota).getByText('no reading yet')).toBeTruthy()
  })

  it('copies a captured sign-in link and reports a failed copy', async () => {
    const writeText = vi.fn<AppClientUiBridge['clipboard']['writeText']>().mockResolvedValueOnce({ ok: true, value: undefined })
      .mockResolvedValueOnce({ ok: false, error: 'clipboard busy' })
    vi.stubGlobal('appClient', { control: bridge.bridge(), onAgentSettingsChanged: () => unsubscribe, onUsageChanged: () => () => {}, clipboard: { writeText } })
    views = [main, { ...views[1]!, profileProblem: null, loginLink: 'https://claude.com/cai/oauth/authorize?state=s' }]
    await act(async () => { render(<AccountsTab onDirtyChange={() => {}} />) })
    expect(within(screen.getByText('claude: Main').closest('section')!).queryByRole('button', { name: 'Copy sign-in link' })).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy sign-in link' })) })
    expect(writeText).toHaveBeenCalledExactlyOnceWith('https://claude.com/cai/oauth/authorize?state=s')
    expect(screen.getByRole('status').textContent).toContain('browser profile of this account')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy sign-in link' })) })
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('alert').textContent).toBe('Copying the sign-in link failed: clipboard busy')
  })
})
