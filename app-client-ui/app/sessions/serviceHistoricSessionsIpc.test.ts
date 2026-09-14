import { afterEach, describe, expect, it, vi } from 'vitest'
import { HistoricSessions } from './history/historicSessions'
import { ServiceHistoricSessionsIpc } from './serviceHistoricSessionsIpc'

const handlers = vi.hoisted(() => new Map<string, (event: unknown, ...args: unknown[]) => unknown>())
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, handler) } }))

describe('app-client-ui/app/sessions/serviceHistoricSessionsIpc', () => {
  afterEach(() => { handlers.clear(); vi.restoreAllMocks() })

  it('forwards the optional last-use cutoff, including an unlimited request', async () => {
    const history = new HistoricSessions({ listProjects: vi.fn(), listProjectSessions: vi.fn() }, { historyReferences: vi.fn(), localHistory: vi.fn() }, { read: vi.fn() })
    const project = vi.spyOn(history, 'project').mockResolvedValue({ ok: true, value: [] })
    const appJamat = vi.spyOn(history, 'appJamat').mockResolvedValue([])
    new ServiceHistoricSessionsIpc(history).initialize()
    const invoke = handlers.get('historic-sessions:project')
    if (!invoke) throw new Error('Historic sessions channel was not registered')
    const invokeAppJamat = handlers.get('historic-sessions:appjamat')
    if (!invokeAppJamat) throw new Error('AppJamat history channel was not registered')
    for (const since of [1_000, null, undefined]) {
      await invoke({}, 'root', 'App', since)
      expect(project).toHaveBeenLastCalledWith('root', 'App', since)
      await invokeAppJamat({}, since)
      expect(appJamat).toHaveBeenLastCalledWith(since)
    }
  })
})
