import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  TerminalAttachResult,
  TerminalAttachSpec,
  TerminalComposerContent,
  TerminalComposerContentReading,
  TerminalComposerContentResult,
  TerminalComposerReading,
  TerminalComposerResult,
  TerminalFrame,
} from '../sessionManager/sessionManagerApi.types'
import type { HostDescriptor, HostWsClientMsg } from '../../app-host/app/wire/hostWire.js'
import type { TerminalAttachSocketDeps } from '../hostClient/terminalAttachSocket'
import { TerminalGateway } from '../sessionManager/terminals/terminalGateway'
import { AgentComposerReader } from '../sessionManager/workState/agentComposerReader'
import { WorkFixtures } from '../sessionManager/workState/fixtures/workFixtures'
import type { SessionTranscriptReading } from '../sessionTranscriptReader/sessionTranscriptReaderApi.types'
import type {
  TerminalPort,
  TerminalAttachOwner,
  TerminalInputResult,
  TerminalResizeResult,
} from '../sessionManager/terminalPort'
import {
  RemoteControlTerminal,
  type RemoteControlTerminalKeep,
  type RemoteControlTerminalSessionPort,
} from './remoteControlTerminal'

interface FakeAttachment {
  spec: TerminalAttachSpec
  owner: TerminalAttachOwner
}

class FakeTerminalSessions implements RemoteControlTerminalSessionPort, TerminalPort {
  async inhibit() { return { release: () => {} } }
  async pendingInput() { return 0 }
  async authorize() { return { refused: true as const } }
  readonly pending = new Map<string, boolean>()
  deliveryPending(sessionId: string, pending: boolean): void { this.pending.set(sessionId, pending) }
  readonly attachments = new Map<string, FakeAttachment>()
  readonly detached: string[] = []
  readonly detachedAll: string[][] = []
  readonly inputs: { attachId: string; data: string }[] = []
  readonly resizes: { attachId: string; cols: number; rows: number }[] = []
  readonly active: { attachId: string; active: boolean }[] = []
  attachAnswer: TerminalAttachResult = { ok: true }
  inputAnswer: TerminalInputResult = { kind: 'sent' }
  resizeAnswer: TerminalResizeResult = { kind: 'applied' }
  /** What the composer shows, as a function of everything written so far. */
  composer: (inputs: readonly string[]) => TerminalComposerResult = () => ({ ok: false, code: 'not-agent' })
  composerReads = 0
  /** What a whole-draft read shows, as a function of everything written so far. */
  content: (inputs: readonly string[]) => TerminalComposerContentResult | Promise<TerminalComposerContentResult> =
    () => ({ ok: false, code: 'not-agent' })
  contentReads = 0

  async attach(
    attachId: string,
    spec: TerminalAttachSpec,
    owner: TerminalAttachOwner,
  ): Promise<TerminalAttachResult> {
    if (this.attachAnswer.ok)
      this.attachments.set(attachId, { spec, owner })
    return this.attachAnswer
  }

  async transaction(attachId: string): ReturnType<TerminalPort['transaction']> {
    return { write: async (data: string) => this.input(attachId, data), end: () => {} }
  }

  async input(attachId: string, data: string): Promise<TerminalInputResult> {
    this.inputs.push({ attachId, data })
    return this.inputAnswer
  }

  async resize(attachId: string, cols: number, rows: number): Promise<TerminalResizeResult> {
    this.resizes.push({ attachId, cols, rows })
    return this.resizeAnswer
  }

  async setGeometryActive(attachId: string, active: boolean): Promise<TerminalResizeResult> {
    this.active.push({ attachId, active })
    return this.resizeAnswer
  }

  detach(attachId: string): void {
    this.detached.push(attachId)
    this.attachments.delete(attachId)
  }

  detachAll(attachIds: readonly string[]): void {
    this.detachedAll.push([...attachIds])
    for (const attachId of attachIds) this.attachments.delete(attachId)
  }

  async terminalComposer(_sessionId: string): Promise<TerminalComposerResult> {
    this.composerReads += 1
    return this.composer(this.inputs.map((input) => input.data))
  }

  async terminalComposerContent(_sessionId: string): Promise<TerminalComposerContentResult> {
    this.contentReads += 1
    return this.content(this.inputs.map((input) => input.data))
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
    this.terminal = new RemoteControlTerminal(this.sessions, this.sessions, {
      internalAttachId: () => `internal-${++this.nextId}`,
      onError: (message) => this.errors.push(message),
      timeoutMilliseconds,
      screenCharacterLimit,
    })
  }
}

