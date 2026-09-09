import type { IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import type { ConfigOpResult } from '../../../lib-orchestrator/configStore/configStore.types'
import type { AppClientUiIpcInvokeMap } from '../../shared/appClientUiIpc'
import type { VersioningSettingsValue } from '../../shared/versioningSettings'
import { ServiceVersioningSettingsIpc } from './serviceVersioningSettingsIpc'

const ipcMainMock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) =>
      ipcMainMock.handlers.set(channel, handler),
  },
}))

describe('app-client-ui/app/versioning/serviceVersioningSettingsIpc', () => {
  const storedConst: VersioningSettingsValue = { mode: 'checkpoints' }
  let answer: ConfigOpResult
  let written: VersioningSettingsValue[]

  beforeEach(() => {
    ipcMainMock.handlers.clear()
    answer = { ok: true }
    written = []
    new ServiceVersioningSettingsIpc({
      readSection: () => storedConst,
      saveSection: (_spec: unknown, value: VersioningSettingsValue) => {
        written.push(value)
        return answer
      },
    } as unknown as ConfigStore).initialize()
  })

  async function invoke(
    channel: keyof AppClientUiIpcInvokeMap,
    ...args: unknown[]
  ): Promise<unknown> {
    const handler = ipcMainMock.handlers.get(channel)
    if (!handler) throw new Error(`No handler for ${channel}`)
    return handler({} as IpcMainInvokeEvent, ...args)
  }

  it('reads and writes only its config section', async () => {
    expect(await invoke('versioning:settings-get')).toEqual({ ok: true, value: storedConst })
    expect(await invoke('versioning:settings-save', { mode: 'git' })).toEqual({
      ok: true,
      value: { ok: true },
    })
    expect(written).toEqual([{ mode: 'git' }])
  })

  it('returns a strict section refusal as domain data', async () => {
    answer = { ok: false, code: 'invalid-section', detail: 'mode' }
    expect(await invoke('versioning:settings-save', { mode: 'jj' })).toEqual({
      ok: true,
      value: { ok: false, code: 'invalid-section', detail: 'mode' },
    })
  })
})
