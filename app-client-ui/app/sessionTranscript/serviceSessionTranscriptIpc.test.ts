import type { IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  SessionTranscriptReading,
} from '../../../lib-orchestrator/sessionTranscriptReader/sessionTranscriptReaderApi.types'
import type { AppClientUiIpcInvokeMap } from '../../shared/appClientUiIpc'
import { ServiceSessionTranscriptIpc } from './serviceSessionTranscriptIpc'
import type { SessionTranscriptAccess } from './sessionTranscriptAccess'

const ipcMainMock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) =>
      ipcMainMock.handlers.set(channel, handler),
  },
}))

describe('app-client-ui/app/sessionTranscript/serviceSessionTranscriptIpc', () => {
  const readingConst: SessionTranscriptReading = {
    kind: 'messages',
    messages: [
      { role: 'user', text: 'finish this off', at: 1754400000000, textTruncated: false },
      { role: 'assistant', text: 'done', at: 1754400001000, textTruncated: false },
    ],
    bounds: { maxMessages: 10, maxCharactersPerMessage: 2_000, scannedBytes: 400 },
    earlierContentOmitted: false,
  }
  let reads: string[]
  let service: ServiceSessionTranscriptIpc

  function accessUnderTest(): SessionTranscriptAccess {
    return {
      read: (sessionId: string) => {
        reads.push(sessionId)
        return Promise.resolve(readingConst)
      },
    } as SessionTranscriptAccess
  }

  beforeEach(() => {
    ipcMainMock.handlers.clear()
    reads = []
    service = new ServiceSessionTranscriptIpc(accessUnderTest())
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
      .toEqual(Object.keys(ServiceSessionTranscriptIpc.channelsConst).sort())
  })

  it('fails the boot when one of its channels has no handler', () => {
    const internals =
      new ServiceSessionTranscriptIpc(accessUnderTest()) as unknown as {
        assertComplete(channels: typeof ServiceSessionTranscriptIpc.channelsConst): void
      }
    expect(() => internals.assertComplete(ServiceSessionTranscriptIpc.channelsConst))
      .toThrow(/IPC channel is not registered/)
  })

  it('hands the exact session id to the shared access and returns its reading unchanged', async () => {
    expect(await invoke('sessionTranscript:get', 'agent-1'))
      .toEqual({ ok: true, value: readingConst })

    expect(reads).toEqual(['agent-1'])
  })
})
