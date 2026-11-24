import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountView } from '../../../../../../lib-orchestrator/agentAccounts/agentAccountsApi.types'
import type { AntigravityLoginsView } from '../../../../../../lib-orchestrator/agentAccounts/antigravityLoginsApi.types'
import type { AppClientUiBridge } from '../../../../../shared/appClientUiIpc'
import type { UsageSnapshot } from '../../../../../../lib-orchestrator/rateMonitor/usageApi.types'
import { ControlBridgeFixture } from '../../../../ipc/fixtures/controlBridgeFixture'
import { AccountsTab } from './accountsTab'
import { ConfigurationOverlay } from '../../configurationOverlay'
import { WorktreeSetupIntentStore } from '../../worktreeSetupIntentStore'
import { ConfigurationLastTab } from '../../configurationLastTab'

const main: AccountView = { agentId: 'claude', accountId: 'main', label: 'Main', isMain: true, state: 'active', identity: null, profileProblem: null }
let views: readonly AccountView[]
let antigravityLogins: AntigravityLoginsView
let bridge: ControlBridgeFixture
let changed: () => void
let usageChanged: () => void
let usage: UsageSnapshot
let unsubscribe = vi.fn<() => void>()
beforeEach(() => {
  views = [main, { ...main, accountId: 'work', label: 'Work', isMain: false, state: 'pending-login', profileProblem: 'Profile needs attention' }]
  antigravityLogins = {
    available: true,
    unavailableReason: null,
    currentPresent: true,
    activeSlotId: 'alice-1234',
    currentEmail: 'alice@example.com',
    currentPlanTier: 'Pro',
    runningSessionCount: 1,
    reopenableSessionCount: 1,
    loginInProgress: false,
    capturedAt: Date.parse('2026-11-22T15:00:00Z'),
    logins: [
      {
        id: 'alice-1234',
        label: 'Alice',
        email: 'alice@example.com',
        planTier: 'Pro',
        savedAt: 1,
        active: true,
        quota: {
          capturedAt: Date.parse('2026-11-22T14:55:00Z'),
          session: { durationMinutes: 300, usedPercent: 18, resetsAt: '2026-11-22T19:00:00Z' },
          weekly: { durationMinutes: 10080, usedPercent: 32, resetsAt: '2026-11-26T12:00:00Z' },
        },
      },
      {
        id: 'bob-5678',
        label: 'Bob',
        email: 'bob@example.com',
        planTier: 'Ultra',
        savedAt: 2,
        active: false,
        quota: {
          capturedAt: Date.parse('2026-11-22T14:00:00Z'),
          session: { durationMinutes: 300, usedPercent: 100, resetsAt: '2026-11-22T18:30:00Z' },
          weekly: { durationMinutes: 10080, usedPercent: 74, resetsAt: '2026-11-27T12:00:00Z' },
        },
      },
    ],
  }
  usage = { capturedAt: Date.parse('2026-11-17T12:00:00Z'), pools: [], accounts: [{ key: { agentId: 'claude', accountId: 'main' }, label: 'Main',
    enabled: true, accountState: 'active', source: 'poll', estimated: null, capacity: { weight: 1, tier: null }, state: { kind: 'ok', fetchedAt: 1, windows: [
      { durationMinutes: 300, usedPercent: 12, resetsAt: '2026-11-17T15:00:00Z' }, { durationMinutes: 10080, usedPercent: 64, resetsAt: '2026-11-22T15:00:00Z' },
      { durationMinutes: 10080, usedPercent: 20, resetsAt: '2026-11-22T15:00:00Z', model: 'fable' }] } }] }
  bridge = new ControlBridgeFixture().on('accounts.list', () => ({ ok: true, value: views })).on('usage.get', () => ({ ok: true, value: usage }))
    .on('accounts.add', { ok: true, value: { accountId: 'new' } }).on('accounts.login', { ok: true, value: { sessionId: 'terminal' } })
    .on('accounts.rename', { ok: true, value: {} }).on('accounts.setEnabled', { ok: true, value: {} }).on('accounts.remove', { ok: true, value: {} })
    .on('accounts.antigravity.list', () => ({ ok: true, value: antigravityLogins }))
    .on('accounts.antigravity.store', { ok: true, value: { slotId: 'new-slot' } })
    .on('accounts.antigravity.update', { ok: true, value: {} })
    .on('accounts.antigravity.clear', { ok: true, value: {} })
    .on('accounts.antigravity.login', { ok: true, value: { sessionId: 'agy-login' } })
    .on('accounts.antigravity.switch', { ok: true, value: { reopened: 1, failed: [] } })
    .on('accounts.antigravity.remove', { ok: true, value: {} })
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
    const workSection = screen.getByText('claude: Work').closest('section')!
    fireEvent.click(within(workSection).getByRole('button', { name: 'Remove' }))
    expect(bridge.bodiesOf('accounts.remove')).toEqual([])
    expect(screen.getByText(/The main profile stays untouched/)).toBeTruthy()
    await act(async () => { fireEvent.click(within(workSection).getByRole('button', { name: 'Confirm remove' })) })
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

  it('stores, switches, clears, starts new login, and removes saved Antigravity logins', async () => {
    await act(async () => { render(<AccountsTab onDirtyChange={() => {}} />) })
    const section = screen.getByText('Antigravity logins').closest('section')!
    expect(section.textContent).toContain('Current login: stored as Alice (alice@example.com · Pro)')
    const bobQuota = within(section).getByRole('group', { name: 'Bob saved quota' })
    expect(within(bobQuota).getByRole('progressbar', { name: 'Bob 5-hour used' }).getAttribute('aria-valuenow')).toBe('100')
    expect(within(bobQuota).getByRole('progressbar', { name: 'Bob weekly used' }).getAttribute('aria-valuenow')).toBe('74')

    fireEvent.change(within(section).getByLabelText('Store current login as'), { target: { value: 'Backup' } })
    await act(async () => { fireEvent.click(within(section).getByRole('button', { name: 'Store current login' })) })
    expect(bridge.bodiesOf('accounts.antigravity.store')).toEqual([{ label: 'Backup' }])

    const switchButtons = within(section).getAllByRole('button', { name: 'Switch login' })
    expect((switchButtons[0] as HTMLButtonElement).disabled).toBe(true)
    expect((switchButtons[1] as HTMLButtonElement).disabled).toBe(false)
    await act(async () => { fireEvent.click(switchButtons[1]!) })
    expect(bridge.bodiesOf('accounts.antigravity.switch')).toEqual([{ slotId: 'bob-5678' }])

    const switchReopenButtons = within(section).getAllByRole('button', { name: 'Switch & reopen' })
    expect((switchReopenButtons[0] as HTMLButtonElement).disabled).toBe(true)
    expect((switchReopenButtons[1] as HTMLButtonElement).disabled).toBe(false)
    await act(async () => { fireEvent.click(switchReopenButtons[1]!) })
    expect(bridge.bodiesOf('accounts.antigravity.switch')).toEqual([
      { slotId: 'bob-5678' },
      { slotId: 'bob-5678', reopenRunning: true },
    ])

    const newLoginButton = within(section).getByRole('button', { name: 'New login' }) as HTMLButtonElement
    expect(newLoginButton.disabled).toBe(true)

    fireEvent.click(within(section).getByRole('button', { name: 'Clear current login' }))
    expect(bridge.bodiesOf('accounts.antigravity.clear')).toEqual([])
    antigravityLogins = { ...antigravityLogins, currentPresent: false, activeSlotId: null, currentEmail: null, currentPlanTier: null,
      logins: antigravityLogins.logins.map(slot => ({ ...slot, active: false })) }
    await act(async () => { fireEvent.click(within(section).getByRole('button', { name: 'Confirm clear' })) })
    expect(bridge.bodiesOf('accounts.antigravity.clear')).toEqual([{}])

    expect((within(section).getByRole('button', { name: 'New login' }) as HTMLButtonElement).disabled).toBe(false)
    await act(async () => { fireEvent.click(within(section).getByRole('button', { name: 'New login' })) })
    expect(bridge.bodiesOf('accounts.antigravity.login')).toEqual([{}])

    const removeButtons = within(section).getAllByRole('button', { name: 'Remove' })
    fireEvent.click(removeButtons[0]!)
    await act(async () => { fireEvent.click(within(section).getByRole('button', { name: 'Confirm remove' })) })
    expect(bridge.bodiesOf('accounts.antigravity.remove')).toEqual([{ slotId: 'alice-1234' }])
  })
})
