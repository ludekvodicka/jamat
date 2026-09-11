import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LauncherRemoteWorkspace } from './launcherRemoteWorkspace'
import { LauncherComputersScreen } from './launcherComputersScreen'
import { ComputersScreenModel } from './computersScreenModel'
import type { ComputerRow } from './computersScreenModel'

function computer(): ComputerRow {
  return { remoteEndpointId: 'endpoint-a', displayName: 'DESKTOP-A', endpointLabel: '10.0.0.25:47150',
    status: 'idle', error: null, sessionCount: null, sessions: null, selectedSessionIds: [] }
}

describe('AppClientUi/Renderer/Overlays/Launcher/Computers/LauncherComputersScreen', () => {
  it('opening and selecting a computer sends nothing, and Connect explicitly names the selected computer', () => {
    const dispatch = vi.fn()
    const state = { loaded: true, rows: [computer()], cursor: 0 }
    const view = render(<LauncherRemoteWorkspace state={state} dispatch={dispatch}
      creating={false} configuring={false} locked={false} onSessions={vi.fn()} onProjects={vi.fn()}>
      <LauncherComputersScreen state={state} dispatch={dispatch} />
    </LauncherRemoteWorkspace>)
    expect(dispatch).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('option'))
    expect(dispatch).toHaveBeenLastCalledWith({ input: 'setCursor', index: 0 })
    expect(ComputersScreenModel.transition(state, dispatch.mock.calls[0]![0]).effects).toEqual([])
    fireEvent.click(view.getByRole('button', { name: 'Connect' }))
    expect(dispatch).toHaveBeenLastCalledWith({ input: 'activate' })
    expect(ComputersScreenModel.transition(state, { input: 'activate' }).effects)
      .toEqual([{ effect: 'connect', remoteEndpointId: 'endpoint-a' }])
  })

  it('lists and filters remote sessions, connects one by ID and marks an already selected session', () => {
    const dispatch = vi.fn()
    const endpoint: ComputerRow = { ...computer(), status: 'connected', selectedSessionIds: ['one'], sessions: {
      revision: 1, reconciled: true, host: { presence: 'running', hostVersion: 'test', hostInstanceId: 'host', liveCount: 2, lastStartError: null },
      categories: [{ id: 'ai', label: 'Projects', path: 'Q:/Projects' }], orphans: [],
      sessions: ['one', 'two'].map((id) => ({ sessionId: id, kind: 'agent', title: id, titleParts: {number:null,name:id}, tabTitle: id,
        directory: {mode:'project',categoryId:'ai',projectPath:`Q:/Projects/${id}`},
        project: {kind:'project',categoryId:'ai',projectPath:`Q:/Projects/${id}`,projectName:id},
        life:'live',activity:'idle',admits:[] })),
    } }
    const state = { loaded:true,rows:[endpoint],cursor:0 }
    const view = render(<LauncherComputersScreen state={state} dispatch={dispatch} />)
    expect(view.getByRole('button', { name:'Connected one' })).toBeDisabled()
    fireEvent.click(view.getByRole('button', { name: 'Collapse Projects' }))
    expect(view.queryByRole('button', { name: 'Connect two' })).toBeNull()
    fireEvent.change(view.getByRole('searchbox'), { target:{value:'two'} })
    expect(view.queryByRole('button', { name: 'Connected one' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name:'Connect two' }))
    expect(dispatch).toHaveBeenLastCalledWith({input:'selectSession',sessionId:'two'})
    expect(view.getByRole('treegrid')).toBeTruthy()
    expect(view.getByRole('columnheader', { name: 'Directory' })).toBeTruthy()
    expect(ComputersScreenModel.transition(state, {input:'selectSession',sessionId:'two'}).effects)
      .toEqual([{ effect:'selectSession',remoteEndpointId:'endpoint-a',sessionId:'two',tabTitle:'two' }])
  })
})
