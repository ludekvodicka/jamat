import { randomUUID } from 'node:crypto'

import type {
  TerminalAttachResult,
  TerminalAttachSpec,
  TerminalComposerReading,
  TerminalComposerResult,
  TerminalFrame,
} from '../sessionManager/sessionManagerApi.types'
import type { AgentWorkHint } from '../sessionManager/workState/agentWorkInspector.types'
import type { SessionTranscriptReading } from '../sessionTranscriptReader/sessionTranscriptReaderApi.types'
import type {
  TerminalAttachOwner,
  TerminalInputResult,
  TerminalResizeResult,
} from '../sessionManager/terminals/terminalGateway'
import { ErrorText } from '../shared/errorText'
import type {
  RemoteControlTerminalDeliverOptions,
  RemoteControlTerminalDeliverProofPort,
  RemoteControlTerminalPort,
} from './remoteControl'
import type {
  RemoteControlError,
  RemoteControlStepResult,
  RemoteControlTerminalDeliverComposeProof,
  RemoteControlTerminalDeliverDto,
  RemoteControlTerminalDeliverFailureData,
  RemoteControlTerminalDeliverProof,
  RemoteControlTerminalDeliverSubmitKey,
  RemoteControlTerminalPeekDto,
  RemoteControlTerminalSendDto,
} from './remoteControlApi.types'
import { RemoteControlDeliverConst } from './remoteControlProtocol'

export interface RemoteControlTerminalSessionPort {
  terminalAttach(
    attachId: string,
    spec: TerminalAttachSpec,
    owner: TerminalAttachOwner,
  ): TerminalAttachResult
  terminalInput(attachId: string, data: string): TerminalInputResult
  terminalResize(attachId: string, cols: number, rows: number): TerminalResizeResult
  terminalSetGeometryActive(attachId: string, active: boolean): TerminalResizeResult
  terminalDetach(attachId: string): void
  terminalDetachAll(attachIds: readonly string[]): void
  terminalComposer(sessionId: string): Promise<TerminalComposerResult>
}

export interface RemoteControlTerminalDeps {
  internalAttachId?(): string
  onError(message: string): void
  timeoutMilliseconds?: number
  screenCharacterLimit?: number
  pause?(milliseconds: number): Promise<void>
  now?(): number
}

export interface RemoteControlLiveTerminalAttachDto {
  attachId: string
  sessionId: string
}

export interface RemoteControlLiveTerminalInputDto {
  attachId: string
  accepted: true
  characterCount: number
}

export interface RemoteControlLiveTerminalResizeDto {
  attachId: string
  accepted: true
  applied: boolean
}

interface LiveTerminalAttachment {
  internalAttachId: string
  sessionId: string
}

interface UserTurns {
  count: number
  latest: number
}

/** Everything one delivery has learned so far; failure `data` is read off it. */
interface DeliverState {
  done: boolean
  attached: boolean
  started: boolean
  typed: boolean
  entered: 0 | 1 | 2
  startedAt: number
  last: TerminalComposerReading | null
}

/** The screen facts taken at ready time, before anything is written. */
interface DeliverBaseline {
  hint: AgentWorkHint
  queuedRow: boolean
  echoHead: string | null
  pastePlaceholders: number
  turns: UserTurns | null
  submitKey: RemoteControlTerminalDeliverSubmitKey
}

type DeliverFinish = (result: RemoteControlStepResult<RemoteControlTerminalDeliverDto>) => void

export class RemoteControlTerminal implements RemoteControlTerminalPort {
  private static readonly timeoutMillisecondsConst = 5_000
  private static readonly screenCharacterLimitConst = 32_768
  // Match the renderer's synthetic-submit pause: Enter inside the text burst is pasted by Codex.
  private static readonly enterDelayMillisecondsConst = 100

  private static readonly readyPollMillisecondsConst = 250
  private static readonly composePollMillisecondsConst = 200
  private static readonly transcriptPollMillisecondsConst = 1_000
  private static readonly secondEnterAtMillisecondsConst = 2_000
  private static readonly backstopMillisecondsConst = 1_000
  private static readonly headCharactersConst = 48
  private static readonly tailCharactersConst = 24
  private static readonly transcriptHeadCharactersConst = 40
  private static readonly busyHintsConst: readonly AgentWorkHint[] = ['working', 'tool-use', 'compacting', 'background']
  private static readonly submitKeysConst: Record<RemoteControlTerminalDeliverSubmitKey, string> = {
    enter: '\r',
    tab: '\t',
  }
  private static readonly pasteStartConst = '\x1b[200~'
  private static readonly pasteEndConst = '\x1b[201~'

