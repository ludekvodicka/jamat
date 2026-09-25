import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AppClientUiBridge } from '../../../../../shared/appClientUiIpc'
import { SessionsGroupsState, type SessionGroupDefinition } from '../../../../../shared/sessionsGroupsState'
import { SessionGroupsSettingsTab } from './sessionGroupsSettingsTab'

describe('app-client-ui/renderer/overlays/configuration/tabs/sessionGroups/sessionGroupsSettingsTab', () => {
  type BridgeStub = {
    sessionGroups: Pick<AppClientUiBridge['sessionGroups'], 'getGroups' | 'saveGroups'>
  }

  afterEach(() => {
    cleanup()
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  async function mount(stored: readonly SessionGroupDefinition[] = SessionsGroupsState.defaultsConst) {
    const saved: unknown[] = []
    ;(window as unknown as { appClient: BridgeStub }).appClient = {
      sessionGroups: {
        getGroups: () => Promise.resolve({ ok: true, value: stored }),
        saveGroups: (value) => {
          saved.push(value)
          return Promise.resolve({ ok: true, value: { ok: true } })
        },
      },
    }
    const onDirtyChange = vi.fn()
    const view = render(<SessionGroupsSettingsTab onDirtyChange={onDirtyChange} />)
    await act(async () => Promise.resolve())
    return { onDirtyChange, saved, view }
  }

  /** The order of the rows IS the order of the sections, so it is read off the DOM in order. */
  function rows(): string[] {
    return [...document.querySelectorAll('.jamat-configuration-session-groups__entry')]
      .map((row) => row.querySelector('input')!.value)
  }

  it('draws the stored sections in order, Completed above Blocked', async () => {
    await mount()

    expect(rows()).toEqual([
      'Pinned', 'Priority', 'Sessions', 'Automation', 'Waiting', 'Completed', 'Blocked',
    ])
  })

  /*
   * Every row draws the same five cells, editable or not, which is what keeps the fields one length
   * and the buttons in one line. A fixed row differs in what its cells DO: the field is disabled and
   * the last cell holds no button.
   */
  it('gives every row the same cells and disables the two it may not rename', async () => {
    const { view } = await mount()
    const cellsOf = (id: string): number =>
      view.container.querySelector(`input[aria-label="Name of ${id}"]`)!.parentElement!.children.length

    for (const id of ['pinned', 'none', 'waiting']) expect(cellsOf(id)).toBe(5)
    for (const id of ['none', 'pinned'])
      expect(view.container.querySelector(`input[aria-label="Name of ${id}"]`)).toBeDisabled()
    expect(view.container.querySelector('input[aria-label="Name of waiting"]')).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Remove Sessions' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove Pinned' })).toBeNull()
  })

  /*
   * Moving them is what decides which sections a person reads above their own work and which below,
   * and it is the whole reason the two are listed rather than implied around the list.
   */
  it('lets the fixed rows move', async () => {
    const { saved, view } = await mount()

    fireEvent.click(screen.getByRole('button', { name: 'Move Sessions up' }))
    await act(async () => { fireEvent.click(view.getByText('Save')) })
    expect((saved[0] as readonly SessionGroupDefinition[]).map((one) => one.id).slice(0, 3))
      .toEqual(['pinned', 'none', 'priority'])
  })

  it('adds a section under the name typed, and clears the field', async () => {
    const { saved, view } = await mount()
    const field = screen.getByLabelText('Name of the new group')

    expect(screen.getByRole('button', { name: 'Add group' })).toBeDisabled()
    fireEvent.change(field, { target: { value: 'Needs review' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add group' }))
    expect((field as HTMLInputElement).value).toBe('')
    expect(rows()).toContain('Needs review')
    await act(async () => { fireEvent.click(view.getByText('Save')) })

    expect((saved[0] as readonly SessionGroupDefinition[]).at(-1))
      .toEqual({ id: 'needs-review', title: 'Needs review' })
  })

  /*
   * Removing a section takes every assignment to it with it, which the file cannot show afterwards,
   * so the first click only arms the second one.
   */
  it('takes two clicks to remove a section', async () => {
    await mount()

    fireEvent.click(screen.getByRole('button', { name: 'Remove Blocked' }))
    expect(rows()).toContain('Blocked')
    const armed = screen.getByRole('button', { name: 'Remove Blocked and unfile its sessions' })
    expect(armed).toHaveTextContent('Confirm')
    fireEvent.click(armed)
    expect(rows()).not.toContain('Blocked')
  })

  it('refuses a save whose name is empty and says which rule it breaks', async () => {
    const { saved, view } = await mount()

    fireEvent.change(screen.getByLabelText('Name of waiting'), { target: { value: '' } })
    expect(view.getByText(/every session group needs an id/)).toBeInTheDocument()
    expect(view.getByText('Save')).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Name of waiting'), { target: { value: 'Parked' } })
    await act(async () => { fireEvent.click(view.getByText('Save')) })
    expect((saved[0] as readonly SessionGroupDefinition[])
      .find((one) => one.id === 'waiting')).toEqual({ id: 'waiting', title: 'Parked' })
  })

  it('tells the window there is something to lose, and that there is not once it lands', async () => {
    const { onDirtyChange, view } = await mount()

    fireEvent.click(screen.getByRole('button', { name: 'Move Blocked up' }))
    expect(onDirtyChange).toHaveBeenCalledWith(true)
    await act(async () => { fireEvent.click(view.getByText('Save')) })
    expect(onDirtyChange.mock.calls).toEqual([[true], [false]])
  })
})
