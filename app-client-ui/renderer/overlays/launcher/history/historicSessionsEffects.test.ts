import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IpcResult } from '../../../../shared/appClientUiIpc'
import { ControlBridgeFixture } from '../../../ipc/fixtures/controlBridgeFixture'
import { HistoricSessionsEffects } from './historicSessionsEffects'

describe('app-client-ui/renderer/overlays/launcher/history/historicSessionsEffects', () => {
  afterEach(() => vi.restoreAllMocks())

  /** The four reads a history load makes, each answered the way the window would receive it. */
  function install(reads: {
    categories?: () => Promise<IpcResult<unknown>>
    list?: (categoryId: string) => Promise<IpcResult<{ ok: true; value: unknown }>>
    project?: (categoryId: string, projectName: string, lastUsedSince: number | null | undefined) =>
      Promise<IpcResult<{ ok: true; value: unknown }>>
    appJamat?: (lastUsedSince: number | null | undefined) => Promise<IpcResult<unknown>>
  }): void {
    const unused = (): never => { throw new Error('This read is not expected') }
    Object.defineProperty(window, 'appClient', { configurable: true, value: { control: {
      call: async (operation: string, body: Record<string, unknown>) => {
        if (operation === 'projects.categories') return ControlBridgeFixture.valueOf(operation, await (reads.categories ?? unused)())
        else if (operation === 'projects.listing')
          return ControlBridgeFixture.answerOf(operation, await (reads.list ?? unused)(body.categoryId as string))
        else if (operation === 'historicSessions.project')
          return ControlBridgeFixture.answerOf(operation, await (reads.project ?? unused)(
            body.categoryId as string, body.projectName as string, body.lastUsedSince as number | null | undefined))
        else if (operation === 'historicSessions.appJamat')
          return ControlBridgeFixture.valueOf(operation, await (reads.appJamat ?? unused)(body.lastUsedSince as number | null | undefined))
        else
          return { ok: false, error: `No stub for ${operation}` }
      },
    } } })
  }

  it('reads every root, deduplicates overlapping projects and reports unavailable roots', async () => {
    const project = vi.fn(async (_categoryId: string, _projectName: string, _since: number | null | undefined) =>
      ({ ok: true as const, value: { ok: true as const, value: [] } }))
    install({
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
      project,
    })
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
      return { ok: true as const, value: { ok: true as const, value: [] } }
    })
    install({
      categories: async () => ({ ok: true, value: [{ id: 'root', label: 'Root', path: 'Q:/Apps', available: true }] }),
      list: async () => ({ ok: true, value: { ok: true, value: { available: true, truncated: false,
        projects: Array.from({ length: 7 }, (_, i) => ({ name: `${i}`, path: `Q:/Apps/${i}`, lastActivity: null })),
      } } }),
      project,
    })
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
    const appJamat = vi.fn(async (_since: number | null | undefined) => ({ ok: true as const, value: [] }))
    const project = vi.fn()
    const categories = vi.fn()
    const list = vi.fn()
    install({ categories, list, project, appJamat })
    expect(await HistoricSessionsEffects.load('AppJamat', 1_000, () => true, vi.fn(), vi.fn())).toEqual([])
    expect(appJamat).toHaveBeenCalledExactlyOnceWith(1_000)
    expect(project).not.toHaveBeenCalled()
    expect(categories).not.toHaveBeenCalled()
    expect(list).not.toHaveBeenCalled()
  })
})