class TerminalFrames {
  static attached(writer: boolean): Extract<TerminalFrame, { type: 'terminal.attached' }> {
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

  it('detaches a late acknowledged one-shot attach after timeout without processing its frames', async () => {
    vi.useFakeTimers()
    const harness = new RemoteTerminalHarness(100)
    const attach = harness.sessions.attach.bind(harness.sessions)
    let acknowledge!: () => void
    vi.spyOn(harness.sessions, 'attach').mockImplementation(async (...args) => {
      const answer = await attach(...args)
      await new Promise<void>(resolve => { acknowledge = resolve })
      return answer
    })
    const peeking = harness.terminal.peek('session-1', {})
    const attachId = harness.sessions.onlyAttachId()
    const oldOwner = harness.sessions.attachments.get(attachId)!.owner
    await vi.advanceTimersByTimeAsync(100)
    expect(harness.sessions.attachments.size).toBe(0)
    expect(await peeking).toMatchObject({ ok: false, error: { code: 'timeout' } })
    oldOwner.onFrame(TerminalFrames.snapshot('late'))
    acknowledge()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.sessions.detached).toEqual([attachId])
    expect(harness.sessions.attachments.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cleans a late live acknowledgement without touching a reused external attach id', async () => {
    const harness = new RemoteTerminalHarness()
    const attach = harness.sessions.attach.bind(harness.sessions)
    let acknowledge!: () => void
    const spy = vi.spyOn(harness.sessions, 'attach').mockImplementationOnce(async (...args) => {
      const answer = await attach(...args)
      await new Promise<void>(resolve => { acknowledge = resolve })
      return answer
    })
    const first = harness.terminal.attachLive('owner', 'reused', { sessionId: 'old', size: null }, () => {})
    await vi.waitFor(() => expect(acknowledge).toBeDefined())
    harness.terminal.detachOwner('owner')
    expect(await harness.terminal.attachLive('owner', 'reused', { sessionId: 'new', size: null }, () => {})).toMatchObject({ ok: true })
    acknowledge()
    expect(await first).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    expect(harness.sessions.attachments.has('control-live:internal-2')).toBe(true)
    expect(await harness.terminal.inputLive('owner', 'reused', 'new input')).toMatchObject({ ok: true })
    expect(harness.sessions.inputs).toEqual([{ attachId: 'control-live:internal-2', data: 'new input' }])
    harness.terminal.detachOwner('owner')
    spy.mockRestore()
  })

  it('keeps the writer attached and separates Enter from the paste burst before accepting', async () => {
    vi.useFakeTimers()
    const harness = new RemoteTerminalHarness(1_000)
    const sent = harness.terminal.send('session-1', 'status', { enter: true })
    const completed = vi.fn()
    void sent.then(completed)
    const attachId = harness.sessions.onlyAttachId()

    harness.sessions.emit(attachId, {
      type: 'terminal.status',
      status: 'connecting',
      detail: null,
    })
    harness.sessions.emit(attachId, TerminalFrames.snapshot('old screen'))
    expect(harness.sessions.inputs).toEqual([])
    harness.sessions.emit(attachId, TerminalFrames.attached(true))
    await vi.advanceTimersByTimeAsync(99)
    expect(harness.sessions.inputs).toEqual([{ attachId, data: 'status' }])
    expect(harness.sessions.detached).toEqual([])
    expect(completed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    await expect(sent).resolves.toEqual({
      ok: true,
      value: {
        sessionId: 'session-1',
        accepted: true,
        characterCount: 6,
        enter: true,
      },
    })
    expect(harness.sessions.inputs).toEqual([
      { attachId, data: 'status' },
      { attachId, data: '\r' },
    ])
    expect(harness.sessions.detached).toEqual([attachId])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves multiline text and raw control input without an implicit Enter', async () => {
    vi.useFakeTimers()
    const harness = new RemoteTerminalHarness(1_000)
    const text = '\x1b[200~První řádek\nsecond line\x1b[201~'
    const sent = harness.terminal.send('session-1', text, { enter: false })
    const attachId = harness.sessions.onlyAttachId()
    harness.sessions.emit(attachId, TerminalFrames.attached(true))
    await expect(sent).resolves.toMatchObject({ ok: true, value: { enter: false } })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(harness.sessions.inputs).toEqual([{ attachId, data: text }])
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    { type: 'terminal.status', status: 'read-only', detail: null },
    { type: 'terminal.status', status: 'connecting', detail: null },
    TerminalFrames.attached(true),
  ] satisfies TerminalFrame[])('cancels pending Enter after a writer transition: $type $status', async (frame) => {
    vi.useFakeTimers()
    const harness = new RemoteTerminalHarness(1_000)
    const sent = harness.terminal.send('session-1', 'message', { enter: true })
    const attachId = harness.sessions.onlyAttachId()
    harness.sessions.emit(attachId, TerminalFrames.attached(true))
    await vi.advanceTimersByTimeAsync(50)
    harness.sessions.emit(attachId, frame)
    await expect(sent).resolves.toMatchObject({ ok: false })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(harness.sessions.inputs).toEqual([{ attachId, data: 'message' }])
    expect(harness.sessions.detached).toEqual([attachId])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not send a late Enter after the request times out', async () => {
    vi.useFakeTimers()
    const harness = new RemoteTerminalHarness(50)
    const sent = harness.terminal.send('session-1', 'message', { enter: true })
    const attachId = harness.sessions.onlyAttachId()
    harness.sessions.emit(attachId, TerminalFrames.attached(true))
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(sent).resolves.toMatchObject({ ok: false, error: { code: 'timeout' } })
    expect(harness.sessions.inputs).toEqual([{ attachId, data: 'message' }])
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['not-writer', 'unknown-attach'] as const)('reports a refused Enter instead of accepted: %s', async (kind) => {
    vi.useFakeTimers()
    const harness = new RemoteTerminalHarness(1_000)
    const sent = harness.terminal.send('session-1', 'message', { enter: true })
    const attachId = harness.sessions.onlyAttachId()
    harness.sessions.emit(attachId, TerminalFrames.attached(true))
    harness.sessions.inputAnswer = { kind }
    await vi.advanceTimersByTimeAsync(100)
    await expect(sent).resolves.toMatchObject({ ok: false })
    expect(harness.sessions.detached).toEqual([attachId])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cleans up and reports an input exception in the delayed Enter callback', async () => {
    vi.useFakeTimers()
    const harness = new RemoteTerminalHarness(1_000)
    const sent = harness.terminal.send('session-1', 'message', { enter: true })
    const attachId = harness.sessions.onlyAttachId()
    harness.sessions.emit(attachId, TerminalFrames.attached(true))
    vi.spyOn(harness.sessions, 'input').mockImplementation(() => { throw new Error('socket failed') })
    await vi.advanceTimersByTimeAsync(100)
    await expect(sent).resolves.toMatchObject({ ok: false, error: { code: 'operation-failed' } })
    expect(harness.errors).toEqual(['Remote terminal send failed: socket failed'])
    expect(harness.sessions.detached).toEqual([attachId])
    expect(vi.getTimerCount()).toBe(0)
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

  it('namespaces live attaches per owner, routes their frames and detaches one owner only', async () => {
    const harness = new RemoteTerminalHarness()
    const firstFrames: TerminalFrame[] = []
    const secondFrames: TerminalFrame[] = []
    expect((await harness.terminal.attachLive(
      'socket-a',
      'terminal-1',
      { sessionId: 'session-1', size: null },
      (frame) => firstFrames.push(frame),
    ))).toMatchObject({ ok: true })
    expect((await harness.terminal.attachLive(
      'socket-b',
      'terminal-1',
      { sessionId: 'session-1', size: null },
      (frame) => secondFrames.push(frame),
    ))).toMatchObject({ ok: true })
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

  it('reports live read-only input and ignored resize explicitly', async () => {
    const harness = new RemoteTerminalHarness()
    await harness.terminal.attachLive(
      'socket-a',
      'terminal-1',
      { sessionId: 'session-1', size: null },
      () => {},
    )
    harness.sessions.inputAnswer = { kind: 'not-writer' }
    harness.sessions.resizeAnswer = { kind: 'ignored' }

    expect((await harness.terminal.inputLive('socket-a', 'terminal-1', 'x'))).toEqual({
      ok: false,
      error: { code: 'conflict', detail: 'The terminal attach is read-only' },
    })
    expect((await harness.terminal.resizeLive('socket-a', 'terminal-1', 120, 40))).toEqual({
      ok: true,
      value: { attachId: 'terminal-1', accepted: true, applied: false },
    })
  })
})

class DeliverHarness {
  readonly sessions = new FakeTerminalSessions()
  readonly errors: string[] = []
  readonly terminal: RemoteControlTerminal
  transcript: (inputs: readonly string[]) => SessionTranscriptReading = () => DeliverReadings.transcript(0)
  clock = 0

  constructor() {
    this.terminal = new RemoteControlTerminal(this.sessions, this.sessions, {
      internalAttachId: () => 'deliver-1',
      onError: (message) => this.errors.push(message),
      pause: async (milliseconds) => { this.clock += milliseconds },
      now: () => this.clock,
    })
  }

  deliver(
    text: string,
    options: {
      input?: 'paste' | 'typed'
      writer?: boolean
      readyTimeoutMs?: number
      submitTimeoutMs?: number
      queue?: boolean
    } = {},
  ): ReturnType<RemoteControlTerminal['deliver']> {
    const answer = this.terminal.deliver('session-1', text, {
      input: options.input ?? 'paste',
      readyTimeoutMs: options.readyTimeoutMs ?? 45_000,
      submitTimeoutMs: options.submitTimeoutMs ?? 10_000,
      ...(options.queue === undefined ? {} : { queue: options.queue }),
    }, { transcript: async () => this.transcript(this.written()) })
    this.sessions.emit(this.sessions.onlyAttachId(), TerminalFrames.attached(options.writer ?? true))
    return answer
  }

  written(): string[] {
    return this.sessions.inputs.map((input) => input.data)
  }
}

class DeliverReadings {
  static reading(overrides: Partial<TerminalComposerReading> = {}): TerminalComposerResult {
    return {
      ok: true,
      reading: {
        agentId: 'claude',
        alive: true,
        hint: 'idle',
        composer: { state: 'empty' },
        queuedRow: false,
        echoHead: null,
        pastePlaceholders: 0,
        onlyPlaceholders: false,
        ...overrides,
      },
    }
  }

  static text(text: string, overrides: Partial<TerminalComposerReading> = {}): TerminalComposerResult {
    return DeliverReadings.reading({ composer: { state: 'text', text }, ...overrides })
  }

  /** `userTurns` user messages; the newest one reads `latest` when it is given. */
  static transcript(userTurns: number, latest?: string): SessionTranscriptReading {
    return {
      kind: 'messages',
      messages: Array.from({ length: userTurns }, (_, index) => ({
        role: 'user' as const,
        text: latest !== undefined && index === userTurns - 1 ? latest : `turn ${index}`,
        at: 1_000 + index,
        textTruncated: false,
      })),
      bounds: { maxMessages: 10, maxCharactersPerMessage: 2_000, scannedBytes: 64 },
      earlierContentOmitted: false,
    }
  }

  /** A transcript that gains `text` as a new user turn once Enter was written. */
  static submitted(text: string, before = 0) {
    return (inputs: readonly string[]): SessionTranscriptReading => inputs.includes('\r')
      ? DeliverReadings.transcript(before + 1, text)
      : DeliverReadings.transcript(before)
  }

  /** An agent that shows what was typed and clears it on Enter, as both TUIs do. */
  static echoing(text: string, afterEnter: TerminalComposerResult = DeliverReadings.reading()) {
    return (inputs: readonly string[]): TerminalComposerResult => {
      if (inputs.length === 0) return DeliverReadings.reading()
      if (inputs.length === 1) return DeliverReadings.text(text)
      return afterEnter
    }
  }
}

describe('lib-orchestrator/remoteControl/remoteControlTerminal deliver', () => {
  afterEach(() => vi.useRealTimers())

  it.each((['text', 'enter'] as const).flatMap(phase =>
    (['connecting', 'reattached', 'read-only', 'timeout'] as const).flatMap(stop =>
      (['sent', 'not-writer'] as const).map(ack => ({ phase, stop, ack }))))
  )('settles delayed $phase acknowledgement $ack after $stop without follow-up input or reads', async ({ phase, stop, ack }) => {
    vi.useFakeTimers()
    const harness = new DeliverHarness()
    harness.sessions.composer = DeliverReadings.echoing('payload')
    harness.transcript = DeliverReadings.submitted('payload')
    const input = harness.sessions.input.bind(harness.sessions)
    let acknowledge!: () => void
    vi.spyOn(harness.sessions, 'input').mockImplementation(async (attachId, data) => {
      const hold = phase === 'text' ? data !== '\r' : data === '\r'
      if (!hold) return input(attachId, data)
      if (ack === 'sent') await input(attachId, data)
      await new Promise<void>(resolve => { acknowledge = resolve })
      return { kind: ack }
    })
    const delivering = harness.deliver('payload', { input: 'typed' })
    const attachId = harness.sessions.onlyAttachId()
    const owner = harness.sessions.attachments.get(attachId)!.owner
    let completed = false
    void delivering.then(() => { completed = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(acknowledge).toBeDefined()
    const reads = harness.sessions.composerReads
    const written = [...harness.written()]
    if (stop === 'timeout') await vi.runOnlyPendingTimersAsync()
    else if (stop === 'reattached') owner.onFrame(TerminalFrames.attached(true))
    else if (stop === 'connecting' || stop === 'read-only')
      owner.onFrame({ type: 'terminal.status', status: stop, detail: 'during acknowledgement' })
    else throw new Error(`Unknown stop: ${stop satisfies never}`)
    await vi.advanceTimersByTimeAsync(0)
    expect(completed).toBe(false)
    expect(harness.sessions.pending.get('session-1')).toBe(true)
    acknowledge()
    const typed = phase === 'enter' || ack === 'sent'
    const entered = phase === 'enter' && ack === 'sent' ? 1 : 0
    const code = stop === 'timeout' ? 'timeout' : stop === 'read-only' ? 'conflict' : 'unavailable'
    const reason = stop === 'timeout' ? typed ? 'unproven' : 'not-ready'
      : stop === 'connecting' ? 'disconnected' : stop === 'reattached' ? 'reattached' : 'read-only'
    expect(await delivering).toMatchObject({ ok: false, error: { code, data: { typed, entered, reason } } })
    expect(harness.sessions.pending.get('session-1')).toBe(false)
    expect(harness.written()).toEqual(written)
    expect(harness.sessions.composerReads).toBe(reads)
    expect(harness.sessions.attachments.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('maps a rejected input acknowledgement without claiming emitted text or sending Enter', async () => {
    const harness = new DeliverHarness()
    harness.sessions.composer = DeliverReadings.echoing('payload')
    vi.spyOn(harness.sessions, 'input').mockRejectedValue(new Error('input transport failed'))
    expect(await harness.deliver('payload', { input: 'typed' })).toMatchObject({ ok: false,
      error: { code: 'operation-failed', data: { typed: false, entered: 0, reason: 'failed' } } })
    expect(harness.sessions.composerReads).toBe(1)
    expect(harness.written()).toEqual([])
    expect(harness.errors).toEqual(['Remote terminal send failed: input transport failed'])
  })

  it.each(['send', 'send-enter', 'deliver'] as const)('cancels a real gateway queued %s on timeout without late input or pending work', async operation => {
    vi.useFakeTimers()
    const sessions = new FakeTerminalSessions()
    const written: string[] = []
    const errors: string[] = []
    const gateway = new TerminalGateway({
      descriptorOf: () => ({ hostInstanceId: 'host' }) as HostDescriptor,
      leaseIdOf: () => 'lease', onError: message => errors.push(message),
      activity: { userInput: () => {}, pendingInputHint: () => {} },
      socketFactory: deps => ({ connect: () => {}, close: () => {}, send: frame => {
        if (frame.type === 'terminal.attach') deps.onFrame(TerminalFrames.attached(true))
        else if (frame.type === 'terminal.input') written.push(frame.data)
      } }),
    })
    await gateway.publishRefs([{ sessionId: 'session-1', resolution: { ok: true, alive: true,
      ref: { hostInstanceId: 'host', runtimeSessionId: 'runtime-1', generation: 1 } } }])
    sessions.composer = () => DeliverReadings.echoing('queued text')(written)
    const terminal = new RemoteControlTerminal(sessions, gateway, { onError: message => errors.push(message) })
    const held = await gateway.inhibit('session-1')
    let pending: Promise<unknown>
    if (operation === 'send' || operation === 'send-enter')
      pending = terminal.send('session-1', 'queued text', { enter: operation === 'send-enter', timeoutMs: 100 })
    else if (operation === 'deliver')
      pending = terminal.deliver('session-1', 'queued text', { input: 'typed', readyTimeoutMs: 100, submitTimeoutMs: 100 },
        { transcript: async () => DeliverReadings.transcript(0) })
    else throw new Error(`Unknown operation: ${operation satisfies never}`)
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(await gateway.pendingInput('session-1')).toBe(1)
      expect(gateway.attachmentCount()).toBe(1)
      expect(written).toEqual([])
      if (operation === 'deliver') expect(sessions.pending.get('session-1')).toBe(true)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(await pending).toMatchObject({ ok: false, error: { code: 'timeout' } })
      if (operation === 'deliver') {
        expect(await pending).toMatchObject({ error: { data: { typed: false, entered: 0 } } })
        expect(sessions.pending.get('session-1')).toBe(false)
        expect(sessions.composerReads).toBe(1)
      }
      expect(await gateway.pendingInput('session-1')).toBe(0)
      expect(gateway.attachmentCount()).toBe(0)
      held.release()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(written).toEqual([])
      expect(errors).toEqual(['Queued input for session-1 was refused because its terminal attachment changed'])
    } finally {
      held.release()
      gateway.closeAll()
    }
  })

  it('marks plain-text automation delivery through the real gateway with its captured input time', async () => {
    const sessions = new FakeTerminalSessions()
    const marks: { sessionId: string; at: number }[] = []
    const written: string[] = []
    const gateway = new TerminalGateway({ descriptorOf: () => ({ hostInstanceId: 'host' }) as HostDescriptor,
      leaseIdOf: () => 'lease', onError: message => { throw new Error(message) },
      activity: { userInput: batch => marks.push(...batch), pendingInputHint: () => {} },
      socketFactory: deps => ({ connect: () => {}, close: () => {}, send: frame => {
        if (frame.type === 'terminal.attach') deps.onFrame(TerminalFrames.attached(true))
        else if (frame.type === 'terminal.input') written.push(frame.data)
      } }),
    })
    await gateway.publishRefs([{ sessionId: 'session-1', resolution: { ok: true, alive: true,
      ref: { hostInstanceId: 'host', runtimeSessionId: 'runtime-1', generation: 1 } } }])
    let clock = 0
    const terminal = new RemoteControlTerminal(sessions, gateway, { onError: message => { throw new Error(message) },
      now: () => clock, pause: async milliseconds => { clock += milliseconds } })
    sessions.composer = () => DeliverReadings.echoing('automation text')(written)
    const before = Date.now()
    try {
      const result = await terminal.deliver('session-1', 'automation text', { input: 'typed', readyTimeoutMs: 5_000, submitTimeoutMs: 5_000 },
        { transcript: async () => DeliverReadings.submitted('automation text')(written) })
      expect(result).toMatchObject({ ok: true, value: { delivered: true } })
      expect(written).toEqual(['automation text', '\r'])
      expect(marks).toHaveLength(1)
      expect(marks[0]?.sessionId).toBe('session-1')
      expect(marks[0]?.at).toBeGreaterThanOrEqual(before)
      expect(marks[0]?.at).toBeLessThanOrEqual(Date.now())
    } finally { gateway.closeAll() }
  })

  const pasted = (text: string): string => `\x1b[200~${text}\x1b[201~`

  it('pastes into an idle composer, presses Enter once and proves it by the transcript', async () => {
    const harness = new DeliverHarness()
    harness.sessions.composer = DeliverReadings.echoing('Read the file.')
    harness.transcript = DeliverReadings.submitted('Read the file.', 2)

    const result = await harness.deliver('Read the file.')

    expect(result).toEqual({
      ok: true,
      value: {
        sessionId: 'session-1',
        accepted: true,
        characterCount: 14,
        delivered: true,
        input: 'paste',
        composeProof: 'text',
        proof: 'transcript',
        submitKey: 'enter',
        readyAfterMs: 0,
        submittedAfterMs: 1_200,
      },
    })
    expect(harness.written()).toEqual([pasted('Read the file.'), '\r'])
    expect(harness.sessions.detached).toEqual(['control-deliver:deliver-1'])
  })

  it('writes typed text raw and waits through the boot until the composer appears', async () => {
    const harness = new DeliverHarness()
    const echo = DeliverReadings.echoing('status')
    harness.sessions.composer = (inputs) => harness.sessions.composerReads <= 3
      ? DeliverReadings.reading({ composer: { state: 'absent' }, hint: 'unknown' })
      : echo(inputs)
    harness.transcript = DeliverReadings.submitted('status')

    const result = await harness.deliver('status', { input: 'typed' })

    expect(result).toMatchObject({ ok: true, value: { input: 'typed', readyAfterMs: 750, proof: 'transcript' } })
    expect(harness.written()).toEqual(['status', '\r'])
  })

  it.each([
    { name: 'a dialog', reading: DeliverReadings.reading({ hint: 'blocked', composer: { state: 'absent' } }), code: 'conflict', reason: 'dialog' },
    { name: 'a waiting prompt', reading: DeliverReadings.reading({ hint: 'waiting' }), code: 'conflict', reason: 'dialog' },
    { name: 'a foreign draft', reading: DeliverReadings.text('somebody else'), code: 'conflict', reason: 'foreign-draft' },
    { name: 'a dead runtime', reading: DeliverReadings.reading({ alive: false }), code: 'not-found', reason: 'not-live' },
  ])('refuses $name before writing anything', async ({ reading, code, reason }) => {
    const harness = new DeliverHarness()
    harness.sessions.composer = () => reading

    const result = await harness.deliver('hello')

    expect(result).toMatchObject({
      ok: false,
      error: { code, data: { stage: 'ready', reason, typed: false, entered: 0 } },
    })
    expect(harness.written()).toEqual([])
    expect(harness.sessions.detached).toEqual(['control-deliver:deliver-1'])
  })

  // The box runs through blank rows to its bottom rule, so such a draft is seen, and refused, at once
  // instead of reading as no box until the ready timeout.
  it('refuses a recorded Claude draft holding a blank row as foreign on the first reading', async () => {
    const fixture = WorkFixtures.of('claude').find((candidate) => candidate.file === 'claude-live-composer-blank-line.json')
    if (fixture === undefined) throw new Error('missing work fixture claude-live-composer-blank-line.json')
    const harness = new DeliverHarness()
    harness.sessions.composer = () => DeliverReadings.reading(AgentComposerReader.read('claude', fixture.frame))

    const result = await harness.deliver('hello', { readyTimeoutMs: 1_000 })

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'conflict', data: { stage: 'ready', reason: 'foreign-draft', typed: false, entered: 0 } },
    })
    expect(harness.sessions.composerReads).toBe(1)
    expect(harness.written()).toEqual([])
  })

  it('times out while the composer never appears, with the last screen facts and nothing written', async () => {
    const harness = new DeliverHarness()
    harness.sessions.composer = () => DeliverReadings.reading({ composer: { state: 'absent' }, hint: 'unknown' })

    const result = await harness.deliver('hello', { readyTimeoutMs: 1_000 })

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'timeout',
        detail: 'The composer never became ready',
        data: { stage: 'ready', reason: 'not-ready', typed: false, entered: 0, hint: 'unknown', composer: { state: 'absent' } },
      },
    })
    expect(harness.written()).toEqual([])
  })

  it('waits through a missing projection rather than refusing', async () => {
    const harness = new DeliverHarness()
    const echo = DeliverReadings.echoing('hello')
    harness.sessions.composer = (inputs) => harness.sessions.composerReads === 1
      ? { ok: false, code: 'no-projection' }
      : echo(inputs)
    harness.transcript = DeliverReadings.submitted('hello')

    expect(await harness.deliver('hello')).toMatchObject({ ok: true, value: { readyAfterMs: 250 } })
  })

  it('stops after one write when the text never shows in the composer', async () => {
    const harness = new DeliverHarness()
    harness.sessions.composer = () => DeliverReadings.reading()

    const result = await harness.deliver('hello')

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'operation-failed', data: { stage: 'compose', reason: 'text-not-visible', typed: true, entered: 0 } },
    })
    expect(harness.written()).toEqual([pasted('hello')])
  })

  it('accepts a collapsed paste placeholder as the composed text', async () => {
    const harness = new DeliverHarness()
    const text = 'line one\nline two\nline three'
    harness.sessions.composer = (inputs) => inputs.length === 1
      ? DeliverReadings.text('[Pasted text #1 +2 lines]', { pastePlaceholders: 1, onlyPlaceholders: true })
      : DeliverReadings.reading()
    harness.transcript = DeliverReadings.submitted(text)

    expect(await harness.deliver(text)).toMatchObject({
      ok: true,
      value: { input: 'paste', composeProof: 'placeholder', proof: 'transcript', characterCount: text.length },
    })
    expect(harness.written()).toEqual([pasted(text), '\r'])
  })

  it('does not take a placeholder with a foreign draft around it as ours, and never submits it', async () => {
    const harness = new DeliverHarness()
    harness.sessions.composer = (inputs) => inputs.length === 0
      ? DeliverReadings.reading()
      : DeliverReadings.text('fix this [Pasted text #1 +2 lines]', { pastePlaceholders: 1, onlyPlaceholders: false })

    expect(await harness.deliver('line one\nline two\nline three'))
      .toMatchObject({ ok: false, error: { data: { reason: 'text-not-visible', entered: 0 } } })
    expect(harness.written()).toEqual([pasted('line one\nline two\nline three')])
  })

  it('refuses a second delivery to the same session while the first one runs', async () => {
    const harness = new DeliverHarness()
    harness.sessions.composer = DeliverReadings.echoing('hello')
    harness.transcript = DeliverReadings.submitted('hello')

    const first = harness.deliver('hello')
    const second = await harness.terminal.deliver('session-1', 'other', {
      input: 'paste',
      readyTimeoutMs: 1_000,
      submitTimeoutMs: 1_000,
    }, { transcript: async () => DeliverReadings.transcript(0) })

    expect(second).toEqual({
      ok: false,
      error: {
        code: 'conflict',
        detail: 'Another delivery to this session is still running',
        data: { stage: 'ready', reason: 'in-flight', typed: false, entered: 0, hint: null, composer: null },
      },
    })
    expect(await first).toMatchObject({ ok: true })
    expect(harness.written()).toEqual([pasted('hello'), '\r'])
  })

  it('takes a newer user turn as transcript proof only when it starts with our text', async () => {
    const other = new DeliverHarness()
    other.sessions.composer = DeliverReadings.echoing('hello there')
    other.transcript = DeliverReadings.submitted('something somebody else sent')
    const own = new DeliverHarness()
    own.sessions.composer = DeliverReadings.echoing('Hello there')
    own.transcript = DeliverReadings.submitted('hello   THERE and more the agent added')

    expect(await other.deliver('hello there', { submitTimeoutMs: 3_000 }))
      .toMatchObject({ ok: false, error: { data: { reason: 'unproven' } } })
    expect(await own.deliver('Hello there')).toMatchObject({ ok: true, value: { proof: 'transcript' } })
  })

  it('does not take a placeholder as proof for typed text', async () => {
    const harness = new DeliverHarness()
    harness.sessions.composer = (inputs) => inputs.length === 1
      ? DeliverReadings.text('[Pasted text #1 +2 lines]', { pastePlaceholders: 1 })
      : DeliverReadings.reading()

    expect(await harness.deliver('hello', { input: 'typed' }))
      .toMatchObject({ ok: false, error: { data: { reason: 'text-not-visible' } } })
  })

  it('compares a draft the terminal wrapped, and refuses one with another tail', async () => {
    const own = 'Read Q:/Apps/One/.aidocs/temp/task.md completely and follow every step it names.'
    const wrapped = new DeliverHarness()
    wrapped.sessions.composer = DeliverReadings.echoing(`Read Q:/Apps/One/.aidocs/temp/task.md completely and\n  follow every step it names.`)
    wrapped.transcript = DeliverReadings.submitted(own)
    const other = new DeliverHarness()
    other.sessions.composer = DeliverReadings.echoing(`Read Q:/Apps/One/.aidocs/temp/task.md completely and follow something else.`)

    expect(await wrapped.deliver(own)).toMatchObject({ ok: true, value: { composeProof: 'text' } })
    expect(await other.deliver(own)).toMatchObject({ ok: false, error: { data: { reason: 'text-not-visible' } } })
  })

  it('proves a submit by the working hint only when the target was idle at ready time', async () => {
    const harness = new DeliverHarness()
    harness.sessions.composer = DeliverReadings.echoing('hello', DeliverReadings.reading({ hint: 'working' }))

    expect(await harness.deliver('hello')).toMatchObject({ ok: true, value: { proof: 'working', submittedAfterMs: 400 } })
  })

  it('proves a typed slash command by the compacting hint that follows it', async () => {
    const harness = new DeliverHarness()
    harness.sessions.composer = DeliverReadings.echoing('/compact', DeliverReadings.reading({ hint: 'compacting' }))

    expect(await harness.deliver('/compact', { input: 'typed' }))
      .toMatchObject({ ok: true, value: { input: 'typed', composeProof: 'text', proof: 'working' } })
  })

  it('proves a queued message on a busy target by a new queued row, not by the busy hint', async () => {
    const busy = new DeliverHarness()
    busy.sessions.composer = (inputs) => {
      if (inputs.length === 0) return DeliverReadings.reading({ hint: 'working' })
      if (inputs.length === 1) return DeliverReadings.text('hello', { hint: 'working' })
      return DeliverReadings.reading({ hint: 'working', queuedRow: true })
    }
    const unproven = new DeliverHarness()
    unproven.sessions.composer = (inputs) => {
      if (inputs.length === 1) return DeliverReadings.text('hello', { hint: 'working' })
      return DeliverReadings.reading({ hint: 'working' })
    }

    expect(await busy.deliver('hello')).toMatchObject({ ok: true, value: { proof: 'queued' } })
    expect(await unproven.deliver('hello', { submitTimeoutMs: 1_000 })).toMatchObject({
      ok: false,
      error: { code: 'operation-failed', data: { stage: 'submit', reason: 'unproven', typed: true, entered: 1, hint: 'working' } },
    })
    expect(unproven.written()).toEqual([pasted('hello'), '\r'])
  })

  it('proves a Codex queue only by a queued row that was not on screen at ready time', async () => {
    const codex = { agentId: 'codex' as const, hint: 'working' as const }
    const fresh = new DeliverHarness()
    fresh.sessions.composer = (inputs) => {
      if (inputs.length === 0) return DeliverReadings.reading(codex)
      if (inputs.length === 1) return DeliverReadings.text('hello', codex)
      return DeliverReadings.reading({ ...codex, queuedRow: true })
    }
    const earlier = new DeliverHarness()
    earlier.sessions.composer = (inputs) => {
      if (inputs.length === 1) return DeliverReadings.text('hello', { ...codex, queuedRow: true })
      return DeliverReadings.reading({ ...codex, queuedRow: true })
    }

    expect(await fresh.deliver('hello')).toMatchObject({ ok: true, value: { proof: 'queued' } })
    expect(await earlier.deliver('hello', { submitTimeoutMs: 1_000 })).toMatchObject({
      ok: false, error: { data: { stage: 'submit', reason: 'unproven' } },
    })
  })

  it('queues behind a busy Codex turn with Tab and proves it only by a new queued row', async () => {
    const codex = { agentId: 'codex' as const, hint: 'working' as const }
    const queued = new DeliverHarness()
    queued.sessions.composer = (inputs) => {
      if (inputs.length === 0) return DeliverReadings.reading(codex)
      if (inputs.length === 1) return DeliverReadings.text('hello', codex)
      return DeliverReadings.reading({ ...codex, queuedRow: true })
    }

    expect(await queued.deliver('hello', { queue: true })).toMatchObject({
      ok: true,
      value: { proof: 'queued', submitKey: 'tab' },
    })
    expect(queued.written()).toEqual([pasted('hello'), '\t'])

    // A cleared composer under a still-busy hint is what a steer looks like too: not proof for Tab.
    const steered = new DeliverHarness()
    steered.sessions.composer = (inputs) => {
      if (inputs.length === 1) return DeliverReadings.text('hello', { ...codex, hint: 'idle' })
      if (inputs.length === 0) return DeliverReadings.reading(codex)
      return DeliverReadings.reading({ ...codex, hint: 'tool-use' })
    }
    expect(await steered.deliver('hello', { queue: true, submitTimeoutMs: 1_000 })).toMatchObject({
      ok: false,
      error: { data: { stage: 'submit', reason: 'unproven', entered: 1 } },
    })
    expect(steered.written()).toEqual([pasted('hello'), '\t'])
  })

  it('accepts the transcript as proof of a Tab queue', async () => {
    const codex = { agentId: 'codex' as const, hint: 'background' as const }
    const harness = new DeliverHarness()
    harness.sessions.composer = DeliverReadings.echoing('hello', DeliverReadings.reading(codex))
    harness.sessions.composer = (inputs) => inputs.length === 1
      ? DeliverReadings.text('hello', codex)
      : DeliverReadings.reading(codex)
    harness.transcript = (inputs) => inputs.includes('\t')
      ? DeliverReadings.transcript(1, 'hello')
      : DeliverReadings.transcript(0)

    expect(await harness.deliver('hello', { queue: true })).toMatchObject({
      ok: true,
      value: { proof: 'transcript', submitKey: 'tab' },
    })
  })

  it('presses the same key again for the second try when a Tab queue leaves the draft', async () => {
    const codex = { agentId: 'codex' as const, hint: 'compacting' as const }
    const harness = new DeliverHarness()
    harness.sessions.composer = (inputs) => inputs.length === 0
      ? DeliverReadings.reading(codex)
      : DeliverReadings.text('hello', codex)

    expect(await harness.deliver('hello', { queue: true, submitTimeoutMs: 5_000 })).toMatchObject({
      ok: false,
      error: { data: { reason: 'draft-remains', entered: 2 } },
    })
    expect(harness.written()).toEqual([pasted('hello'), '\t', '\t'])
  })

  it('keeps Enter for queue on Claude and on an idle Codex', async () => {
    const claude = new DeliverHarness()
    claude.sessions.composer = (inputs) => {
      if (inputs.length === 0) return DeliverReadings.reading({ hint: 'working' })
      if (inputs.length === 1) return DeliverReadings.text('hello', { hint: 'working' })
      return DeliverReadings.reading({ hint: 'working', queuedRow: true })
    }
    const idle = new DeliverHarness()
    idle.sessions.composer = DeliverReadings.echoing('hello', DeliverReadings.reading({ agentId: 'codex', hint: 'working' }))
    const idleCodex = { agentId: 'codex' as const }
    idle.sessions.composer = (inputs) => {
      if (inputs.length === 0) return DeliverReadings.reading(idleCodex)
      if (inputs.length === 1) return DeliverReadings.text('hello', idleCodex)
      return DeliverReadings.reading({ ...idleCodex, hint: 'working' })
    }

    expect(await claude.deliver('hello', { queue: true })).toMatchObject({
      ok: true,
      value: { proof: 'queued', submitKey: 'enter' },
    })
    expect(claude.written()).toEqual([pasted('hello'), '\r'])
    expect(await idle.deliver('hello', { queue: true })).toMatchObject({
      ok: true,
      value: { proof: 'working', submitKey: 'enter' },
    })
    expect(idle.written()).toEqual([pasted('hello'), '\r'])
  })

  it('proves a submit by a new echo head and ignores the one already on screen', async () => {
    const fresh = new DeliverHarness()
    fresh.sessions.composer = DeliverReadings.echoing('Hello there', DeliverReadings.reading({ echoHead: 'hellothere' }))
    const stale = new DeliverHarness()
    stale.sessions.composer = (inputs) => {
      if (inputs.length === 0) return DeliverReadings.reading({ echoHead: 'hello' })
      if (inputs.length === 1) return DeliverReadings.text('hello', { echoHead: 'hello' })
      return DeliverReadings.reading({ echoHead: 'hello' })
    }

    expect(await fresh.deliver('Hello there')).toMatchObject({ ok: true, value: { proof: 'echo' } })
    expect(await stale.deliver('hello', { submitTimeoutMs: 1_000 }))
      .toMatchObject({ ok: false, error: { data: { reason: 'unproven' } } })
  })

  it('presses Enter a second time only over its own draft, and then reports the draft that remains', async () => {
    const harness = new DeliverHarness()
    harness.sessions.composer = (inputs) => inputs.length === 0 ? DeliverReadings.reading() : DeliverReadings.text('hello')

    const result = await harness.deliver('hello', { submitTimeoutMs: 5_000 })

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'operation-failed', data: { stage: 'submit', reason: 'draft-remains', typed: true, entered: 2 } },
    })
    expect(harness.written()).toEqual([pasted('hello'), '\r', '\r'])
  })

  it('sends no second Enter over a draft that is not its own', async () => {
    const harness = new DeliverHarness()
    harness.sessions.composer = DeliverReadings.echoing('hello', DeliverReadings.text('somebody typed this'))

    const result = await harness.deliver('hello', { submitTimeoutMs: 5_000 })

    expect(result).toMatchObject({ ok: false, error: { data: { reason: 'unproven', entered: 1 } } })
    expect(harness.written()).toEqual([pasted('hello'), '\r'])
  })

  it('answers unavailable when the terminal disconnects after the text was written', async () => {
    const harness = new DeliverHarness()
    harness.sessions.composer = (inputs) => {
      if (inputs.length === 1)
        harness.sessions.emit('control-deliver:deliver-1', { type: 'terminal.status', status: 'connecting', detail: null })
      return DeliverReadings.reading()
    }

    const result = await harness.deliver('hello')

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'unavailable', data: { stage: 'compose', reason: 'disconnected', typed: true } },
    })
    expect(harness.written()).toEqual([pasted('hello')])
    expect(harness.sessions.detached).toEqual(['control-deliver:deliver-1'])
  })

  it('refuses a read-only attach without reading the composer', async () => {
    const harness = new DeliverHarness()
    harness.sessions.composer = () => DeliverReadings.reading()

    expect(await harness.deliver('hello', { writer: false })).toMatchObject({
      ok: false,
      error: { code: 'conflict', data: { stage: 'ready', reason: 'read-only', typed: false } },
    })
    expect(harness.sessions.composerReads).toBe(0)
    expect(harness.written()).toEqual([])
  })

  it('gives an attach refusal the failure data too', async () => {
    const harness = new DeliverHarness()
    harness.sessions.attachAnswer = { ok: false, code: 'not-live', detail: 'The session is not live' }

    const result = await harness.terminal.deliver('session-1', 'hello', {
      input: 'paste',
      readyTimeoutMs: 1_000,
      submitTimeoutMs: 1_000,
    }, { transcript: async () => DeliverReadings.transcript(0) })

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'not-found', data: { stage: 'attach', reason: 'not-live', typed: false, entered: 0, hint: null, composer: null } },
    })
  })
})

