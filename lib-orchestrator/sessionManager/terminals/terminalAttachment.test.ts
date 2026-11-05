import { describe, expect, it } from 'vitest'

import type { HostDescriptor, HostWsClientMsg, HostWsServerMsg } from '../../../app-host/app/wire/hostWire.js'
import type { TerminalAttachSocketDeps } from '../../hostClient/terminalAttachSocket'
import { TerminalAttachment } from './terminalAttachment'

describe('TerminalAttachment', () => {
  it('retains atomic snapshots with an older Host even when its owner can consume streams', () => {
    let callbacks!: TerminalAttachSocketDeps
    const sent: HostWsClientMsg[] = [], frames: HostWsServerMsg[] = []
    const attachment = new TerminalAttachment({ sessionId: 'session',
      descriptorOf: () => ({ hostInstanceId: 'host', port: 1, token: 'test', capabilities: ['terminal.snapshot.v1'] }) as HostDescriptor,
      leaseIdOf: () => 'lease', refOf: () => ({ ok: true, ref: { hostInstanceId: 'host', runtimeSessionId: 'runtime', generation: 1 }, alive: true }),
      onFrame: frame => { if (frame.type !== 'terminal.status') frames.push(frame) }, onError: error => { throw new Error(error) }, onEnded() {},
      snapshotFlow: { reserve: async () => { throw new Error('old Host must not request streamed credit') } },
      socketFactory: value => { callbacks = value; return { connect() {}, send: frame => sent.push(frame), close() {} } },
    })
    attachment.start()
    expect(sent[0]).not.toHaveProperty('snapshotStreamId')
    const frame: HostWsServerMsg = { type: 'terminal.snapshot', projection: { runtimeSessionId: 'runtime', generation: 1,
      outputEpoch: 1, outputSeq: 10, cols: 80, rows: 24, alive: true, lastOutputAt: null, screen: 'legacy' } }
    callbacks.onFrame(frame)
    expect(frames).toEqual([frame])
    attachment.dispose()
  })
  it('negotiates streaming only with a capable Host and cancels an old reservation when its descriptor disappears', async () => {
    let descriptor: HostDescriptor | null = { hostInstanceId: 'host', port: 1, token: 'test', capabilities: ['terminal.snapshot-stream.v1'] } as HostDescriptor
    let lease = 'lease-a', closed = 0
    let signal: AbortSignal | null = null
    let callbacks!: TerminalAttachSocketDeps
    const sent: HostWsClientMsg[] = []
    const attachment = new TerminalAttachment({ sessionId: 'session', descriptorOf: () => descriptor, leaseIdOf: () => lease,
      refOf: () => ({ ok: true, ref: { hostInstanceId: 'host', runtimeSessionId: 'runtime', generation: 1 }, alive: true }),
      onFrame() {}, onError: error => { throw new Error(error) }, onEnded() {},
      snapshotFlow: { reserve: (_bytes, value) => { signal = value; return new Promise((_resolve, reject) => value.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })) } },
      socketFactory: value => { callbacks = value; return { connect() {}, send: frame => sent.push(frame), close: () => { closed++ } } },
    })
    attachment.start()
    expect(sent[0]).toMatchObject({ type: 'terminal.attach', snapshotStreamId: expect.any(String) })
    callbacks.onFrame({ type: 'terminal.attached', writer: false, session: { runtimeSessionId: 'runtime', generation: 1,
      alive: true, cols: 80, rows: 24, outputSeq: 0, outputEpoch: 1, startedAt: 0, lastOutputAt: null } })
    descriptor = null
    lease = 'lease-b'
    attachment.leaseChanged()
    expect((signal as AbortSignal | null)?.aborted).toBe(true)
    expect(closed).toBe(1)
    attachment.dispose()
    await Promise.resolve()
  })
  it('requires a writer acknowledgement on the reopened connection before input or geometry', () => {
    const sockets: { callbacks: TerminalAttachSocketDeps; sent: HostWsClientMsg[] }[] = []
    const ref = { hostInstanceId: 'host', runtimeSessionId: 'runtime', generation: 1 }
    const attached: HostWsServerMsg = { type: 'terminal.attached', writer: true, session: {
      runtimeSessionId: 'runtime', generation: 1, alive: true, cols: 80, rows: 24,
      outputSeq: 0, outputEpoch: 1, startedAt: 0, lastOutputAt: null,
    } }
    const attachment = new TerminalAttachment({
      sessionId: 'session', descriptorOf: () => ({ hostInstanceId: 'host', port: 1, token: 'test' }) as HostDescriptor,
      leaseIdOf: () => 'lease', refOf: () => ({ ok: true, ref, alive: true }),
      onFrame: () => {}, onError: message => { throw new Error(message) }, onEnded: () => {},
      socketFactory: callbacks => {
        const sent: HostWsClientMsg[] = []
        sockets.push({ callbacks, sent })
        return { connect: () => {}, send: frame => { sent.push(frame) }, close: () => {} }
      },
    })
    attachment.start()
    sockets[0]!.callbacks.onFrame(attached)
    expect(attachment.input('before')).toBe(true)
    sockets[0]!.callbacks.onFrame({ type: 'terminal.stream-truncated', runtimeSessionId: 'runtime', generation: 1, outputEpoch: 1, outputSeq: 0 })
    expect(sockets).toHaveLength(2)
    expect(attachment.acceptsInput()).toBe(false)
    expect(attachment.input('unacknowledged')).toBe(false)
    attachment.setGeometry({ cols: 100, rows: 30 })
    expect(sockets[1]!.sent.map(frame => frame.type)).toEqual(['terminal.attach'])
    sockets[1]!.callbacks.onFrame(attached)
    expect(attachment.input('after')).toBe(true)
    expect(sockets[1]!.sent.map(frame => frame.type)).toEqual(['terminal.attach', 'terminal.resize', 'terminal.input'])
    attachment.dispose()
  })
})
