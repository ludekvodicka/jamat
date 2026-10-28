import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { IDockviewPanelProps } from 'dockview'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SnapinView } from '../../../lib-orchestrator/snapins/snapinsApi.types'
import { AppControl } from '../ipc/appControl'
import { SnapinPanel } from './snapinPanel'

let visibility: (event: { isVisible: boolean }) => void
let push: (event: { kind: string }) => void
let snapshot: SnapinView
function props(kind: string): IDockviewPanelProps {
  return { params: { kind }, api: { isVisible: true, onDidVisibilityChange: (callback: typeof visibility) => {
    visibility = callback
    return { dispose: vi.fn() }
  } } } as unknown as IDockviewPanelProps
}
beforeEach(() => {
  vi.useFakeTimers()
  snapshot = { kind: 'test', title: 'Test snap-in', state: 'idle', revision: 1, counts: {}, sections: [{ kind: 'items',
    groups: [{ title: 'Project', items: [{ key: 'one', title: 'One', state: 'ready', tone: 'neutral', selectable: true, actions: [] }] }],
    actions: [{ id: 'future.action', label: 'Process', scope: 'selection', tone: 'primary' }] }] }
  vi.spyOn(AppControl, 'value').mockImplementation(async (operation) => ({ ok: true, value: operation === 'snapins.list'
    ? { kinds: [{ kind: 'test', title: 'Test snap-in', state: 'idle' }] } : snapshot }) as never)
  vi.spyOn(AppControl, 'call').mockResolvedValue({ ok: true, value: { ok: true, value: { accepted: true } } } as never)
  Object.defineProperty(window, 'appClient', { configurable: true, value: { onSnapinsChanged: (callback: typeof push) => { push = callback; return vi.fn() } } })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })
async function mount(kind: string) { await act(async () => { render(<SnapinPanel {...props(kind)} />) }) }

it('reads the catalog once and never reads an unknown kind', async () => {
  await mount('gone')
  expect(screen.getByText('This snap-in is no longer available')).toBeTruthy()
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
  expect(AppControl.value).toHaveBeenCalledTimes(1)
  expect(AppControl.value).toHaveBeenCalledWith('snapins.list', {})
})
it('forwards an unseen action with kind and selected item keys, keeping selection across pushes', async () => {
  await mount('test')
  fireEvent.click(screen.getByRole('checkbox'))
  snapshot = { ...snapshot, revision: 2 }
  await act(async () => { push({ kind: 'test' }); await vi.advanceTimersByTimeAsync(100) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Process' })) })
  expect(AppControl.call).toHaveBeenCalledWith('snapins.press', { kind: 'test', actionId: 'future.action', itemKeys: ['one'] })
})
it('asks for a listing each time the panel is shown and never on a timer', async () => {
  const refresh = ['snapins.press', { kind: 'test', actionId: 'shared.refresh' }]
  await mount('test')
  expect(AppControl.call).toHaveBeenCalledTimes(1)
  expect(AppControl.call).toHaveBeenCalledWith(...refresh)
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
  expect(AppControl.call).toHaveBeenCalledTimes(1)
  expect(AppControl.value).toHaveBeenCalledTimes(2)
  act(() => visibility({ isVisible: false }))
  act(() => visibility({ isVisible: true }))
  expect(AppControl.call).toHaveBeenCalledTimes(2)
  expect(AppControl.call).toHaveBeenLastCalledWith(...refresh)
})