class TakeHarness {
  static readonly attachIdConst = 'control-take:take-1'
  readonly sessions = new FakeTerminalSessions()
  readonly errors: string[] = []
  readonly terminal: RemoteControlTerminal
  clock = 0

  constructor(timeoutMilliseconds?: number) {
    this.terminal = new RemoteControlTerminal(this.sessions, this.sessions, {
      internalAttachId: () => 'take-1',
      onError: (message) => this.errors.push(message),
      pause: async (milliseconds) => { this.clock += milliseconds },
      now: () => this.clock,
      ...(timeoutMilliseconds === undefined ? {} : { timeoutMilliseconds }),
    })
  }

  take(keep: RemoteControlTerminalKeep = () => ({ ok: true }), writer = true): ReturnType<RemoteControlTerminal['take']> {
    const answer = this.terminal.take('session-1', keep)
    this.sessions.emit(this.sessions.onlyAttachId(), TerminalFrames.attached(writer))
    return answer
  }

  written(): string[] {
    return this.sessions.inputs.map((input) => input.data)
  }
}

class TakeReadings {
  static reading(
    content: TerminalComposerContent,
    overrides: Partial<TerminalComposerContentReading> = {},
  ): TerminalComposerContentResult {
    return { ok: true, reading: { agentId: 'claude', alive: true, hint: 'idle', content, ...overrides } }
  }