  private readonly internalAttachId: () => string
  private readonly timeoutMilliseconds: number
  private readonly screenCharacterLimit: number
  private readonly pause: (milliseconds: number) => Promise<void>
  private readonly now: () => number
  private readonly liveByOwner = new Map<string, Map<string, LiveTerminalAttachment>>()
  /** Two deliveries to one session could both take one merged message as their proof. */
  private readonly delivering = new Set<string>()

  constructor(
    private readonly sessions: RemoteControlTerminalSessionPort,
    private readonly deps: RemoteControlTerminalDeps,
  ) {
    this.internalAttachId = deps.internalAttachId ?? randomUUID
    this.timeoutMilliseconds = deps.timeoutMilliseconds
      ?? RemoteControlTerminal.timeoutMillisecondsConst
    this.screenCharacterLimit = deps.screenCharacterLimit
      ?? RemoteControlTerminal.screenCharacterLimitConst
    this.pause = deps.pause
      ?? ((milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds) }))
    this.now = deps.now ?? Date.now
  }

  peek(
    sessionId: string,
    options: { cols?: number; rows?: number; timeoutMs?: number },
  ): Promise<RemoteControlStepResult<RemoteControlTerminalPeekDto>> {
    const size = options.cols === undefined || options.rows === undefined
      ? null
      : { cols: options.cols, rows: options.rows }
    return this.once(
      'peek',
      sessionId,
      size,
      options.timeoutMs,
      (_attachId, frame, finish) => {
        if (frame.type === 'terminal.snapshot') {
          const screen = frame.projection.screen.length <= this.screenCharacterLimit
            ? frame.projection.screen
            : frame.projection.screen.slice(-this.screenCharacterLimit)
          finish(RemoteControlTerminal.success({
            sessionId,
            snapshot: {
              type: 'terminal.snapshot',
              projection: {
                runtimeSessionId: frame.projection.runtimeSessionId,
                generation: frame.projection.generation,
                outputEpoch: frame.projection.outputEpoch,
                outputSeq: frame.projection.outputSeq,
                screen,
                screenTruncated: screen.length !== frame.projection.screen.length,
                cols: frame.projection.cols,
                rows: frame.projection.rows,
                alive: frame.projection.alive,
                lastOutputAt: frame.projection.lastOutputAt,
              },
            },
            terminalOutputUntrusted: true,
          }))
        } else if (frame.type === 'terminal.status') {
          if (frame.status === 'connecting' || frame.status === 'read-only')
            return
          else if (frame.status === 'lost')
            finish(RemoteControlTerminal.statusError(frame))
          else
            throw new Error(`Unknown terminal status: ${JSON.stringify(frame)}`)
        } else if (frame.type === 'terminal.attached'
          || frame.type === 'terminal.data'
          || frame.type === 'terminal.delta'
          || frame.type === 'terminal.resize')
          return
        else if (frame.type === 'terminal.exit')
          finish(RemoteControlTerminal.error(
            'operation-failed',
            'The terminal exited before its screen was available',
          ))
        else
          throw new Error(`Unknown terminal frame: ${JSON.stringify(frame)}`)
      },
    )
  }

  send(
    sessionId: string,
    text: string,
    options: { enter: boolean; timeoutMs?: number },
  ): Promise<RemoteControlStepResult<RemoteControlTerminalSendDto>> {
    let enterTimer: ReturnType<typeof setTimeout> | null = null
    let textSent = false
    return this.once(
      'send',
      sessionId,
      null,
      options.timeoutMs,
      (attachId, frame, finish) => {
        if (frame.type === 'terminal.attached') {
          if (!frame.writer) {
            finish(RemoteControlTerminal.error(
              'conflict',
              'The terminal attach is read-only',
            ))
            return
          }
          // A reconnect must never replay the text or submit a draft in a replacement runtime.
          if (textSent) {
            finish(RemoteControlTerminal.error('unavailable', 'The terminal reattached before Enter'))
            return
          }
          const complete = (): void => finish(RemoteControlTerminal.success({
            sessionId,
            accepted: true,
            characterCount: text.length,
            enter: options.enter,
          }))
          const written = this.writeInput(attachId, text)
          if (!written.ok) {
            finish(written)
            return
          }
          textSent = true
          if (!options.enter) {
            complete()
            return
          }
          enterTimer = setTimeout(() => {
            const entered = this.writeInput(attachId, '\r')
            if (entered.ok) complete()
            else finish(entered)
          }, RemoteControlTerminal.enterDelayMillisecondsConst)
        } else if (frame.type === 'terminal.status') {
          if (frame.status === 'connecting') {
            if (textSent)
              finish(RemoteControlTerminal.error('unavailable', 'The terminal disconnected before Enter'))
            return
          } else if (frame.status === 'read-only')
            finish(RemoteControlTerminal.error('conflict', 'The terminal attach is read-only'))
          else if (frame.status === 'lost')
            finish(RemoteControlTerminal.statusError(frame))
          else
            throw new Error(`Unknown terminal status: ${JSON.stringify(frame)}`)
        } else if (frame.type === 'terminal.snapshot'
          || frame.type === 'terminal.data'
          || frame.type === 'terminal.delta'
          || frame.type === 'terminal.resize')
          return
        else if (frame.type === 'terminal.exit')
          finish(RemoteControlTerminal.error('operation-failed', 'The terminal has exited'))
        else
          throw new Error(`Unknown terminal frame: ${JSON.stringify(frame)}`)
      },
      () => { if (enterTimer !== null) clearTimeout(enterTimer) },
    )
  }

  /**
   * One attach for the whole delivery: wait until the composer is empty, write the text, see it in
   * the composer, press Enter, and prove the submit. Nothing is written over a dialog or a draft
   * this call does not own, and the one automatic second Enter goes only over our own draft.
   */
  async deliver(
    sessionId: string,
    text: string,
    options: RemoteControlTerminalDeliverOptions,
    proof: RemoteControlTerminalDeliverProofPort,
  ): Promise<RemoteControlStepResult<RemoteControlTerminalDeliverDto>> {
    if (this.delivering.has(sessionId))
      return {
        ok: false,
        error: {
          code: 'conflict',
          detail: 'Another delivery to this session is still running',
          data: { stage: 'ready', reason: 'in-flight', typed: false, entered: 0, hint: null, composer: null },
        },
      }
    this.delivering.add(sessionId)
    try {
      return await this.deliverOnce(sessionId, text, options, proof)
    } finally {
      this.delivering.delete(sessionId)
    }
  }

  private async deliverOnce(
    sessionId: string,
    text: string,
    options: RemoteControlTerminalDeliverOptions,
    proof: RemoteControlTerminalDeliverProofPort,
  ): Promise<RemoteControlStepResult<RemoteControlTerminalDeliverDto>> {
    const state: DeliverState = {
      done: false,
      attached: false,
      started: false,
      typed: false,
      entered: 0,
      startedAt: this.now(),
      last: null,
    }
    const backstop = options.readyTimeoutMs + RemoteControlDeliverConst.composeTimeoutMillisecondsConst
      + options.submitTimeoutMs + RemoteControlTerminal.backstopMillisecondsConst
    const result = await this.once<RemoteControlTerminalDeliverDto>(
      'deliver',
      sessionId,
      null,
      backstop,
      (attachId, frame, finish) => {
        if (frame.type === 'terminal.attached') {
          state.attached = true
          if (!frame.writer)
            finish(RemoteControlTerminal.deliverError('conflict', 'The terminal attach is read-only', state, 'read-only'))
          else if (state.typed)
            finish(RemoteControlTerminal.deliverError('unavailable', 'The terminal reattached during delivery', state, 'reattached'))
          else if (!state.started) {
            state.started = true
            void this.deliverPhases(attachId, sessionId, text, options, proof, state, finish)
          }
        } else if (frame.type === 'terminal.status') {
          if (frame.status === 'connecting') {
            if (state.typed)
              finish(RemoteControlTerminal.deliverError('unavailable', 'The terminal disconnected during delivery', state, 'disconnected'))
          } else if (frame.status === 'read-only')
            finish(RemoteControlTerminal.deliverError('conflict', 'The terminal attach is read-only', state, 'read-only'))
          else if (frame.status === 'lost')
            finish(RemoteControlTerminal.statusError(frame))
          else
            throw new Error(`Unknown terminal status: ${JSON.stringify(frame)}`)
        } else if (frame.type === 'terminal.exit')
          finish(RemoteControlTerminal.deliverError('unavailable', 'The terminal exited during delivery', state, 'exited'))
        else if (frame.type === 'terminal.snapshot'
          || frame.type === 'terminal.data'
          || frame.type === 'terminal.delta'
          || frame.type === 'terminal.resize')
          return
        else
          throw new Error(`Unknown terminal frame: ${JSON.stringify(frame)}`)
      },
      () => { state.done = true },
    )
    if (result.ok || result.error.data !== undefined) return result
    return RemoteControlTerminal.deliverError(
      result.error.code,
      result.error.detail,
      state,
      RemoteControlTerminal.reasonOf(result.error.code, state),
    )
  }

  private async deliverPhases(
    attachId: string,
    sessionId: string,
    text: string,
    options: RemoteControlTerminalDeliverOptions,
    proof: RemoteControlTerminalDeliverProofPort,
    state: DeliverState,
    finish: DeliverFinish,
  ): Promise<void> {
    try {
      await this.deliverSteps(attachId, sessionId, text, options, proof, state, finish)
    } catch (error) {
      this.deps.onError(`Remote terminal deliver failed: ${ErrorText.of(error)}`)
      finish(RemoteControlTerminal.deliverError('operation-failed', 'The terminal deliver operation failed', state, 'failed'))
    }
  }

  private async deliverSteps(
    attachId: string,
    sessionId: string,
    text: string,
    options: RemoteControlTerminalDeliverOptions,
    proof: RemoteControlTerminalDeliverProofPort,
    state: DeliverState,
    finish: DeliverFinish,
  ): Promise<void> {
    const ready = await this.awaitReady(sessionId, options, state, finish)
    if (ready === null) return
    const turns = RemoteControlTerminal.userTurnsOf(await proof.transcript())
    if (state.done) return
    const baseline: DeliverBaseline = {
      hint: ready.hint,
      queuedRow: ready.queuedRow,
      echoHead: ready.echoHead,
      pastePlaceholders: ready.pastePlaceholders,
      turns,
      submitKey: RemoteControlTerminal.submitKeyOf(options, ready),
    }
    const readyAt = this.now()
    const payload = options.input === 'paste'
      ? `${RemoteControlTerminal.pasteStartConst}${text}${RemoteControlTerminal.pasteEndConst}`
      : text
    const written = this.writeInput(attachId, payload)
    if (!written.ok) {
      finish(RemoteControlTerminal.deliverError(written.error.code, written.error.detail, state, RemoteControlTerminal.reasonOf(written.error.code, state)))
      return
    }
    state.typed = true
    const composeProof = await this.awaitComposed(sessionId, text, options, baseline, readyAt, state, finish)
    if (composeProof === null) return
    const entered = this.writeInput(attachId, RemoteControlTerminal.submitKeysConst[baseline.submitKey])
    if (!entered.ok) {
      finish(RemoteControlTerminal.deliverError(entered.error.code, entered.error.detail, state, RemoteControlTerminal.reasonOf(entered.error.code, state)))
      return
    }
    state.entered = 1
    const submittedProof = await this.awaitSubmitted(attachId, sessionId, text, options, proof, baseline, state, finish)
    if (submittedProof === null) return
    finish(RemoteControlTerminal.success({
      sessionId,
      accepted: true,
      characterCount: text.length,
      delivered: true,
      input: options.input,
      composeProof,
      proof: submittedProof,
      submitKey: baseline.submitKey,
      readyAfterMs: readyAt - state.startedAt,
      submittedAfterMs: this.now() - readyAt,
    }))
  }

  /** Polls until the composer is empty; null once `finish` has been called or the call ended. */
  private async awaitReady(
    sessionId: string,
    options: RemoteControlTerminalDeliverOptions,
    state: DeliverState,
    finish: DeliverFinish,
  ): Promise<TerminalComposerReading | null> {
    for (;;) {
      const read = await this.sessions.terminalComposer(sessionId)
      if (state.done) return null
      if (read.ok) {
        state.last = read.reading
        const reading = read.reading
        if (!reading.alive) {
          finish(RemoteControlTerminal.deliverError('not-found', 'The session is not alive', state, 'not-live'))
          return null
        }
        if (reading.hint === 'blocked' || reading.hint === 'waiting') {
          finish(RemoteControlTerminal.deliverError('conflict', 'The agent is showing a dialog', state, 'dialog'))
          return null
        }
        if (reading.composer.state === 'text') {
          finish(RemoteControlTerminal.deliverError('conflict', 'The composer holds a draft this call does not own', state, 'foreign-draft'))
          return null
        }
        if (reading.composer.state === 'empty') return reading
        if (reading.composer.state !== 'absent')
          throw new Error(`Unknown composer state: ${JSON.stringify(reading.composer)}`)
      } else if (read.code === 'unknown-session' || read.code === 'not-live') {
        finish(RemoteControlTerminal.deliverError('not-found', 'The session is not live', state, 'not-live'))
        return null
      } else if (read.code === 'not-agent') {
        finish(RemoteControlTerminal.deliverError('invalid-request', 'terminal.deliver needs an agent session', state, 'shell-session'))
        return null
      } else if (read.code !== 'no-projection')
        throw new Error(`Unknown composer refusal: ${JSON.stringify(read)}`)
      if (this.now() - state.startedAt >= options.readyTimeoutMs) {
        finish(RemoteControlTerminal.deliverError('timeout', 'The composer never became ready', state, 'not-ready'))
        return null
      }
      await this.pause(RemoteControlTerminal.readyPollMillisecondsConst)
      if (state.done) return null
    }
  }

  private async awaitComposed(
    sessionId: string,
    text: string,
    options: RemoteControlTerminalDeliverOptions,
    baseline: DeliverBaseline,
    readyAt: number,
    state: DeliverState,
    finish: DeliverFinish,
  ): Promise<RemoteControlTerminalDeliverComposeProof | null> {
    for (;;) {
      await this.pause(RemoteControlTerminal.composePollMillisecondsConst)
      if (state.done) return null
      const read = await this.sessions.terminalComposer(sessionId)
      if (state.done) return null
      if (read.ok) {
        state.last = read.reading
        if (RemoteControlTerminal.holdsOurText(read.reading, text)) return 'text'
        if (RemoteControlTerminal.holdsOurPlaceholder(read.reading, options, baseline)) return 'placeholder'
      }
      if (this.now() - readyAt >= RemoteControlDeliverConst.composeTimeoutMillisecondsConst) {
        finish(RemoteControlTerminal.deliverError('operation-failed', 'The text never appeared in the composer', state, 'text-not-visible'))
        return null
      }
    }
  }

  private async awaitSubmitted(
    attachId: string,
    sessionId: string,
    text: string,
    options: RemoteControlTerminalDeliverOptions,
    proof: RemoteControlTerminalDeliverProofPort,
    baseline: DeliverBaseline,
    state: DeliverState,
    finish: DeliverFinish,
  ): Promise<RemoteControlTerminalDeliverProof | null> {
    const submitStartedAt = this.now()
    let transcriptReadAt = submitStartedAt
    for (;;) {
      await this.pause(RemoteControlTerminal.composePollMillisecondsConst)
      if (state.done) return null
      const read = await this.sessions.terminalComposer(sessionId)
      if (state.done) return null
      if (read.ok) state.last = read.reading
      const holds = read.ok && (RemoteControlTerminal.holdsOurText(read.reading, text)
        || RemoteControlTerminal.holdsOurPlaceholder(read.reading, options, baseline))
      const elapsed = this.now() - submitStartedAt
      if (!holds) {
        let transcriptProof = false
        if (this.now() - transcriptReadAt >= RemoteControlTerminal.transcriptPollMillisecondsConst) {
          transcriptReadAt = this.now()
          transcriptProof = RemoteControlTerminal.newerUserTurn(baseline.turns, await proof.transcript(), text)
          if (state.done) return null
        }
        const proven = RemoteControlTerminal.proofOf(baseline, read.ok ? read.reading : null, text, transcriptProof)
        if (proven !== null) return proven
      } else if (state.entered === 1 && elapsed >= RemoteControlTerminal.secondEnterAtMillisecondsConst) {
        const again = this.writeInput(attachId, RemoteControlTerminal.submitKeysConst[baseline.submitKey])
        if (!again.ok) {
          finish(RemoteControlTerminal.deliverError(again.error.code, again.error.detail, state, RemoteControlTerminal.reasonOf(again.error.code, state)))
          return null
        }
        state.entered = 2
      }
      if (elapsed >= options.submitTimeoutMs) {
        finish(holds
          ? RemoteControlTerminal.deliverError('operation-failed', 'The draft is still in the composer', state, 'draft-remains')
          : RemoteControlTerminal.deliverError('operation-failed', 'The composer cleared but nothing proves a submit', state, 'unproven'))
        return null
      }
    }
  }

  /**
   * `queued` and `echo` count only when they differ from the ready-time screen: the queued row and
   * Claude's echo head also show a message queued before this call. `working` counts only when the
   * target was not already busy at ready time.
   */
  private static proofOf(
    baseline: DeliverBaseline,
    reading: TerminalComposerReading | null,
    text: string,
    transcriptProof: boolean,
  ): RemoteControlTerminalDeliverProof | null {
    if (transcriptProof) return 'transcript'
    if (reading === null) return null
    if (reading.queuedRow && !baseline.queuedRow) return 'queued'
    // A Tab queues behind a turn that is already running, so neither an echo nor that busy hint says
    // anything about THIS message: only a new queued row or the transcript does.
    if (baseline.submitKey === 'tab') return null
    if (reading.echoHead !== null
      && reading.echoHead.length > 0
      && reading.echoHead !== baseline.echoHead
      && RemoteControlTerminal.normalized(text).startsWith(reading.echoHead))
      return 'echo'
    if (!RemoteControlTerminal.busyHintsConst.includes(baseline.hint)
      && RemoteControlTerminal.busyHintsConst.includes(reading.hint))
      return 'working'
    return null
  }

  /**
   * Tab only where it queues: Codex (0.155.1) steers a running turn on Enter and queues on Tab, while
   * Claude queues on Enter and an idle Codex would take Tab as something else. Decided on the ready
   * reading, the last one before anything is written.
   */
  private static submitKeyOf(
    options: RemoteControlTerminalDeliverOptions,
    ready: TerminalComposerReading,
  ): RemoteControlTerminalDeliverSubmitKey {
    return options.queue === true
      && ready.agentId === 'codex'
      && RemoteControlTerminal.busyHintsConst.includes(ready.hint)
      ? 'tab'
      : 'enter'
  }

  /** Whitespace-free, so a draft the terminal wrapped compares equal to the text we wrote. */
  private static holdsOurText(reading: TerminalComposerReading, text: string): boolean {
    if (reading.composer.state !== 'text') return false
    const draft = RemoteControlTerminal.normalized(reading.composer.text)
    const own = RemoteControlTerminal.normalized(text)
    return draft.startsWith(own.slice(0, RemoteControlTerminal.headCharactersConst))
      && draft.endsWith(own.slice(-RemoteControlTerminal.tailCharactersConst))
  }

  /**
   * A paste the agent collapsed: one more placeholder than the empty composer showed at ready time,
   * and nothing else in the draft, so a foreign draft typed around our paste is never submitted.
   */
  private static holdsOurPlaceholder(
    reading: TerminalComposerReading,
    options: RemoteControlTerminalDeliverOptions,
    baseline: DeliverBaseline,
  ): boolean {
    return options.input === 'paste'
      && reading.onlyPlaceholders
      && reading.pastePlaceholders > baseline.pastePlaceholders
  }

  /** The same normalization as `ScreenTail.normalizeTty`, which `echoHead` is already in. */
  private static normalized(text: string): string {
    return text.toLowerCase().replace(/\s+/g, '')
  }

  /** The transcript is a sliding tail, so the newest `at` decides and the count only breaks a tie. */
  private static userTurnsOf(reading: SessionTranscriptReading): UserTurns | null {
    if (reading.kind === 'none') return null
    else if (reading.kind === 'messages') {
      const users = reading.messages.filter((message) => message.role === 'user')
      return {
        count: users.length,
        latest: users.reduce((latest, message) => Math.max(latest, message.at ?? -1), -1),
      }
    } else
      throw new Error(`Unknown transcript reading: ${JSON.stringify(reading)}`)
  }

  /** A user turn newer than the baseline whose normalized head matches the head of our text. */
  private static newerUserTurn(
    baseline: UserTurns | null,
    reading: SessionTranscriptReading,
    text: string,
  ): boolean {
    if (reading.kind === 'none') return false
    else if (reading.kind !== 'messages')
      throw new Error(`Unknown transcript reading: ${JSON.stringify(reading)}`)
    const users = reading.messages.filter((message) => message.role === 'user')
    const current = RemoteControlTerminal.userTurnsOf(reading)
    if (current === null) return false
    let newer: typeof users
    if (baseline === null) newer = users
    else if (current.latest > baseline.latest) newer = users.filter((message) => (message.at ?? -1) > baseline.latest)
    else if (current.latest === baseline.latest && current.count > baseline.count) newer = users.slice(baseline.count)
    else newer = []
    const head = RemoteControlTerminal.normalized(text).slice(0, RemoteControlTerminal.transcriptHeadCharactersConst)
    return newer.some((message) => RemoteControlTerminal.normalized(message.text)
      .slice(0, RemoteControlTerminal.transcriptHeadCharactersConst).startsWith(head))
  }

  private static reasonOf(
    code: RemoteControlError['code'],
    state: DeliverState,
  ): RemoteControlTerminalDeliverFailureData['reason'] {
    if (code === 'not-found') return 'not-live'
    else if (code === 'unavailable') return 'disconnected'
    else if (code === 'conflict') return 'read-only'
    else if (code === 'timeout') return state.typed ? 'unproven' : 'not-ready'
    else if (code === 'invalid-request'
      || code === 'protocol-mismatch'
      || code === 'forbidden'
      || code === 'operation-failed')
      return 'failed'
    else
      throw new Error(`Unknown remote control error code: ${JSON.stringify(code)}`)
  }

  private static stageOf(state: DeliverState): RemoteControlTerminalDeliverFailureData['stage'] {
    if (state.entered > 0) return 'submit'
    if (state.typed) return 'compose'
    if (state.attached) return 'ready'
    return 'attach'
  }

  private static deliverError(
    code: RemoteControlError['code'],
    detail: string,
    state: DeliverState,
    reason: RemoteControlTerminalDeliverFailureData['reason'],
  ): RemoteControlStepResult<RemoteControlTerminalDeliverDto> {
    const data: RemoteControlTerminalDeliverFailureData = {
      stage: reason === 'shell-session' ? 'validate' : RemoteControlTerminal.stageOf(state),
      reason,
      typed: state.typed,
      entered: state.entered,
      hint: state.last?.hint ?? null,
      composer: state.last?.composer ?? null,
    }
    return { ok: false, error: { code, detail, data: { ...data } } }
  }

  private writeInput(attachId: string, data: string): RemoteControlStepResult<null> {
    try {
      const input = this.sessions.terminalInput(attachId, data)
      if (input.kind === 'sent')
        return RemoteControlTerminal.success(null)
      else if (input.kind === 'not-writer')
        return RemoteControlTerminal.error('conflict', 'The terminal attach is read-only')
      else if (input.kind === 'unknown-attach')
        return RemoteControlTerminal.error('unavailable', 'The terminal attach disappeared')
      else
        throw new Error(`Unknown terminal input result: ${JSON.stringify(input)}`)
    } catch (error) {
      this.deps.onError(`Remote terminal send failed: ${ErrorText.of(error)}`)
      return RemoteControlTerminal.error('operation-failed', 'The terminal send operation failed')
    }
  }

  attachLive(
    ownerId: string,
    attachId: string,
    spec: TerminalAttachSpec,
    onFrame: (frame: TerminalFrame) => void,
  ): RemoteControlStepResult<RemoteControlLiveTerminalAttachDto> {
    const owned = this.liveByOwner.get(ownerId)
    if (owned?.has(attachId))
      return RemoteControlTerminal.error(
        'conflict',
        `Terminal attach ${JSON.stringify(attachId)} already exists`,
      )
    const ownerAttachments = owned ?? new Map<string, LiveTerminalAttachment>()
    if (!owned) this.liveByOwner.set(ownerId, ownerAttachments)
    const live = {
      internalAttachId: `control-live:${this.internalAttachId()}`,
      sessionId: spec.sessionId,
    }
    ownerAttachments.set(attachId, live)
    const attached = this.sessions.terminalAttach(live.internalAttachId, spec, {
      source: 'remote',
      onFrame: (frame) => this.liveFrame(ownerId, attachId, live, frame, onFrame),
    })
    if (!attached.ok) {
      this.forgetLive(ownerId, attachId, live)
      return RemoteControlTerminal.attachError(attached)
    }
    return RemoteControlTerminal.success({ attachId, sessionId: spec.sessionId })
  }

  inputLive(
    ownerId: string,
    attachId: string,
    data: string,
  ): RemoteControlStepResult<RemoteControlLiveTerminalInputDto> {
    const live = this.liveByOwner.get(ownerId)?.get(attachId)
    if (!live)
      return RemoteControlTerminal.error('not-found', `No terminal attach ${JSON.stringify(attachId)}`)
    const input = this.sessions.terminalInput(live.internalAttachId, data)
    if (input.kind === 'sent')
      return RemoteControlTerminal.success({
        attachId,
        accepted: true,
        characterCount: data.length,
      })
    else if (input.kind === 'not-writer')
      return RemoteControlTerminal.error('conflict', 'The terminal attach is read-only')
    else if (input.kind === 'unknown-attach') {
      this.forgetLive(ownerId, attachId, live)
      return RemoteControlTerminal.error('unavailable', 'The terminal attach disappeared')
    } else
      throw new Error(`Unknown terminal input result: ${JSON.stringify(input)}`)
  }

  resizeLive(
    ownerId: string,
    attachId: string,
    cols: number,
    rows: number,
  ): RemoteControlStepResult<RemoteControlLiveTerminalResizeDto> {
    const live = this.liveByOwner.get(ownerId)?.get(attachId)
    if (!live)
      return RemoteControlTerminal.error('not-found', `No terminal attach ${JSON.stringify(attachId)}`)
    const resized = this.sessions.terminalResize(live.internalAttachId, cols, rows)
    if (resized.kind === 'applied' || resized.kind === 'ignored')
      return RemoteControlTerminal.success({
        attachId,
        accepted: true,
        applied: resized.kind === 'applied',
      })
    else if (resized.kind === 'unknown-attach') {
      this.forgetLive(ownerId, attachId, live)
      return RemoteControlTerminal.error('unavailable', 'The terminal attach disappeared')
    } else
      throw new Error(`Unknown terminal resize result: ${JSON.stringify(resized)}`)
  }

  setLiveActive(
    ownerId: string,
    attachId: string,
    active: boolean,
  ): RemoteControlStepResult<RemoteControlLiveTerminalResizeDto> {
    const live = this.liveByOwner.get(ownerId)?.get(attachId)
    if (!live)
      return RemoteControlTerminal.error('not-found', `No terminal attach ${JSON.stringify(attachId)}`)
    const resized = this.sessions.terminalSetGeometryActive(live.internalAttachId, active)
    if (resized.kind === 'applied' || resized.kind === 'ignored')
      return RemoteControlTerminal.success({
        attachId,
        accepted: true,
        applied: resized.kind === 'applied',
      })
    else if (resized.kind === 'unknown-attach') {
      this.forgetLive(ownerId, attachId, live)
      return RemoteControlTerminal.error('unavailable', 'The terminal attach disappeared')
    } else
      throw new Error(`Unknown terminal resize result: ${JSON.stringify(resized)}`)
  }

  detachLive(ownerId: string, attachId: string): RemoteControlStepResult<{ attachId: string }> {
    const live = this.liveByOwner.get(ownerId)?.get(attachId)
    if (!live)
      return RemoteControlTerminal.error('not-found', `No terminal attach ${JSON.stringify(attachId)}`)
    this.forgetLive(ownerId, attachId, live)
    this.sessions.terminalDetach(live.internalAttachId)
    return RemoteControlTerminal.success({ attachId })
  }

  detachOwner(ownerId: string): void {
    const owned = this.liveByOwner.get(ownerId)
    if (!owned) return
    this.liveByOwner.delete(ownerId)
    this.sessions.terminalDetachAll(
      [...owned.values()].map((live) => live.internalAttachId),
    )
  }

  private once<T>(
    kind: 'peek' | 'send' | 'deliver',
    sessionId: string,
    size: TerminalAttachSpec['size'],
    timeoutMilliseconds: number | undefined,
    onFrame: (
      attachId: string,
      frame: TerminalFrame,
      finish: (result: RemoteControlStepResult<T>) => void,
    ) => void,
    onFinish: () => void = () => {},
  ): Promise<RemoteControlStepResult<T>> {
    const attachId = `control-${kind}:${this.internalAttachId()}`
    return new Promise((resolve) => {
      let settled = false
      let attached = false
      let attachComplete = false
      let detachOwed = false
      const timer = setTimeout(() => finish(RemoteControlTerminal.error(
        'timeout',
        `The terminal ${kind} operation timed out`,
      )), timeoutMilliseconds ?? this.timeoutMilliseconds)
      const finish = (result: RemoteControlStepResult<T>): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        onFinish()
        if (attached)
          this.sessions.terminalDetach(attachId)
        else if (!attachComplete)
          detachOwed = true
        resolve(result)
      }
      const answer = this.sessions.terminalAttach(attachId, { sessionId, size }, {
        source: 'remote',
        onFrame: (frame) => {
          if (settled) return
          try {
            onFrame(attachId, frame, finish)
          } catch (error) {
            this.deps.onError(`Remote terminal ${kind} failed: ${ErrorText.of(error)}`)
            finish(RemoteControlTerminal.error(
              'operation-failed',
              `The terminal ${kind} operation failed`,
            ))
          }
        },
      })
      attachComplete = true
      if (answer.ok) {
        attached = true
        if (detachOwed) this.sessions.terminalDetach(attachId)
      } else finish(RemoteControlTerminal.attachError(answer))
    })
  }

  private liveFrame(
    ownerId: string,
    attachId: string,
    live: LiveTerminalAttachment,
    frame: TerminalFrame,
    onFrame: (frame: TerminalFrame) => void,
  ): void {
    if (this.liveByOwner.get(ownerId)?.get(attachId) !== live)
      return
    try {
      onFrame(frame)
    } catch (error) {
      this.deps.onError(`Live remote terminal frame failed: ${ErrorText.of(error)}`)
      this.forgetLive(ownerId, attachId, live)
      this.sessions.terminalDetach(live.internalAttachId)
      return
    }
    if (frame.type === 'terminal.exit'
      || (frame.type === 'terminal.status' && frame.status === 'lost'))
      this.forgetLive(ownerId, attachId, live)
  }

  private forgetLive(ownerId: string, attachId: string, live: LiveTerminalAttachment): void {
    const owned = this.liveByOwner.get(ownerId)
    if (owned?.get(attachId) !== live)
      return
    owned.delete(attachId)
    if (owned.size === 0) this.liveByOwner.delete(ownerId)
  }

  private static attachError<T>(
    answer: Exclude<TerminalAttachResult, { ok: true }>,
  ): RemoteControlStepResult<T> {
    if (answer.code === 'host-unreachable')
      return RemoteControlTerminal.error('unavailable', answer.detail)
    else if (answer.code === 'not-live' || answer.code === 'unknown-session')
      return RemoteControlTerminal.error('not-found', answer.detail)
    else
      throw new Error(`Unknown terminal attach refusal: ${JSON.stringify(answer)}`)
  }

  private static statusError<T>(
    frame: Extract<TerminalFrame, { type: 'terminal.status' }>,
  ): RemoteControlStepResult<T> {
    if (frame.status !== 'lost')
      throw new Error(`Terminal status is not lost: ${JSON.stringify(frame)}`)
    return frame.code === 'not-live' || frame.code === 'unknown-session'
      ? RemoteControlTerminal.error('not-found', frame.detail ?? 'The terminal was lost')
      : RemoteControlTerminal.error('unavailable', frame.detail ?? 'The terminal was lost')
  }

  private static success<T>(value: T): RemoteControlStepResult<T> {
    return { ok: true, value }
  }

  private static error<T>(
    code: RemoteControlError['code'],
    detail: string,
  ): RemoteControlStepResult<T> {
    return { ok: false, error: { code, detail } }
  }
}
