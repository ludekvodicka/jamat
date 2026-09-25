import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  TerminalAttachResult,
  TerminalAttachSpec,
  TerminalComposerReading,
  TerminalComposerResult,
  TerminalFrame,
} from '../sessionManager/sessionManagerApi.types'
import type { SessionTranscriptReading } from '../sessionTranscriptReader/sessionTranscriptReaderApi.types'
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
  /** What the composer shows, as a function of everything written so far. */
  composer: (inputs: readonly string[]) => TerminalComposerResult = () => ({ ok: false, code: 'not-agent' })
  composerReads = 0

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

  async terminalComposer(_sessionId: string): Promise<TerminalComposerResult> {
    this.composerReads += 1
    return this.composer(this.inputs.map((input) => input.data))
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
    vi.spyOn(harness.sessions, 'terminalInput').mockImplementation(() => { throw new Error('socket failed') })
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

class DeliverHarness {
  readonly sessions = new FakeTerminalSessions()
  readonly errors: string[] = []
  readonly terminal: RemoteControlTerminal
  transcript: (inputs: readonly string[]) => SessionTranscriptReading = () => DeliverReadings.transcript(0)
  clock = 0

  constructor() {
    this.terminal = new RemoteControlTerminal(this.sessions, {
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