  /** A prompt holding `text` until anything is written, and `after` from then on. */
  static erasing(
    text: string,
    eraseBound: number,
    after: TerminalComposerContentResult = TakeReadings.reading({ kind: 'empty' }),
  ) {
    return (inputs: readonly string[]): TerminalComposerContentResult => inputs.length === 0
      ? TakeReadings.reading({ kind: 'text', text, eraseBound })
      : after
  }
}

describe('lib-orchestrator/remoteControl/remoteControlTerminal take', () => {
  it.each((['disconnect', 'timeout'] as const).flatMap(stop =>
    (['sent', 'not-writer'] as const).map(ack => ({ stop, ack }))))
  ('reports the settled erase acknowledgement $ack after $stop without another composer read', async ({ stop, ack }) => {
    vi.useFakeTimers()
    const harness = new TakeHarness(100)
    harness.sessions.content = () => TakeReadings.reading({ kind: 'text', text: 'draft', eraseBound: 14 })
    let acknowledge!: () => void
    vi.spyOn(harness.sessions, 'transaction').mockResolvedValue({
      write: async () => { await new Promise<void>(resolve => { acknowledge = resolve }); return { kind: ack } },
      end: () => {},
    })
    const taking = harness.take()
    const owner = harness.sessions.attachments.get(TakeHarness.attachIdConst)!.owner
    await vi.advanceTimersByTimeAsync(0)
    expect(acknowledge).toBeDefined()
    let completed = false
    void taking.then(() => { completed = true })
    if (stop === 'disconnect') owner.onFrame({ type: 'terminal.status', status: 'connecting', detail: 'disconnected' })
    else if (stop === 'timeout') await vi.advanceTimersByTimeAsync(100)
    else throw new Error(`Unknown stop: ${stop satisfies never}`)
    await vi.advanceTimersByTimeAsync(0)
    expect(completed).toBe(false)
    acknowledge()
    expect(await taking).toMatchObject({ kind: 'partial', reason: ack === 'sent' ? 'text-remains' : 'not-erased' })
    expect(harness.sessions.contentReads).toBe(1)
    expect(harness.sessions.attachments.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  afterEach(() => vi.useRealTimers())

  it('stores the prompt before the first DEL and writes nothing when the store refuses', async () => {
    const harness = new TakeHarness()
    harness.sessions.content = TakeReadings.erasing('draft', 14)

    const refused = await harness.take(() => ({ ok: false, detail: 'section damaged' }))

    expect(refused).toEqual({ kind: 'refused', reason: 'keep-refused', detail: 'section damaged' })
    expect(harness.written()).toEqual([])

    const order: string[] = []
    const taken = await harness.take((text) => {
      order.push(`keep:${text}:${harness.written().length}`)
      return { ok: true }
    })

    expect(taken).toEqual({ kind: 'taken' })
    expect(order).toEqual(['keep:draft:0'])
    expect(harness.written()).toEqual(['\x7f'.repeat(14)])
    expect(harness.sessions.detached).toEqual([TakeHarness.attachIdConst, TakeHarness.attachIdConst])
    expect(harness.sessions.attachments.size).toBe(0)
  })

  it('attaches without a size, so the import never moves the terminal geometry', async () => {
    const harness = new TakeHarness()
    harness.sessions.content = () => TakeReadings.reading({ kind: 'empty' })
    const taking = harness.terminal.take('session-1', () => ({ ok: true }))

    expect(harness.sessions.attachments.get(TakeHarness.attachIdConst)?.spec).toEqual({ sessionId: 'session-1', size: null })
    harness.sessions.emit(TakeHarness.attachIdConst, TerminalFrames.attached(true))
    expect(await taking).toEqual({ kind: 'empty' })
    expect(harness.sessions.resizes).toEqual([])
    expect(harness.sessions.active).toEqual([])
  })

  it.each([
    { content: { kind: 'empty' }, result: { kind: 'empty' } },
    { content: { kind: 'absent' }, result: { kind: 'refused', reason: 'no-prompt' } },
    { content: { kind: 'clipped' }, result: { kind: 'refused', reason: 'too-tall' } },
    { content: { kind: 'placeholder' }, result: { kind: 'refused', reason: 'placeholder' } },
  ] satisfies { content: TerminalComposerContent; result: object }[])('keeps and writes nothing over $content.kind', async ({ content, result }) => {
    const harness = new TakeHarness()
    harness.sessions.content = () => TakeReadings.reading(content)
    const keep = vi.fn(() => ({ ok: true as const }))

    expect(await harness.take(keep)).toMatchObject(result)
    expect(keep).not.toHaveBeenCalled()
    expect(harness.written()).toEqual([])
    expect(harness.sessions.detached).toEqual([TakeHarness.attachIdConst])
  })

  it.each([
    { name: 'a dialog', overrides: { hint: 'blocked' }, reason: 'dialog' },
    { name: 'a waiting prompt', overrides: { hint: 'waiting' }, reason: 'dialog' },
    { name: 'a dead runtime', overrides: { alive: false }, reason: 'not-live' },
  ] satisfies { name: string; overrides: Partial<TerminalComposerContentReading>; reason: string }[])(
    'refuses $name before keeping anything',
    async ({ overrides, reason }) => {
      const harness = new TakeHarness()
      harness.sessions.content = () => TakeReadings.reading({ kind: 'text', text: 'draft', eraseBound: 14 }, overrides)
      const keep = vi.fn(() => ({ ok: true as const }))

      expect(await harness.take(keep)).toMatchObject({ kind: 'refused', reason })
      expect(keep).not.toHaveBeenCalled()
      expect(harness.written()).toEqual([])
    },
  )

  it.each([
    { code: 'unknown-session', reason: 'unknown-session' },
    { code: 'not-live', reason: 'not-live' },
    { code: 'not-agent', reason: 'not-agent' },
    { code: 'no-projection', reason: 'unavailable' },
    { code: 'no-viewport', reason: 'unreadable' },
  ] as const)('maps the read refusal $code to $reason', async ({ code, reason }) => {
    const harness = new TakeHarness()
    harness.sessions.content = () => ({ ok: false, code })

    expect(await harness.take()).toMatchObject({ kind: 'refused', reason })
    expect(harness.written()).toEqual([])
  })

  it('refuses a read-only attach without reading the prompt', async () => {
    const harness = new TakeHarness()
    harness.sessions.content = TakeReadings.erasing('draft', 14)
    const keep = vi.fn(() => ({ ok: true as const }))

    expect(await harness.take(keep, false)).toEqual({
      kind: 'refused',
      reason: 'read-only',
      detail: 'The terminal attach is read-only',
    })
    expect(harness.sessions.contentReads).toBe(0)
    expect(keep).not.toHaveBeenCalled()
    expect(harness.written()).toEqual([])
  })

  it('shares one guard with deliver: a take or a deliver during a take, and a take during a deliver, are in flight', async () => {
    const harness = new TakeHarness()
    harness.sessions.content = TakeReadings.erasing('draft', 14)
    const first = harness.take()
    expect(harness.sessions.pending.get('session-1')).toBe(true)

    expect(await harness.terminal.take('session-1', () => ({ ok: true }))).toEqual({
      kind: 'refused',
      reason: 'in-flight',
      detail: 'Another delivery to this session is still running',
    })
    expect(await harness.terminal.deliver('session-1', 'other', {
      input: 'paste',
      readyTimeoutMs: 1_000,
      submitTimeoutMs: 1_000,
    }, { transcript: async () => DeliverReadings.transcript(0) })).toMatchObject({
      ok: false,
      error: { code: 'conflict', data: { reason: 'in-flight' } },
    })
    expect(await first).toEqual({ kind: 'taken' })
    expect(harness.sessions.pending.get('session-1')).toBe(false)
    expect(harness.written()).toEqual(['\x7f'.repeat(14)])

    const delivering = new DeliverHarness()
    delivering.sessions.composer = DeliverReadings.echoing('hello')
    delivering.transcript = DeliverReadings.submitted('hello')
    const delivery = delivering.deliver('hello')
    expect(delivering.sessions.pending.get('session-1')).toBe(true)
    const keep = vi.fn(() => ({ ok: true as const }))
    expect(await delivering.terminal.take('session-1', keep)).toMatchObject({ kind: 'refused', reason: 'in-flight' })
    expect(await delivery).toMatchObject({ ok: true })
    expect(delivering.sessions.pending.get('session-1')).toBe(false)
    expect(keep).not.toHaveBeenCalled()
    expect(delivering.sessions.contentReads).toBe(0)
  })

  it('keeps a queued one-shot send attached until the real take transaction emits it', async () => {
    vi.useFakeTimers()
    const sessions = new FakeTerminalSessions()
    const written: string[] = []
    const errors: string[] = []
    const gateway = new TerminalGateway({
      descriptorOf: () => ({ hostInstanceId: 'host' }) as HostDescriptor,
      leaseIdOf: () => 'lease', onError: message => errors.push(message),
      activity: { userInput: () => {}, pendingInputHint: () => {} },
      socketFactory: deps => ({ connect: () => {}, close: () => {}, send: frame => {
        if (frame.type === 'terminal.attach') deps.onFrame(TerminalFrames.attached(true))
        else if (frame.type === 'terminal.input') written.push(frame.data)
      } }),
    })
    await gateway.publishRefs([{ sessionId: 'session-1', resolution: { ok: true, alive: true,
      ref: { hostInstanceId: 'host', runtimeSessionId: 'runtime-1', generation: 1 } } }])
    sessions.content = () => TakeReadings.erasing('draft', 14)(written)
    const terminal = new RemoteControlTerminal(sessions, gateway, { onError: message => errors.push(message), pause: async () => {} })
    let kept!: () => void
    const keeping = new Promise<void>(resolve => { kept = resolve })
    const taking = terminal.take('session-1', async () => { await keeping; return { ok: true } })
    await vi.advanceTimersByTimeAsync(0)
    let settled = false
    const sending = terminal.send('session-1', 'queued text', { enter: false }).then(result => { settled = true; return result })
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(sessions.contentReads).toBe(1)
      expect(await gateway.pendingInput('session-1')).toBe(1)
      expect(written).toEqual([])
      expect(settled).toBe(false)
      expect(gateway.attachmentCount()).toBe(2)
      kept()
      expect(await taking).toEqual({ kind: 'taken' })
      expect(await sending).toEqual({ ok: true, value: { sessionId: 'session-1', accepted: true, characterCount: 11, enter: false } })
      expect(written).toEqual(['\x7f'.repeat(14), 'queued text'])
      expect(await gateway.pendingInput('session-1')).toBe(0)
      expect(gateway.attachmentCount()).toBe(0)
      expect(errors).toEqual([])
    } finally {
      kept()
      await taking
      await sending
      gateway.closeAll()
    }
  })

  it('takes through a real gateway only after inhibit release and excludes other input until end', async () => {
    const harness = new TakeHarness()
    const sent: HostWsClientMsg[] = []
    let socket!: TerminalAttachSocketDeps
    const gateway = new TerminalGateway({
      descriptorOf: () => ({ hostInstanceId: 'host' }) as HostDescriptor,
      leaseIdOf: () => 'lease',
      activity: { userInput: () => {}, pendingInputHint: () => {} },
      onError: message => { throw new Error(message) },
      socketFactory: deps => { socket = deps; return { connect: () => {}, send: frame => { sent.push(frame) }, close: () => {} } },
    })
    await gateway.publishRefs([{ sessionId: 'session-1', resolution: { ok: true, alive: true, ref: { hostInstanceId: 'host', runtimeSessionId: 'runtime-1', generation: 1 } } }])
    harness.sessions.attach = gateway.attach.bind(gateway)
    harness.sessions.detach = gateway.detach.bind(gateway)
    harness.sessions.transaction = gateway.transaction.bind(gateway)
    harness.sessions.content = () => sent.some(frame => frame.type === 'terminal.input' && frame.data.includes('\x7f'))
      ? TakeReadings.reading({ kind: 'empty' }) : TakeReadings.reading({ kind: 'text', text: 'draft', eraseBound: 14 })
    const held = await gateway.inhibit('session-1')
    let queued!: Promise<TerminalInputResult>
    const taking = harness.terminal.take('session-1', async () => {
      queued = gateway.input(TakeHarness.attachIdConst, 'later input')
      expect(sent.filter(frame => frame.type === 'terminal.input')).toEqual([])
      return { ok: true }
    })
    socket.onFrame({ type: 'terminal.attached', writer: true, session: {
      runtimeSessionId: 'runtime-1', generation: 1, alive: true, cols: 80, rows: 24,
      outputSeq: 0, outputEpoch: 1, startedAt: 0, lastOutputAt: null,
    } })
    await Promise.resolve()
    expect(harness.sessions.contentReads).toBe(0)
    held.release()
    expect(await taking).toEqual({ kind: 'taken' })
    expect(await queued).toEqual({ kind: 'sent' })
    expect(sent.filter(frame => frame.type === 'terminal.input')).toEqual([
      { type: 'terminal.input', data: '\x7f'.repeat(14) }, { type: 'terminal.input', data: 'later input' },
    ])
    gateway.closeAll()
  })

  it('releases a transaction acquired after timeout without reading, keeping or writing', async () => {
    vi.useFakeTimers()
    const harness = new TakeHarness(1_000)
    let grant!: (value: Awaited<ReturnType<FakeTerminalSessions['transaction']>>) => void
    vi.spyOn(harness.sessions, 'transaction').mockImplementation(() => new Promise(resolve => { grant = resolve }))
    const end = vi.fn(), write = vi.fn(async () => ({ kind: 'sent' as const })), keep = vi.fn(() => ({ ok: true as const }))
    const taking = harness.take(keep)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await taking).toMatchObject({ kind: 'refused', reason: 'unavailable' })
    grant({ write, end })
    await vi.advanceTimersByTimeAsync(0)
    expect(end).toHaveBeenCalledTimes(1)
    expect(write).not.toHaveBeenCalled()
    expect(keep).not.toHaveBeenCalled()
    expect(harness.sessions.contentReads).toBe(0)
  })

  it('waits for an asynchronous keep to settle after disconnect and reports its saved text', async () => {
    const harness = new TakeHarness()
    harness.sessions.content = TakeReadings.erasing('draft', 14)
    let kept!: (value: { ok: true }) => void
    const taking = harness.take(() => new Promise(resolve => { kept = resolve }))
    await vi.waitFor(() => expect(kept).toBeDefined())
    harness.sessions.emit(TakeHarness.attachIdConst, { type: 'terminal.status', status: 'connecting', detail: null })
    kept({ ok: true })
    expect(await taking).toMatchObject({ kind: 'partial', reason: 'not-erased' })
    expect(harness.written()).toEqual([])
  })

  it('reports a disconnected transaction write as partial after the keep', async () => {
    const harness = new TakeHarness()
    harness.sessions.content = TakeReadings.erasing('draft', 14)
    const end = vi.fn()
    vi.spyOn(harness.sessions, 'transaction').mockResolvedValue({
      write: async () => ({ refused: 'disconnected' }), end,
    })
    expect(await harness.take()).toEqual({ kind: 'partial', reason: 'not-erased', detail: 'The terminal attach disconnected' })
    expect(harness.written()).toEqual([])
    expect(end).toHaveBeenCalled()
  })

  it.each([
    ['busy', 'in-flight'], ['not-writer', 'read-only'],
  ] as const)('refuses a %s edit transaction before reading or keeping', async (refused, reason) => {
    const harness = new TakeHarness()
    const keep = vi.fn(() => ({ ok: true as const }))
    vi.spyOn(harness.sessions, 'transaction').mockResolvedValue({ refused })
    expect(await harness.take(keep)).toMatchObject({ kind: 'refused', reason })
    expect(keep).not.toHaveBeenCalled()
    expect(harness.sessions.contentReads).toBe(0)
    expect(harness.written()).toEqual([])
  })

  it('answers partial not-erased when the DEL write fails after the keep', async () => {
    const harness = new TakeHarness()
    harness.sessions.content = TakeReadings.erasing('draft', 14)
    harness.sessions.inputAnswer = { kind: 'unknown-attach' }
    const keep = vi.fn(() => ({ ok: true as const }))

    expect(await harness.take(keep)).toEqual({
      kind: 'partial',
      reason: 'not-erased',
      detail: 'The terminal attach disappeared',
    })
    expect(keep).toHaveBeenCalledTimes(1)
  })

  it.each([
    TerminalFrames.attached(true),
    { type: 'terminal.status', status: 'connecting', detail: null },
    { type: 'terminal.status', status: 'lost', code: 'not-live', detail: 'gone' },
    { type: 'terminal.exit', runtimeSessionId: 'runtime-1', generation: 1, exitCode: 0 },
  ] satisfies TerminalFrame[])('answers partial not-erased and writes nothing when $type $status lands during the keep', async (frame) => {
    const harness = new TakeHarness()
    harness.sessions.content = TakeReadings.erasing('draft', 14)

    const result = await harness.take(() => {
      harness.sessions.emit(TakeHarness.attachIdConst, frame)
      return { ok: true }
    })

    expect(result).toMatchObject({ kind: 'partial', reason: 'not-erased' })
    expect(harness.written()).toEqual([])
    expect(harness.sessions.detached).toEqual([TakeHarness.attachIdConst])
  })

  it('answers refused when the terminal drops during a keep that then refuses', async () => {
    const harness = new TakeHarness()
    harness.sessions.content = TakeReadings.erasing('draft', 14)

    const result = await harness.take(() => {
      harness.sessions.emit(TakeHarness.attachIdConst, { type: 'terminal.status', status: 'connecting', detail: null })
      return { ok: false, detail: 'section damaged' }
    })

    expect(result).toEqual({ kind: 'refused', reason: 'unavailable', detail: 'The terminal disconnected during the import' })
    expect(harness.written()).toEqual([])
  })

  it('answers partial text-remains when the prompt still shows text after the settle limit', async () => {
    const harness = new TakeHarness()
    harness.sessions.content = TakeReadings.erasing(
      'draft', 14, TakeReadings.reading({ kind: 'text', text: 'tail', eraseBound: 12 }))

    expect(await harness.take()).toEqual({
      kind: 'partial',
      reason: 'text-remains',
      detail: 'Text is still in the prompt; the note holds all of it',
    })
    expect(harness.clock).toBeGreaterThanOrEqual(1_500)
    expect(harness.sessions.contentReads).toBeLessThanOrEqual(9)
    expect(harness.written()).toEqual(['\x7f'.repeat(14)])
    expect(harness.sessions.detached).toEqual([TakeHarness.attachIdConst])
  })

  it('waits through readings that are not empty yet and answers taken once the prompt clears', async () => {
    const harness = new TakeHarness()
    harness.sessions.content = (inputs) => {
      if (inputs.length === 0) return TakeReadings.reading({ kind: 'text', text: 'draft', eraseBound: 14 })
      if (harness.sessions.contentReads < 4) return { ok: false, code: 'no-projection' }
      return TakeReadings.reading({ kind: 'empty' })
    }

    expect(await harness.take()).toEqual({ kind: 'taken' })
    expect(harness.clock).toBe(600)
    expect(harness.written()).toEqual(['\x7f'.repeat(14)])
  })

  it('answers refused unavailable when the read times out before the keep', async () => {
    vi.useFakeTimers()
    const harness = new TakeHarness(1_000)
    harness.sessions.content = () => new Promise<TerminalComposerContentResult>(() => {})
    const keep = vi.fn(() => ({ ok: true as const }))
    const taking = harness.take(keep)

    await vi.advanceTimersByTimeAsync(1_000)

    expect(await taking).toEqual({
      kind: 'refused',
      reason: 'unavailable',
      detail: 'The terminal take operation timed out',
    })
    expect(keep).not.toHaveBeenCalled()
    expect(harness.written()).toEqual([])
    expect(harness.sessions.detached).toEqual([TakeHarness.attachIdConst])
  })

  it('answers partial when the operation times out after the keep', async () => {
    vi.useFakeTimers()
    const harness = new TakeHarness(1_000)
    harness.sessions.content = (inputs) => inputs.length === 0
      ? TakeReadings.reading({ kind: 'text', text: 'draft', eraseBound: 14 })
      : new Promise<TerminalComposerContentResult>(() => {})
    const taking = harness.take()

    await vi.advanceTimersByTimeAsync(1_000)

    expect(await taking).toMatchObject({ kind: 'partial', reason: 'text-remains' })
    expect(harness.written()).toEqual(['\x7f'.repeat(14)])
  })

  it('answers partial when a reading throws after the erase, and refused when one throws before the keep', async () => {
    const after = new TakeHarness()
    after.sessions.content = (inputs) => {
      if (inputs.length === 0) return TakeReadings.reading({ kind: 'text', text: 'draft', eraseBound: 14 })
      throw new Error('inspect failed')
    }
    const before = new TakeHarness()
    before.sessions.content = () => { throw new Error('inspect failed') }

    expect(await after.take()).toMatchObject({ kind: 'partial', reason: 'text-remains' })
    expect(after.errors).toEqual(['Remote terminal take failed: inspect failed'])
    expect(await before.take()).toEqual({
      kind: 'refused',
      reason: 'failed',
      detail: 'The terminal import operation failed',
    })
    expect(before.written()).toEqual([])
  })
})
