import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CustomTab } from './CustomTab'
import { useLayoutStore } from '../../store/layout-store'
import { TerminalPromptSubmitter } from '../../utils/terminalPromptSubmitter'

const SESSION_ID = '12345678-1234-1234-1234-123456789012'
const OTHER_SESSION_ID = '87654321-4321-4321-4321-210987654321'

function renderTab(params: Record<string, unknown> = {}) {
  const api = { id: 'panel-1', title: 'Project - Existing name', setActive: vi.fn(), setTitle: vi.fn() }
  const containerApi = { getPanel: vi.fn(), addPanel: vi.fn(), removePanel: vi.fn() }
  const renderResult = render(<CustomTab {...({
    api,
    containerApi,
    params: { agent: 'codex', projectDir: 'Q:\\Project', folderName: 'Project', ...params },
  } as any)} />)
  return { ...renderResult, api, containerApi }
}

function openSessionDetails(): void {
  act(() => window.dispatchEvent(new CustomEvent('edit-session-details', { detail: 'panel-1' })))
}

afterEach(() => {
  vi.restoreAllMocks()
  delete (window as any).electronAPI
  useLayoutStore.setState({
    terminalPhases: {},
    sessionRuntimeByPanel: {},
    agentsMeta: null,
  })
})

describe('AppElectron/Src/Renderer/Components/Layout/CustomTab', () => {
  it('polls a running Codex tab through the shared capability and clears it in menu phase', async () => {
    const info = {
      model: 'gpt-5.6-sol',
      modelLabel: 'GPT-5.6 Sol',
      contextTokens: 103147,
      contextWindow: 258400,
      effortLevel: 'max',
    }
    const getSessionModel = vi.fn(async () => info)
    ;(window as any).electronAPI = { getSessionModel }
    useLayoutStore.setState({ terminalPhases: { 'panel-1': 'running' } })
    const api = { id: 'panel-1', title: 'Project - Codex', setActive: vi.fn(), setTitle: vi.fn() }
    const containerApi = { getPanel: vi.fn(), addPanel: vi.fn(), removePanel: vi.fn() }
    render(<CustomTab {...({
      api,
      containerApi,
      params: { agent: 'codex', projectDir: 'Q:\\Project', sessionId: SESSION_ID },
    } as any)} />)

    await waitFor(() => expect(getSessionModel).toHaveBeenCalledWith('Q:\\Project', SESSION_ID))
    await waitFor(() => expect(useLayoutStore.getState().sessionRuntimeByPanel['panel-1']).toEqual(info))

    act(() => useLayoutStore.getState().setTerminalPhase('panel-1', 'menu'))
    await waitFor(() => expect(useLayoutStore.getState().sessionRuntimeByPanel['panel-1']).toBeUndefined())
  })

  it('loads the saved description and saves a description-only edit without renaming or terminal input', async () => {
    const loadSessionDescription = vi.fn(async () => ({ ok: true, description: 'Original note' }))
    const saveSessionDescription = vi.fn(async () => ({ ok: true, description: 'Updated note' }))
    const renameSession = vi.fn()
    ;(window as any).electronAPI = { loadSessionDescription, saveSessionDescription, renameSession }
    const submit = vi.spyOn(TerminalPromptSubmitter, 'submit').mockReturnValue(true)
    const { api } = renderTab({ sessionId: SESSION_ID })

    openSessionDetails()
    const description = await screen.findByLabelText(/Description/)
    await waitFor(() => expect((description as HTMLTextAreaElement).value).toBe('Original note'))
    fireEvent.change(description, { target: { value: '  Updated note  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(saveSessionDescription).toHaveBeenCalledWith(SESSION_ID, 'Updated note'))
    await waitFor(() => expect(screen.queryByText('Session details')).toBeNull())
    expect(renameSession).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
    expect(api.setTitle).not.toHaveBeenCalled()
  })

  it('does not repeat a successful native rename when description persistence is retried', async () => {
    const loadSessionDescription = vi.fn(async () => ({ ok: true, description: 'Original note' }))
    const saveSessionDescription = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: 'description write failed' })
      .mockResolvedValueOnce({ ok: true, description: 'Updated note' })
    const renameSession = vi.fn(async () => ({ ok: true, sessionId: SESSION_ID }))
    ;(window as any).electronAPI = { loadSessionDescription, saveSessionDescription, renameSession }
    const submit = vi.spyOn(TerminalPromptSubmitter, 'submit').mockReturnValue(true)
    const { api } = renderTab({ sessionId: SESSION_ID })

    openSessionDetails()
    const name = await screen.findByLabelText('Name')
    const description = await screen.findByLabelText(/Description/)
    await waitFor(() => expect((description as HTMLTextAreaElement).value).toBe('Original note'))
    fireEvent.change(name, { target: { value: 'New name' } })
    fireEvent.change(description, { target: { value: 'Updated note' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await screen.findByText('description write failed')
    expect(renameSession).toHaveBeenCalledTimes(1)
    expect(renameSession).toHaveBeenCalledWith('Q:\\Project', SESSION_ID, 'New name')
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledWith('panel-1', '/rename New name')
    expect(api.setTitle).toHaveBeenCalledWith('Project - New name')

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByText('Session details')).toBeNull())
    expect(renameSession).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(saveSessionDescription).toHaveBeenCalledTimes(2)
  })

  it('falls back to the live TUI rename when a just-created session has no transcript yet', async () => {
    const loadSessionDescription = vi.fn(async () => ({ ok: true, description: '' }))
    const saveSessionDescription = vi.fn()
    const renameSession = vi.fn(async () => ({ ok: false, error: 'session transcript not found' }))
    ;(window as any).electronAPI = { loadSessionDescription, saveSessionDescription, renameSession }
    const submit = vi.spyOn(TerminalPromptSubmitter, 'submit').mockReturnValue(true)
    const { api } = renderTab({ sessionId: SESSION_ID })

    openSessionDetails()
    const name = await screen.findByLabelText('Name')
    fireEvent.change(name, { target: { value: 'New name' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(screen.queryByText('Session details')).toBeNull())
    expect(renameSession).toHaveBeenCalledWith('Q:\\Project', SESSION_ID, 'New name')
    expect(submit).toHaveBeenCalledWith('panel-1', '/rename New name')
    expect(api.setTitle).toHaveBeenCalledWith('Project - New name')
    expect(screen.queryByText('session transcript not found')).toBeNull()
    expect(saveSessionDescription).not.toHaveBeenCalled()
  })

  it('clears a saved description through the sparse-map delete path', async () => {
    const loadSessionDescription = vi.fn(async () => ({ ok: true, description: 'Remove me' }))
    const saveSessionDescription = vi.fn(async () => ({ ok: true, description: '' }))
    ;(window as any).electronAPI = { loadSessionDescription, saveSessionDescription, renameSession: vi.fn() }
    renderTab({ sessionId: SESSION_ID })

    openSessionDetails()
    const description = await screen.findByLabelText(/Description/)
    await waitFor(() => expect((description as HTMLTextAreaElement).value).toBe('Remove me'))
    fireEvent.change(description, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(saveSessionDescription).toHaveBeenCalledWith(SESSION_ID, ''))
  })

  it('keeps description disabled until a new tab receives its authoritative session id', async () => {
    const loadSessionDescription = vi.fn(async () => ({ ok: true, description: 'Resolved note' }))
    ;(window as any).electronAPI = { loadSessionDescription, saveSessionDescription: vi.fn(), renameSession: vi.fn() }
    const { rerender, api, containerApi } = renderTab()

    openSessionDetails()
    const description = await screen.findByLabelText(/Description/)
    expect((description as HTMLTextAreaElement).disabled).toBe(true)
    screen.getByText(/becomes available when this new session receives its session id/)
    expect(loadSessionDescription).not.toHaveBeenCalled()

    rerender(<CustomTab {...({
      api,
      containerApi,
      params: { agent: 'codex', projectDir: 'Q:\\Project', folderName: 'Project', sessionId: OTHER_SESSION_ID },
    } as any)} />)
    await waitFor(() => expect(loadSessionDescription).toHaveBeenCalledWith(OTHER_SESSION_ID))
    await waitFor(() => expect((description as HTMLTextAreaElement).disabled).toBe(false))
    expect((description as HTMLTextAreaElement).value).toBe('Resolved note')
  })

  it('ignores a description load that resolves after the dialog closes', async () => {
    let resolveLoad: ((value: { ok: true; description: string }) => void) | null = null
    const loadSessionDescription = vi.fn(() => new Promise<{ ok: true; description: string }>((resolve) => {
      resolveLoad = resolve
    }))
    ;(window as any).electronAPI = { loadSessionDescription, saveSessionDescription: vi.fn(), renameSession: vi.fn() }
    renderTab({ sessionId: SESSION_ID })

    openSessionDetails()
    await screen.findByText('Loading the saved description…')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText('Session details')).toBeNull()

    await act(async () => { resolveLoad?.({ ok: true, description: 'Late result' }) })
    expect(screen.queryByText('Late result')).toBeNull()
  })

  it('does not expose local session details on a Remote Viewer tab', () => {
    const loadSessionDescription = vi.fn(async () => ({ ok: true, description: 'Remote note' }))
    ;(window as any).electronAPI = { loadSessionDescription }
    renderTab({ sessionId: SESSION_ID, peer: { name: 'remote' }, terminalId: 'terminal-1' })

    openSessionDetails()
    expect(screen.queryByText('Session details')).toBeNull()
    expect(loadSessionDescription).not.toHaveBeenCalled()
  })
})
