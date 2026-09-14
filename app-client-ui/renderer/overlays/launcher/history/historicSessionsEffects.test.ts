import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppClientUiBridge } from '../../../../shared/appClientUiIpc'
import { HistoricSessionsEffects } from './historicSessionsEffects'

describe('app-client-ui/renderer/overlays/launcher/history/historicSessionsEffects', () => {
  afterEach(() => vi.restoreAllMocks())

  it('reads every root, deduplicates overlapping projects and reports unavailable roots', async () => {
    const project = vi.fn(async () => ({ ok: true, value: { ok: true, value: [] } }))
    Object.defineProperty(window, 'appClient', { configurable: true, value: {
      projects: {
        categories: async () => ({ ok: true, value: [
          { id: 'one', label: 'One', path: 'Q:/One', available: true },
          { id: 'two', label: 'Two', path: 'Q:/Two', available: true },
          { id: 'offline', label: 'Offline', path: 'Q:/Offline', available: false },
        ] }),
        list: async (root: string) => ({ ok: true, value: { ok: true, value: {
          available: true, truncated: false, projects: [
            { name: 'Shared', path: 'Q:/Shared', lastActivity: null },
            { name: root, path: `Q:/${root}/App`, lastActivity: null },
          ],
        } } }),
      }, historicSessions: { project },
    } as unknown as AppClientUiBridge })
    const report = vi.fn()
    const progress = vi.fn()
    expect(await HistoricSessionsEffects.load('All', 1_000, () => true, report, progress)).toEqual([])
    expect(project.mock.calls).toEqual([['one', 'Shared', 1_000], ['one', 'one', 1_000], ['two', 'two', 1_000]])
    expect(progress).toHaveBeenLastCalledWith(3, 3)
    expect(report).toHaveBeenCalledWith('Offline: root is unavailable (Q:/Offline).')
  })

  it('limits concurrent project reads and discards replies after closing without starting another', async () => {
    let finish: () => void = () => undefined
    const pending = new Promise<void>((resolve) => { finish = resolve })
    const project = vi.fn(async () => {
      await pending
      return { ok: true, value: { ok: true, value: [] } }
    })
    Object.defineProperty(window, 'appClient', { configurable: true, value: {
      projects: {
        categories: async () => ({ ok: true, value: [{ id: 'root', label: 'Root', path: 'Q:/Apps', available: true }] }),
        list: async () => ({ ok: true, value: { ok: true, value: { available: true, truncated: false,
          projects: Array.from({ length: 7 }, (_, i) => ({ name: `${i}`, path: `Q:/Apps/${i}`, lastActivity: null })),
        } } }),
      }, historicSessions: { project },
    } as unknown as AppClientUiBridge })
    let active = true
    const progress = vi.fn()
    const load = HistoricSessionsEffects.load('All', null, () => active, vi.fn(), progress)
    await vi.waitFor(() => expect(project).toHaveBeenCalledTimes(3))
    active = false
    finish()
    expect(await load).toEqual([])
    expect(project).toHaveBeenCalledTimes(3)
    expect(progress).toHaveBeenCalledExactlyOnceWith(0, 7)
  })

  it('uses one AppJamat request without discovering roots or reading external history', async () => {
    const appJamat = vi.fn(async () => ({ ok: true, value: [] }))
    const project = vi.fn()
    const categories = vi.fn()
    const list = vi.fn()
    Object.defineProperty(window, 'appClient', { configurable: true, value: {
      projects: { categories, list }, historicSessions: { project, appJamat },
    } as unknown as AppClientUiBridge })
    expect(await HistoricSessionsEffects.load('AppJamat', 1_000, () => true, vi.fn(), vi.fn())).toEqual([])
    expect(appJamat).toHaveBeenCalledExactlyOnceWith(1_000)
    expect(project).not.toHaveBeenCalled()
    expect(categories).not.toHaveBeenCalled()
    expect(list).not.toHaveBeenCalled()
  })
})
