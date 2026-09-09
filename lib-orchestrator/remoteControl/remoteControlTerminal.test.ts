import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  TerminalAttachResult,
  TerminalAttachSpec,
  TerminalFrame,
} from '../sessionManager/sessionManagerApi.types'
import type {
  TerminalAttachOwner,
  TerminalInputResult,
  TerminalResizeResult,
} from '../sessionManager/terminals/terminalGateway'
import {
  RemoteControlTerminal,
  type RemoteControlTerminalSessionPort,
} from './remoteControlTerminal'

interface FakeAttachment {
  spec: TerminalAttachSpec
  owner: TerminalAttachOwner
}

class FakeTerminalSessions implements RemoteControlTerminalSessionPort {
  readonly attachments = new Map<string, FakeAttachment>()
  readonly detached: string[] = []
  readonly detachedAll: string[][] = []
  readonly inputs: { attachId: string; data: string }[] = []
  readonly resizes: { attachId: string; cols: number; rows: number }[] = []
  readonly active: { attachId: string; active: boolean }[] = []
  attachAnswer: TerminalAttachResult = { ok: true }
  inputAnswer: TerminalInputResult = { kind: 'sent' }
  resizeAnswer: TerminalResizeResult = { kind: 'applied' }

  terminalAttach(
    attachId: string,
    spec: TerminalAttachSpec,
    owner: TerminalAttachOwner,
  ): TerminalAttachResult {
    if (this.attachAnswer.ok)
      this.attachments.set(attachId, { spec, owner })
    return this.attachAnswer
  }

  terminalInput(attachId: string, data: string): TerminalInputResult {
    this.inputs.push({ attachId, data })
    return this.inputAnswer
  }

  terminalResize(attachId: string, cols: number, rows: number): TerminalResizeResult {
    this.resizes.push({ attachId, cols, rows })
    return this.resizeAnswer
  }

  terminalSetGeometryActive(attachId: string, active: boolean): TerminalResizeResult {
    this.active.push({ attachId, active })
    return this.resizeAnswer
  }

  terminalDetach(attachId: string): void {
    this.detached.push(attachId)
    this.attachments.delete(attachId)
  }

  terminalDetachAll(attachIds: readonly string[]): void {
    this.detachedAll.push([...attachIds])
    for (const attachId of attachIds) this.attachments.delete(attachId)
  }

  emit(attachId: string, frame: TerminalFrame): void {
    const attachment = this.attachments.get(attachId)
    if (!attachment) throw new Error(`No fake attach ${attachId}`)
    attachment.owner.onFrame(frame)
  }

  onlyAttachId(): string {
    const ids = [...this.attachments.keys()]
    if (ids.length !== 1 || !ids[0])
      throw new Error(`Expected one fake attach, got ${ids.length}`)
    return ids[0]
  }
}

class RemoteTerminalHarness {
  readonly sessions = new FakeTerminalSessions()
  readonly errors: string[] = []
  readonly terminal: RemoteControlTerminal
  private nextId = 0

  constructor(timeoutMilliseconds = 100, screenCharacterLimit = 5) {
    this.terminal = new RemoteControlTerminal(this.sessions, {
      internalAttachId: () => `internal-${++this.nextId}`,
      onError: (message) => this.errors.push(message),
      timeoutMilliseconds,
      screenCharacterLimit,
    })
  }
}

class TerminalFrames {
  static attached(writer: boolean): TerminalFrame {
    return {
      type: 'terminal.attached',
      writer,
      session: {
        runtimeSessionId: 'runtime-1',
        generation: 1,
        alive: true,
        cols: 80,
        rows: 24,
        outputSeq: 2,
        outputEpoch: 1,
        lastOutputAt: 10,
        startedAt: 1,
      },
    }
  }

  static snapshot(screen = '123456789'): TerminalFrame {
    return {
      type: 'terminal.snapshot',
      projection: {
        runtimeSessionId: 'runtime-1',
        generation: 1,
        outputEpoch: 1,
        outputSeq: 2,
        raw: `raw:${screen}`,
        screen,
        cols: 80,
        rows: 24,
        alive: true,
        lastOutputAt: 10,
      },
    }
  }
}

