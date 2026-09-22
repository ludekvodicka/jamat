import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppClientUiBridge } from '../../../../shared/appClientUiIpc'
import type { HistoricSession } from '../../../../shared/historicSessions'
import type { PanelOpenOutcome } from '../../../shell/appShell.types'
import { LauncherIntentStore } from '../launcherIntentStore'
import { LauncherOverlay } from '../launcherOverlay'

describe('app-client-ui/renderer/overlays/launcher/history/historicSessionsOverlay', () => {
  function session(nativeSessionId: string, lastActivity: number | null, title: string, agentId: 'claude' | 'codex' = 'claude',
    endedAt: number | null = null): HistoricSession {
    return { nativeSessionId, lastActivity, title, agentId, firstUserMessage: null, createdAt: 1_000, endedAt, active: false, model: `${agentId}-model` }
  }

  function mount(options?: {
    rows?: HistoricSession[]
    project?: AppClientUiBridge['historicSessions']['project']
    appJamat?: AppClientUiBridge['historicSessions']['appJamat']
    projectNames?: string[]
    openTerminal?: () => Promise<PanelOpenOutcome>
  }) {
    const project = vi.fn(options?.project ?? (async () => ({ ok: true as const, value: { ok: true as const, value: options?.rows ?? [session('old', 2_000, 'Old task'), session('new', 3_000, 'New task', 'codex')] } })))
    const appJamat = vi.fn(options?.appJamat ?? (async () => ({ ok: true as const, value: [{
      root: { id: 'root', label: 'Applications', path: 'Q:/Apps' },
      project: { name: 'App', path: 'Q:/Apps/App' },
      sessions: options?.rows ?? [session('old', 2_000, 'Old task'), session('new', 3_000, 'New task', 'codex')],
    }] })))
    const openHistory = vi.fn(async () => ({ ok: true as const, value: { ok: true as const, value: { sessionId: 'opened', tabTitle: 'App - 014' } } }))
    const bridge = {
      projects: {
        categories: async () => ({ ok: true, value: [{ id: 'root', label: 'Applications', path: 'Q:/Apps', available: true }] }),
        list: async () => ({ ok: true, value: { ok: true, value: { projects: (options?.projectNames ?? ['App']).map((name) => ({ name, path: `Q:/Apps/${name}`, lastActivity: null })), entries: [], virtualFolders: [], available: true, truncated: false } } }),
      },
      historicSessions: { project, appJamat },
      sessions: { openHistory },
      tabs: { publishTerminalRestarted: vi.fn(async () => ({ ok: true as const, value: undefined })) },
    }
    Object.defineProperty(window, 'appClient', { configurable: true, value: bridge as unknown as AppClientUiBridge })
    const intents = new LauncherIntentStore()
    intents.set({ purpose: 'history' })
    const onClose = vi.fn()
    const onOpenTerminal = vi.fn(options?.openTerminal ?? (async () => ({ kind: 'opened' as const, panelId: 'tab' })))
    const view = render(<LauncherOverlay intents={intents} onClose={onClose} onOpenTerminal={onOpenTerminal} onOpenRemoteSettings={vi.fn()} />)
    return { ...view, project, appJamat, openHistory, onClose, onOpenTerminal }
  }

  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('shows an unknown last-use time without a fabricated date and sorts it after recorded input', async () => {
    const view = mount({ rows: [session('unknown', null, 'Unknown time'), session('known', 3_000, 'Known time')] })
    const rows = await view.findAllByRole('option')
    expect(rows[0]?.textContent).toContain('Known time')
    const lastUsed = rows[1]?.querySelectorAll('time')[1]
    expect(lastUsed?.textContent).toBe('Unknown')
    expect(lastUsed?.hasAttribute('datetime')).toBe(false)
    expect(lastUsed?.title).toContain('User input time was not recorded')
  })

  /** The column the list is ordered by, drawn from the record rather than guessed from a transcript. */
  it('draws the recorded end beside the last use and orders the list by it', async () => {
    const view = mount({ rows: [
      session('guessed', 9_000, 'Guessed end'),
      session('recorded', 3_000, 'Recorded end', 'claude', 12_000),
    ] })

    const rows = await view.findAllByRole('option')

    expect(rows[0]?.textContent).toContain('Recorded end')
    const ended = rows[0]?.querySelectorAll('time')[2]
    expect(ended?.getAttribute('datetime')).toBe(new Date(12_000).toISOString())
    expect(ended?.title).toBe('End recorded by AppJamat')
    const guessed = rows[1]?.querySelectorAll('time')[2]
    expect(guessed?.textContent?.startsWith('~')).toBe(true)
    expect(guessed?.title).toContain('No end was recorded')
  })

  it('focuses the filter, sorts newest first and reruns the row chosen with arrows', async () => {
    const view = mount()
    const filter = view.getByRole('combobox')
    expect(document.activeElement).toBe(filter)
    const rows = await view.findAllByRole('option')
    expect(rows[0]?.textContent).toContain('New task')
    expect(rows[1]?.textContent).toContain('Old task')
    expect(view.getByRole('button', { name: 'AppJamat' }).getAttribute('aria-pressed')).toBe('true')
    expect(view.project).not.toHaveBeenCalled()
    fireEvent.keyDown(filter, { key: 'ArrowDown' })
    expect(rows[1]?.getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(filter, { key: 'Enter' })
    await waitFor(() => expect(view.onClose).toHaveBeenCalledOnce())
    expect(view.openHistory).toHaveBeenCalledWith(expect.objectContaining({ nativeSessionId: 'old', action: 'rerun', directory: { mode: 'project', categoryId: 'root', projectPath: 'Q:/Apps/App' } }))
    expect(view.onOpenTerminal).toHaveBeenCalledWith({ kind: 'local', sessionId: 'opened' }, 'App - 014')
  })

  it('filters across root, directory, title and model, then forks the exact match', async () => {
    const view = mount()
    await view.findAllByRole('option')
    fireEvent.change(view.getByRole('combobox'), { target: { value: 'APPLICATIONS App Old claude-model' } })
    expect(view.getAllByRole('option')).toHaveLength(1)
    fireEvent.click(view.getByRole('button', { name: 'Fork' }))
    fireEvent.keyDown(view.getByRole('combobox'), { key: 'Enter' })
    await waitFor(() => expect(view.onClose).toHaveBeenCalledOnce())
    expect(view.openHistory).toHaveBeenCalledWith(expect.objectContaining({ nativeSessionId: 'old', action: 'fork' }))
  })

  /**
   * Every row here has ended - both sources drop what is still running - so both actions are open
   * on every row, and the card no longer has an action it must refuse.
   */
  it('opens a double-clicked row with the chosen action', async () => {
    const view = mount({ rows: [session('one', 4_000, 'One task')] })
    const row = await view.findByRole('option')
    expect(view.getByRole('button', { name: 'Re-run session' }).hasAttribute('disabled')).toBe(false)
    fireEvent.click(view.getByRole('button', { name: 'Fork' }))
    fireEvent.doubleClick(row)
    await waitFor(() => expect(view.openHistory).toHaveBeenCalledOnce())
  })

  it('keeps a failed tab open retry from forking a second session', async () => {
    let count = 0
    const view = mount({ openTerminal: async () => ++count === 1 ? { kind: 'failed', detail: 'Panel capacity reached' } : { kind: 'opened', panelId: 'tab' } })
    await view.findAllByRole('option')
    fireEvent.click(view.getByRole('button', { name: 'Fork' }))
    fireEvent.click(view.getByRole('button', { name: 'Fork session' }))
    expect((await view.findByRole('alert')).textContent).toBe('Panel capacity reached')
    fireEvent.click(view.getByRole('button', { name: 'Open started session' }))
    await waitFor(() => expect(view.onClose).toHaveBeenCalledOnce())
    expect(view.openHistory).toHaveBeenCalledOnce()
    expect(view.onOpenTerminal).toHaveBeenCalledTimes(2)
  })

  it('ignores composition Enter, reports no matches and traps Tab inside the dialog', async () => {
    const view = mount()
    await view.findAllByRole('option')
    const filter = view.getByRole('combobox')
    fireEvent.keyDown(filter, { key: 'Enter', isComposing: true })
    expect(view.openHistory).not.toHaveBeenCalled()
    fireEvent.change(filter, { target: { value: 'does not exist' } })
    expect(view.queryAllByRole('option')).toHaveLength(0)
    expect(view.getByText('No sessions match this filter.')).toBeTruthy()
    fireEvent.keyDown(filter, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(view.getByRole('button', { name: 'Close Historic sessions' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(view.onClose).toHaveBeenCalledOnce()
  })

  it('defaults to 2d and sends the selected rolling cutoff for every range', async () => {
    const now = Date.parse('2026-09-13T14:30:00Z')
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const view = mount()
    await view.findAllByRole('option')
    expect(view.getByRole('button', { name: '2d' }).getAttribute('aria-pressed')).toBe('true')
    expect(view.appJamat).toHaveBeenLastCalledWith(Date.parse('2026-09-11T14:30:00Z'))
    for (const [range, cutoff] of [
      ['1d', Date.parse('2026-09-12T14:30:00Z')],
      ['7d', Date.parse('2026-09-06T14:30:00Z')],
      ['1m', Date.parse('2026-08-14T14:30:00Z')],
      ['all', null],
    ] as const) {
      fireEvent.click(view.getByRole('button', { name: range }))
      await waitFor(() => expect(view.appJamat).toHaveBeenLastCalledWith(cutoff))
      await waitFor(() => expect(view.getByRole('listbox').getAttribute('aria-busy')).toBe('false'))
      expect(document.activeElement).toBe(view.getByRole('combobox'))
    }
  })

  it('shows sorted rows only after all projects finish and reports progress', async () => {
    let finish: () => void = () => undefined
    const pending = new Promise<void>((resolve) => { finish = resolve })
    const view = mount({ rows: [], projectNames: ['First', 'Second'], project: async (_root, name) => {
      if (name === 'Second') await pending
      return { ok: true, value: { ok: true, value: [session(name, name === 'Second' ? 3_000 : 2_000, name)] } }
    } })
    fireEvent.click(view.getByRole('button', { name: 'All' }))
    await view.findByText('Loading history… (1/2 projects)')
    expect(view.queryAllByRole('option')).toHaveLength(0)
    await act(async () => { finish(); await pending })
    const rows = await view.findAllByRole('option')
    expect(rows.map((row) => row.textContent)).toEqual([expect.stringContaining('Second'), expect.stringContaining('First')])
  })

  it('keeps the previous list while switching and ignores a late reply for a superseded range', async () => {
    let finish: () => void = () => undefined
    const pending = new Promise<void>((resolve) => { finish = resolve })
    const now = Date.parse('2026-09-13T14:30:00Z')
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const view = mount({ project: async (_root, _name, since) => {
      if (since === null) await pending
      return { ok: true, value: { ok: true, value: [session(`${since}`, now, `Range ${since}`)] } }
    } })
    fireEvent.click(view.getByRole('button', { name: 'All' }))
    const initial = (await view.findByRole('option')).textContent
    fireEvent.click(view.getByRole('button', { name: 'all' }))
    await waitFor(() => expect(view.project).toHaveBeenLastCalledWith('root', 'App', null))
    expect(view.getByRole('option').textContent).toBe(initial)
    expect(view.getByRole('button', { name: 'Re-run session' }).hasAttribute('disabled')).toBe(true)
    fireEvent.keyDown(view.getByRole('combobox'), { key: 'Enter' })
    expect(view.openHistory).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: '1d' }))
    const label = `Range ${Date.parse('2026-09-12T14:30:00Z')}`
    await view.findByText(label)
    await act(async () => { finish(); await pending })
    expect(view.getByRole('option').textContent).toContain(label)
    expect(view.getByRole('button', { name: '1d' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('can return to AppJamat while All is scanning without accepting its late results', async () => {
    let finish: () => void = () => undefined
    const pending = new Promise<void>((resolve) => { finish = resolve })
    const view = mount({ project: async () => {
      await pending
      return { ok: true, value: { ok: true, value: [session('external', 4_000, 'External task')] } }
    } })
    await view.findAllByRole('option')
    fireEvent.change(view.getByRole('combobox'), { target: { value: 'New task' } })
    fireEvent.click(view.getByRole('button', { name: 'Fork' }))
    fireEvent.click(view.getByRole('button', { name: 'All' }))
    await waitFor(() => expect(view.project).toHaveBeenCalledOnce())
    expect(view.getByRole('option').textContent).toContain('New task')
    fireEvent.click(view.getByRole('button', { name: 'AppJamat' }))
    await waitFor(() => expect(view.appJamat).toHaveBeenCalledTimes(2))
    await act(async () => { finish(); await pending })
    expect(view.getByRole('option').textContent).toContain('New task')
    expect(view.getByRole('button', { name: 'Fork' }).getAttribute('aria-pressed')).toBe('true')
    expect(document.activeElement).toBe(view.getByRole('combobox'))
  })
})
