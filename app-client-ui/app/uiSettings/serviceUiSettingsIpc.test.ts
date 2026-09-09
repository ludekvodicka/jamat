import type { IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import type { ConfigOpResult } from '../../../lib-orchestrator/configStore/configStore.types'
import type { AppClientUiIpcInvokeMap } from '../../shared/appClientUiIpc'
import type { UiSettingsValue } from '../../shared/uiSettings'
import { ServiceUiSettingsIpc } from './serviceUiSettingsIpc'

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

describe('app-client-ui/app/uiSettings/serviceUiSettingsIpc', () => {
  const storedConst: UiSettingsValue = {
    fontScalePercent: 115,
    fileViewerFontScalePercent: 130,
    terminalFontScalePercent: 90,
    terminalTheme: 'soft',
  }
  let saveAnswer: ConfigOpResult
  let written: UiSettingsValue[]
  let changed: number
  let service: ServiceUiSettingsIpc

  /** What the store answers is decided per test; whether it writes is the library's own tests. */
  function storeUnderTest(): ConfigStore {
    return {
      readSection: () => storedConst,
      saveSection: (_spec: unknown, value: UiSettingsValue) => {
        written.push(value)
        return saveAnswer
      },
    } as unknown as ConfigStore
  }

  beforeEach(() => {
    ipcMainMock.handlers.clear()
    saveAnswer = { ok: true }
    written = []
    changed = 0
    service = new ServiceUiSettingsIpc(storeUnderTest(), () => { changed += 1 })
    service.initialize()
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
    expect([...ipcMainMock.handlers.keys()].sort())
      .toEqual(Object.keys(ServiceUiSettingsIpc.channelsConst).sort())
  })

  it('fails the boot when one of its channels has no handler', () => {
    const internals = new ServiceUiSettingsIpc(storeUnderTest(), () => {}) as unknown as {
      assertComplete(channels: typeof ServiceUiSettingsIpc.channelsConst): void
    }
    expect(() => internals.assertComplete(ServiceUiSettingsIpc.channelsConst))
      .toThrow(/IPC channel is not registered/)
  })

  it('answers the read with what the section holds', async () => {
    expect(await invoke('ui:settings-get')).toEqual({ ok: true, value: storedConst })
  })

  it('tells the windows once, and only after the write went through', async () => {
    expect(await invoke('ui:settings-save', storedConst)).toEqual({
      ok: true,
      value: { ok: true },
    })
    expect(written).toEqual([storedConst])
    expect(changed).toBe(1)
  })

  /*
   * The event says the stored value moved. Sending one for a write that did not happen would have
   * every window read the file and apply what it already had, which looks like the save worked.
   */
  it('says nothing when the config is latched', async () => {
    saveAnswer = { ok: false, code: 'config-latched', detail: 'unreadable config' }

    expect(await invoke('ui:settings-save', storedConst)).toEqual({
      ok: true,
      value: { ok: false, code: 'config-latched', detail: 'unreadable config' },
    })
    expect(changed).toBe(0)
  })

  it('says nothing when the section refuses the value', async () => {
    saveAnswer = { ok: false, code: 'invalid-section', detail: 'off the step' }

    expect(await invoke('ui:settings-save', { fontScalePercent: 112 })).toEqual({
      ok: true,
      value: { ok: false, code: 'invalid-section', detail: 'off the step' },
    })
    expect(changed).toBe(0)
  })
})