describe('lib-orchestrator/remoteControl/remoteControlTerminal', () => {
  afterEach(() => vi.useRealTimers())

  it('waits for a snapshot, returns only a bounded untrusted screen and detaches', async () => {
    const harness = new RemoteTerminalHarness()
    const peek = harness.terminal.peek('session-1', { cols: 100, rows: 30 })
    const attachId = harness.sessions.onlyAttachId()
    expect(harness.sessions.attachments.get(attachId)?.spec).toEqual({
      sessionId: 'session-1',
      size: { cols: 100, rows: 30 },
    })

    harness.sessions.emit(attachId, TerminalFrames.attached(false))
    harness.sessions.emit(attachId, TerminalFrames.snapshot())

    await expect(peek).resolves.toEqual({
      ok: true,
      value: {
        sessionId: 'session-1',
        snapshot: {
          type: 'terminal.snapshot',
          projection: {
            runtimeSessionId: 'runtime-1',
            generation: 1,
            outputEpoch: 1,
            outputSeq: 2,
            screen: '56789',
            screenTruncated: true,
            cols: 80,
            rows: 24,
            alive: true,
            lastOutputAt: 10,
          },
        },
        terminalOutputUntrusted: true,
      },
    })
    expect(harness.sessions.detached).toEqual([attachId])
  })

  it('waits for writer confirmation before sending text and Enter', async () => {
    const harness = new RemoteTerminalHarness()
    const sent = harness.terminal.send('session-1', 'status', { enter: true })
    const attachId = harness.sessions.onlyAttachId()

    harness.sessions.emit(attachId, {
      type: 'terminal.status',
      status: 'connecting',
      detail: null,
    })
    harness.sessions.emit(attachId, TerminalFrames.snapshot('old screen'))
    expect(harness.sessions.inputs).toEqual([])
    harness.sessions.emit(attachId, TerminalFrames.attached(true))

    await expect(sent).resolves.toEqual({
      ok: true,
      value: {
        sessionId: 'session-1',
        accepted: true,
        characterCount: 6,
        enter: true,
      },
    })
    expect(harness.sessions.inputs).toEqual([{ attachId, data: 'status\r' }])
    expect(harness.sessions.detached).toEqual([attachId])
  })

  it('refuses a read-only writer without buffering input', async () => {
    const harness = new RemoteTerminalHarness()
    const sent = harness.terminal.send('session-1', 'danger', { enter: false })
    const attachId = harness.sessions.onlyAttachId()

    harness.sessions.emit(attachId, TerminalFrames.attached(false))

    await expect(sent).resolves.toEqual({
      ok: false,
      error: { code: 'conflict', detail: 'The terminal attach is read-only' },
    })
    expect(harness.sessions.inputs).toEqual([])
    expect(harness.sessions.detached).toEqual([attachId])
  })

  it('times out a connecting attach and maps immediate attach refusals', async () => {
    vi.useFakeTimers()
    const harness = new RemoteTerminalHarness(50)
    const peek = harness.terminal.peek('session-1', {})
    const attachId = harness.sessions.onlyAttachId()
    harness.sessions.emit(attachId, {
      type: 'terminal.status',
      status: 'connecting',
      detail: 'socket closed',
    })
    await vi.advanceTimersByTimeAsync(50)

    await expect(peek).resolves.toEqual({
      ok: false,
      error: { code: 'timeout', detail: 'The terminal peek operation timed out' },
    })
    expect(harness.sessions.detached).toEqual([attachId])

    harness.sessions.attachAnswer = {
      ok: false,
      code: 'host-unreachable',
      detail: 'no Host descriptor is published',
    }
    await expect(harness.terminal.send('session-1', 'x', { enter: false })).resolves.toEqual({
      ok: false,
      error: { code: 'unavailable', detail: 'no Host descriptor is published' },
    })
  })

  it('namespaces live attaches per owner, routes their frames and detaches one owner only', () => {
    const harness = new RemoteTerminalHarness()
    const firstFrames: TerminalFrame[] = []
    const secondFrames: TerminalFrame[] = []
    expect(harness.terminal.attachLive(
      'socket-a',
      'terminal-1',
      { sessionId: 'session-1', size: null },
      (frame) => firstFrames.push(frame),
    )).toMatchObject({ ok: true })
    expect(harness.terminal.attachLive(
      'socket-b',
      'terminal-1',
      { sessionId: 'session-1', size: null },
      (frame) => secondFrames.push(frame),
    )).toMatchObject({ ok: true })
    const internalIds = [...harness.sessions.attachments.keys()]
    expect(internalIds).toEqual(['control-live:internal-1', 'control-live:internal-2'])

    harness.sessions.emit(internalIds[0] ?? '', TerminalFrames.snapshot('first'))
    harness.sessions.emit(internalIds[1] ?? '', TerminalFrames.snapshot('second'))
    expect(firstFrames).toEqual([TerminalFrames.snapshot('first')])
    expect(secondFrames).toEqual([TerminalFrames.snapshot('second')])

    harness.terminal.detachOwner('socket-a')
    expect(harness.sessions.detachedAll).toEqual([['control-live:internal-1']])
    expect(harness.sessions.attachments.has('control-live:internal-2')).toBe(true)
  })

  it('reports live read-only input and ignored resize explicitly', () => {
    const harness = new RemoteTerminalHarness()
    harness.terminal.attachLive(
      'socket-a',
      'terminal-1',
      { sessionId: 'session-1', size: null },
      () => {},
    )
    harness.sessions.inputAnswer = { kind: 'not-writer' }
    harness.sessions.resizeAnswer = { kind: 'ignored' }

    expect(harness.terminal.inputLive('socket-a', 'terminal-1', 'x')).toEqual({
      ok: false,
      error: { code: 'conflict', detail: 'The terminal attach is read-only' },
    })
    expect(harness.terminal.resizeLive('socket-a', 'terminal-1', 120, 40)).toEqual({
      ok: true,
      value: { attachId: 'terminal-1', accepted: true, applied: false },
    })
  })
})
