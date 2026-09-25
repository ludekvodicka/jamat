import type { IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RemoteControlStepResult, RemoteControlTerminalDeliverDto } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { RemoteControlTerminal } from '../../../lib-orchestrator/remoteControl/remoteControlTerminal'
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
  let deliverAnswer: RemoteControlStepResult<RemoteControlTerminalDeliverDto>
  let deliverCalls: Parameters<RemoteControlTerminal['deliver']>[]
  let transcriptReads: string[]

  beforeEach(() => {
    ipcMainMock.handlers.clear()
    now = 1_000_000
    deliverCalls = []
    transcriptReads = []
    deliverAnswer = {
      ok: true,
      value: {
        sessionId: 's-a',
        accepted: true,
        characterCount: 8,
        delivered: true,
        input: 'typed',
        composeProof: 'text',
        proof: 'working',
        submitKey: 'enter',
        readyAfterMs: 0,
        submittedAfterMs: 400,
      },
    }
    new ServiceContextCompactionIpc(
      {
        deliver: async (...args) => {
          deliverCalls.push(args)
          await args[3].transcript()
          return deliverAnswer
        },
      },
      {
        read: (sessionId) => {
          transcriptReads.push(sessionId)
          return Promise.resolve({ kind: 'none', code: 'transcript-not-found', reason: 'test' })
        },
      },
      () => now,
    ).initialize()
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

  it('types /compact through the verified delivery and returns its proof', async () => {
    expect(await invoke('contextCompaction:deliver', 's-a'))
      .toEqual({ ok: true, value: { kind: 'delivered', proof: 'working' } })

    expect(deliverCalls.map(([sessionId, text, options]) => ({ sessionId, text, options }))).toEqual([{
      sessionId: 's-a',
      text: '/compact',
      options: { input: 'typed', readyTimeoutMs: 45_000, submitTimeoutMs: 10_000 },
    }])
    expect(transcriptReads).toEqual(['s-a'])
  })

  it('passes a refusal on with its stage and reason', async () => {
    deliverAnswer = {
      ok: false,
      error: {
        code: 'conflict',
        detail: 'The agent is showing a dialog',
        data: { stage: 'ready', reason: 'dialog', typed: false, entered: 0, hint: 'blocked', composer: null },
      },
    }

    expect(await invoke('contextCompaction:deliver', 's-a')).toEqual({
      ok: true,
      value: { kind: 'refused', stage: 'ready', reason: 'dialog', detail: 'The agent is showing a dialog' },
    })
  })
})
