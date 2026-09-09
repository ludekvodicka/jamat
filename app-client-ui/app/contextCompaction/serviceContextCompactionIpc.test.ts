import type { IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppClientUiIpcInvokeMap } from '../../shared/appClientUiIpc'
import { ServiceContextCompactionIpc } from './serviceContextCompactionIpc'

const ipcMainMock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) =>
      ipcMainMock.handlers.set(channel, handler),
  },
}))

describe('app-client-ui/app/contextCompaction/serviceContextCompactionIpc', () => {
  let now: number

  beforeEach(() => {
    ipcMainMock.handlers.clear()
    now = 1_000_000
    new ServiceContextCompactionIpc(() => now).initialize()
  })

  async function invoke(
    channel: keyof AppClientUiIpcInvokeMap,
    ...args: unknown[]
  ): Promise<unknown> {
    const handler = ipcMainMock.handlers.get(channel)
    if (!handler) throw new Error(`No handler for ${channel}`)
    return handler({} as IpcMainInvokeEvent, ...args)
  }

  it('claims one automatic compact per session for ten minutes', async () => {
    expect(await invoke('contextCompaction:claim-auto', 's-a'))
      .toEqual({ ok: true, value: true })
    expect(await invoke('contextCompaction:claim-auto', 's-a'))
      .toEqual({ ok: true, value: false })
    expect(await invoke('contextCompaction:claim-auto', 's-b'))
      .toEqual({ ok: true, value: true })

    now += 10 * 60_000

    expect(await invoke('contextCompaction:claim-auto', 's-a'))
      .toEqual({ ok: true, value: true })
  })

  it('lets a manual compact move the automatic cooldown without blocking the manual action', async () => {
    now += 9 * 60_000
    expect(await invoke('contextCompaction:note-manual', 's-a'))
      .toEqual({ ok: true, value: undefined })

    now += 9 * 60_000
    expect(await invoke('contextCompaction:claim-auto', 's-a'))
      .toEqual({ ok: true, value: false })

    now += 60_000
    expect(await invoke('contextCompaction:claim-auto', 's-a'))
      .toEqual({ ok: true, value: true })
  })

  it('reports the actual shared deadline without claiming or extending it', async () => {
    expect(await invoke('contextCompaction:cooldown', 's-a')).toEqual({ ok: true, value: null })
    await invoke('contextCompaction:claim-auto', 's-a')
    const requestedAt = now
    now += 60_000
    expect(await invoke('contextCompaction:cooldown', 's-a')).toEqual({
      ok: true,
      value: { requestedAt, expiresAt: requestedAt + 10 * 60_000 },
    })
    expect(await invoke('contextCompaction:cooldown', 's-b')).toEqual({ ok: true, value: null })
    now = requestedAt + 10 * 60_000
    expect(await invoke('contextCompaction:cooldown', 's-a')).toEqual({ ok: true, value: null })
    expect(await invoke('contextCompaction:claim-auto', 's-a')).toEqual({ ok: true, value: true })
  })
})
