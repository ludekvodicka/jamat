import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountView } from '../../../../../../lib-orchestrator/agentAccounts/agentAccountsApi.types'
import type { AppClientUiBridge } from '../../../../../shared/appClientUiIpc'
import { ControlBridgeFixture } from '../../../../ipc/fixtures/controlBridgeFixture'
import { AccountsTab } from './accountsTab'
import { ConfigurationOverlay } from '../../configurationOverlay'
import { WorktreeSetupIntentStore } from '../../worktreeSetupIntentStore'
import { ConfigurationLastTab } from '../../configurationLastTab'

const main: AccountView = { agentId: 'claude', accountId: 'main', label: 'Main', isMain: true, state: 'active', identity: null, profileProblem: null }
let views: readonly AccountView[]
let bridge: ControlBridgeFixture
let changed: () => void
let unsubscribe = vi.fn<() => void>()
beforeEach(() => {
  views = [main, { ...main, accountId: 'work', label: 'Work', isMain: false, state: 'pending-login', profileProblem: 'Profile needs attention' }]
  bridge = new ControlBridgeFixture().on('accounts.list', () => ({ ok: true, value: views }))
    .on('accounts.add', { ok: true, value: { accountId: 'new' } }).on('accounts.login', { ok: true, value: { sessionId: 'terminal' } })
    .on('accounts.rename', { ok: true, value: {} }).on('accounts.setEnabled', { ok: true, value: {} }).on('accounts.remove', { ok: true, value: {} })
  unsubscribe = vi.fn<() => void>()
  vi.stubGlobal('appClient', { control: bridge.bridge(), onAgentSettingsChanged: listener => { changed = listener; return unsubscribe } } satisfies Pick<AppClientUiBridge, 'control' | 'onAgentSettingsChanged'>)
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
})
