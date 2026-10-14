import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SessionSvnConflictInfo, SvnConflictState } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { ConflictGroups, ConflictList, type ConflictListPorts } from './conflictList'

describe('app-client-ui/renderer/workflow/conflictList', () => {
  afterEach(() => cleanup())

  const portsOf = (): ConflictListPorts => ({
    resolve: vi.fn(async () => null), openFile: vi.fn(async () => null), openConflictEditor: vi.fn(async () => null), openBrief: vi.fn(async () => null),
  })

  const entry = (path: string, state: SvnConflictState, extra?: Partial<SessionSvnConflictInfo>): SessionSvnConflictInfo => ({
    path, kind: 'text', state, description: `${path} changed on both sides.`, by: null, saved: null, options: [], ...extra,
  })

  it('draws three groups from a mixed list, in the order fixed, the merger\'s, the person\'s, with the library\'s words', () => {
    render(<ConflictList summary="4 conflicts: Jamat fixed 1, merger on 1, 2 need you" conflicts={{ more: 0, entries: [
      entry('.aidocs/engines', 'person', { kind: 'tree', description: 'Your session added this folder with 2 files; r421 added it with 3 files.' }),
      entry('src/a.ts', 'agent'),
      entry('docs/x.md', 'rule', { by: 'jamat', saved: 'L:/results/a1/saved/docs/x.md' }),
      entry('src/b.ts', 'person'),
    ] }} ports={portsOf()} />)

    const list = screen.getByRole('region', { name: '4 conflicts: Jamat fixed 1, merger on 1, 2 need you' })
    expect(within(list).getAllByRole('heading').map((heading) => heading.textContent)).toEqual(['Fixed', 'Merger works on', 'Needs you'])
    const person = within(list).getByRole('region', { name: 'Needs you' })
    expect(within(person).getAllByRole('listitem').map((row) => row.querySelector('.workflow__conflict-path')?.textContent))
      .toEqual(['.aidocs/engines', 'src/b.ts'])
    expect(within(person).getByText('Your session added this folder with 2 files; r421 added it with 3 files.')).toBeTruthy()
    const fixed = within(list).getByRole('region', { name: 'Fixed' })
    expect(within(fixed).getByText('fixed by Jamat')).toBeTruthy()
    expect(within(fixed).getByText('L:/results/a1/saved/docs/x.md')).toBeTruthy()
    expect(screen.queryByText(/more not shown here/)).toBeNull()
  })

  it('names how many more the set holds and the command that lists them all', () => {
    render(<ConflictList summary="60 conflicts need you" conflicts={{ more: 10, entries: [entry('a.ts', 'person')] }} ports={portsOf()} />)
    expect(screen.getByText(/10 more not shown here/).textContent).toBe('10 more not shown here; jamat-v3 sessions conflicts lists them all.')
  })

  it('draws Open and Edit in TortoiseSVN on each row, and shows a refusal on its own row until the next opener of that row works', async () => {
    const ports = portsOf()
    vi.mocked(ports.openConflictEditor).mockResolvedValueOnce('The conflict editor of TortoiseSVN is unavailable: C:/Program Files/TortoiseSVN/bin/TortoiseProc.exe')
    render(<ConflictList summary="2 conflicts need you" conflicts={{ more: 0, entries: [
      entry('.aidocs/engines', 'person', { kind: 'tree' }), entry('src/catalog.ts', 'person'),
    ] }} ports={ports} />)
    const rows = screen.getAllByRole('listitem')
    expect(rows.map((row) => within(row).getAllByRole('button').map((button) => button.textContent)))
      .toEqual([['Open', 'Edit in TortoiseSVN'], ['Open', 'Edit in TortoiseSVN']])

    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Edit in TortoiseSVN' }))
    await waitFor(() => expect(within(rows[0]).getByRole('alert').textContent).toBe('The conflict editor of TortoiseSVN is unavailable: C:/Program Files/TortoiseSVN/bin/TortoiseProc.exe'))
    expect(within(rows[1]).queryByRole('alert')).toBeNull()
    expect(ports.openConflictEditor).toHaveBeenCalledWith('.aidocs/engines')

    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Open' }))
    await waitFor(() => expect(ports.openFile).toHaveBeenCalledWith('src/catalog.ts'))
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Open' }))
    await waitFor(() => expect(within(rows[0]).queryByRole('alert')).toBeNull())
  })

  const folderOptions = [
    { id: 'keep-both' as const, label: 'Keep both', note: 'restores the files r2 added and keeps the session\'s files beside them', loses: 'nothing' as const },
    { id: 'take-incoming' as const, label: 'Take incoming', note: 'restores what r2 added; the session\'s files are saved first, then removed', loses: 'mine' as const },
    { id: 'keep-mine' as const, label: 'Keep mine', note: 'keeps the session\'s version; the commit would delete the 3 files r2 added', loses: 'incoming' as const },
  ]

  it('draws one button per admitted option with the labels of the wire, on open rows only', () => {
    render(<ConflictList summary="2 conflicts: you fixed 1, 1 needs you" conflicts={{ more: 0, entries: [
      entry('.aidocs/engines', 'person', { kind: 'tree', options: folderOptions }),
      entry('src/catalog.ts', 'settled', { by: 'person', options: folderOptions.slice(1) }),
    ] }} ports={portsOf()} />)
    const options = screen.getByRole('group', { name: 'Options for .aidocs/engines' })
    expect(within(options).getAllByRole('button').map((button) => [button.textContent, button.getAttribute('title')])).toEqual([
      ['Keep both', folderOptions[0].note], ['Take incoming', folderOptions[1].note], ['Keep mine', folderOptions[2].note],
    ])
    expect(screen.queryByRole('group', { name: 'Options for src/catalog.ts' })).toBeNull()
  })

  it('asks before an option that loses incoming work: the first click warns, the second sends the confirmation, a click in between disarms', async () => {
    const ports = portsOf()
    render(<ConflictList summary="1 conflict needs you" conflicts={{ more: 0, entries: [
      entry('.aidocs/engines', 'person', { kind: 'tree', options: folderOptions }),
    ] }} ports={ports} />)
    const keepMine = (): HTMLElement => screen.getByRole('button', { name: /^Keep mine/ })

    fireEvent.click(keepMine())
    expect(screen.getByRole('alert').textContent).toBe('Keep mine: keeps the session\'s version; the commit would delete the 3 files r2 added. Click it again to confirm.')
    expect(keepMine().textContent).toBe('Keep mine?')
    expect(ports.resolve).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    fireEvent.click(keepMine())
    expect(ports.resolve).not.toHaveBeenCalled()
    fireEvent.click(keepMine())
    await waitFor(() => expect(ports.resolve).toHaveBeenCalledExactlyOnceWith('.aidocs/engines', 'keep-mine', true))

    fireEvent.click(screen.getByRole('button', { name: 'Keep both' }))
    await waitFor(() => expect(ports.resolve).toHaveBeenLastCalledWith('.aidocs/engines', 'keep-both', false))
  })

  it('shows a refusal of an option on its own row and changes nothing else', async () => {
    const ports = portsOf()
    vi.mocked(ports.resolve).mockResolvedValueOnce('Settle failed: keep-both on .aidocs/engines stopped: svn: E155010')
    render(<ConflictList summary="2 conflicts need you" conflicts={{ more: 0, entries: [
      entry('.aidocs/engines', 'person', { kind: 'tree', options: folderOptions }), entry('src/catalog.ts', 'person'),
    ] }} ports={ports} />)
    const rows = screen.getAllByRole('listitem')
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Keep both' }))
    await waitFor(() => expect(within(rows[0]).getByRole('alert').textContent).toBe('Settle failed: keep-both on .aidocs/engines stopped: svn: E155010'))
    expect(within(rows[1]).queryByRole('alert')).toBeNull()
    expect(rows[0].getAttribute('data-state')).toBe('person')
  })

  it('groups by state with a total switch: settled and rule are fixed, and an unknown state throws', () => {
    expect((['rule', 'settled', 'agent', 'person'] as const).map((state) => ConflictGroups.groupOf(state))).toEqual(['fixed', 'fixed', 'agent', 'person'])
    expect(() => ConflictGroups.groupOf('pondering' as SvnConflictState)).toThrow(/Unknown conflict state/)
    expect(() => ConflictGroups.of([entry('a.ts', 'pondering' as SvnConflictState)])).toThrow(/Unknown conflict state/)
  })
  it('offers the merger brief under the summary when the set has one, and shows a refusal to open it', async () => {
    const ports = portsOf()
    vi.mocked(ports.openBrief).mockResolvedValueOnce('Open brief failed: gone')
    render(<ConflictList summary="1 conflict needs you" mergeBrief="L:/logs/s1/a1-merge.md" conflicts={{ more: 0, entries: [entry('a.ts', 'person')] }} ports={ports} />)
    expect(screen.getByText('L:/logs/s1/a1-merge.md')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open brief' }))
    expect(ports.openBrief).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Open brief failed: gone')).toBeTruthy()
  })

  it('offers no brief while the set has none', () => {
    render(<ConflictList summary="1 conflict needs you" conflicts={{ more: 0, entries: [entry('a.ts', 'person')] }} ports={portsOf()} />)
    expect(screen.queryByRole('button', { name: 'Open brief' })).toBeNull()
  })
})
