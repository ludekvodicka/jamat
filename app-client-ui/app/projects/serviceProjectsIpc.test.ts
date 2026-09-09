import type { IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProjectManager } from '../../../lib-orchestrator/projectManager/projectManager'
import type { AppClientUiIpcInvokeMap } from '../../shared/appClientUiIpc'
import { ServiceProjectsIpc } from './serviceProjectsIpc'

const ipcMainMock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      ipcMainMock.handlers.set(channel, handler)
    },
  },
}))

describe('app-client-ui/app/projects/serviceProjectsIpc', () => {
  const calls: { method: string; args: unknown[] }[] = []
  let service: ServiceProjectsIpc

  /** Records what each channel forwarded; what the answers mean is the library's own tests. */
  function recordingManager(): ProjectManager {
    const record = (method: string) => (...args: unknown[]) => {
      calls.push({ method, args })
      return Promise.resolve({ ok: true, value: method })
    }
    return {
      getConfig: record('getConfig'),
      saveConfig: record('saveConfig'),
      listCategories: record('listCategories'),
      listProjects: record('listProjects'),
      listProjectSessions: record('listProjectSessions'),
      createProject: record('createProject'),
      renameProject: record('renameProject'),
      moveProjectPrefix: record('moveProjectPrefix'),
      archiveProject: record('archiveProject'),
      previewDelete: record('previewDelete'),
      executeDelete: record('executeDelete'),
    } as unknown as ProjectManager
  }

  beforeEach(() => {
    ipcMainMock.handlers.clear()
    calls.length = 0
    service = new ServiceProjectsIpc(recordingManager())
  })

  async function invoke(
    channel: keyof AppClientUiIpcInvokeMap,
    ...args: unknown[]
  ): Promise<unknown> {
    const handler = ipcMainMock.handlers.get(channel)
    if (!handler) throw new Error(`No handler for ${channel}`)
    return handler({} as IpcMainInvokeEvent, ...args)
  }

  it('registers a handler for every channel it declares', () => {
    service.initialize()
    expect([...ipcMainMock.handlers.keys()].sort())
      .toEqual(Object.keys(ServiceProjectsIpc.channelsConst).sort())
  })

  it('fails the boot when one of its channels has no handler', () => {
    const internals = service as unknown as {
      assertComplete(channels: typeof ServiceProjectsIpc.channelsConst): void
    }
    expect(() => internals.assertComplete(ServiceProjectsIpc.channelsConst))
      .toThrow(/IPC channel is not registered/)
  })

  it('forwards each channel to the manager with the arguments it was given', async () => {
    service.initialize()

    await invoke('projects:config-save', { schemaVersion: 1, categories: [] })
    await invoke('projects:categories')
    await invoke('projects:list', 'nodejs', 'recent')
    await invoke('projects:sessions', 'nodejs', 'AppJamatV3')
    await invoke('projects:rename', 'nodejs', 'Old', 'New')
    await invoke('projects:move-prefix', 'nodejs', 'Thing', null)
    await invoke('projects:archive', 'nodejs', 'Thing')
    await invoke('projects:delete-preview', 'nodejs', 'Thing')
    await invoke('projects:delete', 'token-1')

    expect(calls).toEqual([
      { method: 'saveConfig', args: [{ schemaVersion: 1, categories: [] }] },
      { method: 'listCategories', args: [] },
      { method: 'listProjects', args: ['nodejs', { sort: 'recent' }] },
      { method: 'listProjectSessions', args: ['nodejs', 'AppJamatV3'] },
      { method: 'renameProject', args: ['nodejs', 'Old', 'New'] },
      { method: 'moveProjectPrefix', args: ['nodejs', 'Thing', null] },
      { method: 'archiveProject', args: ['nodejs', 'Thing'] },
      { method: 'previewDelete', args: ['nodejs', 'Thing'] },
      { method: 'executeDelete', args: ['token-1'] },
    ])
  })

  // The wire carries null because a renderer cannot send `undefined`; the library's option is absent.
  it('turns a null virtual folder prefix into no prefix at all', async () => {
    service.initialize()

    await invoke('projects:create', 'nodejs', 'Thing', null)
    await invoke('projects:create', 'nodejs', 'Thing', 'temporary')

    expect(calls).toEqual([
      { method: 'createProject', args: ['nodejs', 'Thing', undefined] },
      { method: 'createProject', args: ['nodejs', 'Thing', { virtualFolderPrefix: 'temporary' }] },
    ])
  })

  /**
   * The reading channel is a straight delegation like every other: the catalog answers with a domain
   * result, because it refuses while its value on disk cannot be read. The outermost wrapper is the
   * transport's, added by registerAppClientUiHandler for every channel.
   */
  it('answers the read with the domain result inside the transport result', async () => {
    service.initialize()
    expect(await invoke('projects:config-get')).toEqual({
      ok: true,
      value: { ok: true, value: 'getConfig' },
    })
  })
})
