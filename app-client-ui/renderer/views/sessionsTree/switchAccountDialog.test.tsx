import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AccountView } from '../../../../lib-orchestrator/agentAccounts/agentAccountsApi.types'
import { ControlBridgeFixture } from '../../ipc/fixtures/controlBridgeFixture'
import { SwitchAccountDialog } from './switchAccountDialog'
import { SessionsTreeContextMenu } from './sessionsTreeContextMenu'
import { CommandRegistry } from '../../commands/commandRegistry'

const account = (accountId: string): AccountView => ({ agentId: 'claude', accountId, label: accountId,
  isMain: accountId === 'main', state: 'active', identity: null, profileProblem: null })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function control(fixture: ControlBridgeFixture) { Object.defineProperty(window, 'appClient', { configurable: true, value: { control: fixture.bridge() } }) }

it('preselects the recommendation and sends one explicit account switch', async () => {
  const fixture = new ControlBridgeFixture().on('sessions.switchAccount', { ok: true, value: { sessionId: 's' } })
  control(fixture)
  const close = vi.fn()
  const view = render(<SwitchAccountDialog sessionId="s" accounts={[account('b'), { ...account('c'), defaultChoice: { noFreeAccount: false, resetsAt: null } }]} onClose={close} />)
  expect(view.getByRole('combobox')).toHaveValue('c')
  fireEvent.click(view.getByRole('button', { name: 'Continue' }))
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1))
  expect(fixture.bodiesOf('sessions.switchAccount')).toEqual([{ session: { kind: 'sessionId', sessionId: 's' }, accountId: 'c' }])
})

it('keeps the selected account and shows a failed restart', async () => {
  control(new ControlBridgeFixture().on('sessions.switchAccount', { ok: false, error: { code: 'operation-failed', detail: 'restart failed' } }))
  const close = vi.fn()
  const view = render(<SwitchAccountDialog sessionId="s" accounts={[account('b')]} onClose={close} />)
  fireEvent.click(view.getByRole('button', { name: 'Continue' }))
  expect(await view.findByRole('alert')).toHaveTextContent('restart failed')
  expect(view.getByRole('combobox')).toHaveValue('b')
  expect(close).not.toHaveBeenCalled()
})

it('hands the account choice to its persistent owner and closes the transient menu', async () => {
  const fixture = new ControlBridgeFixture().on('accounts.list', { ok: true, value: [account('main'), account('b')] })
  control(fixture)
  const close = vi.fn()
  const choose = vi.fn()
  const view = render(<SessionsTreeContextMenu sessionId="s" position={{ x: 0, y: 0 }} commands={new CommandRegistry()}
    facts={{ agentId: 'claude', accountId: 'main', live: true, ended: false, admits: ['restart'], color: null, directoryPath: null, finish: false }}
    actions={[]} onAction={() => {}} onSwitchAccount={choose} onClose={close} />)
  fireEvent.click(await view.findByRole('menuitem', { name: 'Continue on another account…' }))
  expect(choose).toHaveBeenCalledWith([account('b')])
  expect(close).toHaveBeenCalledTimes(1)
  expect(fixture.bodiesOf('accounts.list')).toEqual([{ excludeAccount: { agentId: 'claude', accountId: 'main' } }])
})

it('hides the action for the single Codex account', async () => {
  const fixture = new ControlBridgeFixture().on('accounts.list', { ok: true, value: [{ ...account('main'), agentId: 'codex' }] })
  control(fixture)
  const view = render(<SessionsTreeContextMenu sessionId="s" position={{ x: 0, y: 0 }} commands={new CommandRegistry()}
    facts={{ agentId: 'codex', live: true, ended: false, admits: ['restart'], color: null, directoryPath: null, finish: false }}
    actions={[]} onAction={() => {}} onSwitchAccount={() => {}} onClose={() => {}} />)
  await waitFor(() => expect(fixture.calls).toHaveLength(1))
  expect(view.queryByRole('menuitem', { name: 'Continue on another account…' })).toBeNull()
})

it.each(['success', 'failure', 'throw'] as const)('ignores asynchronous %s after actual disposal', async outcome => {
  let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  control(new ControlBridgeFixture().on('sessions.switchAccount', async () => {
    await pending
    if (outcome === 'success') return { ok: true, value: {} }
    else if (outcome === 'failure') return { ok: false, error: { code: 'operation-failed', detail: 'late failure' } }
    else if (outcome === 'throw') throw new Error('late exception')
    else throw new Error(`Unknown outcome: ${outcome}`)
  }))
  const close = vi.fn()
  const view = render(<SwitchAccountDialog sessionId="s" accounts={[account('b')]} onClose={close} />)
  fireEvent.click(view.getByRole('button', { name: 'Continue' }))
  view.unmount()
  await act(async () => { finish(); await pending })
  expect(close).not.toHaveBeenCalled()
  expect(view.queryByRole('dialog')).toBeNull()
})
