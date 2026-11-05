import { describe, expect, it, vi } from 'vitest'
import { RemoteControlOperationStore } from './remoteControlOperationStore'
import { RemoteControlSocketOperations, type RemoteControlSocketCaller, type RemoteControlSocketTerminalPort } from './remoteControlSocketOperations'
import type { RemoteControlSocketResponse } from './remoteControlApi.types'

describe('shared socket replay ownership', () => {
  it.each([{ callerId: 'caller', connectionId: 'second' }, { callerId: 'other-caller', connectionId: 'first' }])(
    'shares the aggregate bound while distinguishing $callerId/$connectionId', async identity => {
      let finish!: () => void
      const pending = new Promise<void>(resolve => { finish = resolve })
      const store = new RemoteControlOperationStore(1), audit = { socket: vi.fn(), peerControl: vi.fn() }
      const input = vi.fn(async () => { await pending; return { ok: true as const, value: { attachId: 'a', accepted: true as const, characterCount: 1 } } })
      const terminal = { inputLive: input } as unknown as RemoteControlSocketTerminalPort
      const first = new RemoteControlSocketOperations(terminal, audit, 'peer-socket', store)
      const second = new RemoteControlSocketOperations(terminal, audit, 'peer-socket', store)
      const caller = (callerId: string, connectionId: string) => {
        const sent: RemoteControlSocketResponse[] = []
        const value: RemoteControlSocketCaller = { ownerId: connectionId, caller: { callerId, callerKind: 'remote-peer' }, connectionId,
          closed: () => false, granted: () => true, send: response => { sent.push(response) },
          subscribe: () => ({ throughRevision: 0, truncated: false, events: [] }), attached() {}, detached() {}, frame() {} }
        return { value, sent }
      }
      const one = caller('caller', 'first'), two = caller(identity.callerId, identity.connectionId)
      const request = { protocol: 'appjamat-v3-control.v1', requestId: 'request', operation: 'terminal.input', operationId: 'same', attachId: 'a', data: 'x' } as const
      const held = first.handle(one.value, request)
      await Promise.resolve()
      await second.handle(two.value, request)
      expect(input).toHaveBeenCalledTimes(1)
      expect(two.sent).toMatchObject([{ ok: false, error: { code: 'unavailable' } }])
      finish(); await held
      await second.handle(two.value, request)
      expect(input).toHaveBeenCalledTimes(2)
      expect(one.sent).toMatchObject([{ ok: true }])
      expect(two.sent[1]).toMatchObject({ ok: true })
    })
})
