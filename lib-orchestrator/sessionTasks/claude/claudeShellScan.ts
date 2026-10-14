import { open } from 'node:fs/promises'

import type { ProviderTranscriptRef } from '../../projectManager/providerTranscriptView'
import { JsonShape } from '../../shared/jsonShape'
import type { SessionShellRow, SessionShellState, SessionTaskParentState } from '../sessionTasksApi.types'
import { SessionTasksSourceClaude } from './sessionTasksSourceClaude'

/** The `<status>` of a `<task-notification>` this scan acts on; any other status is ignored. */
export type ClaudeTaskEndStatus = 'completed' | 'failed' | 'killed' | 'stopped'

/** The latest end notification of one background task, at the time the transcript states. */
export interface ClaudeTaskEnd {
  status: ClaudeTaskEndStatus
  at: number
}

/** One background shell of the session's own agent, as its launch and its notifications state it. */
export interface ClaudeShellFacts {
  shellId: string
  command: string
  description: string | null
  startedAt: number
  /** The output path the launch's tool_result names; checked by shape before anybody reads it. */
  statedOutput: string | null
  end: ClaudeTaskEnd | null
}

export interface ClaudeShellReading {
  /** Every shell without an end, and the newest finished ones. */
  shells: readonly ClaudeShellFacts[]
  /** Finished shells the scan no longer keeps. */
  olderFinished: number
  /** Sub-agent `a<id>` -> its latest end notification: the witness for an agent file that ends unsettled. */
  agentNotifications: ReadonlyMap<string, ClaudeTaskEnd>
  /** The scan stopped before the end of the file and continues on the next call. */
  catchingUp: boolean
}

interface BashUse {
  command: string
  description: string | null
}

interface ScanState {
  offset: number
  mtimeMs: number
  /** The bytes just before `offset`: a file rewritten under the scan no longer holds them. */
  guard: Buffer
  /** An incomplete last line, completed by the next call. */
  partial: Buffer
  /** A line grew past `partialMaxBytesConst`: its bytes are dropped up to its end. */
  skipping: boolean
  bashUses: Map<string, BashUse>
  shells: Map<string, ClaudeShellFacts>
  droppedFinished: number
  agentNotifications: Map<string, ClaudeTaskEnd>
  /** Ends of ids not launched yet: a short shell's notification can be written before its launch. */
  earlyEnds: Map<string, ClaudeTaskEnd>
}

/**
 * Background shells of one Claude session, found by an append-only scan of its parent transcript.
 *
 * A shell's launch can sit anywhere in a transcript of many megabytes and its end much later, so a
 * bounded tail would lose it; this is the one reader that follows a file. It keeps a byte offset per
 * file, reads at most 4 MiB per call and only bytes appended since the last call. The bytes before
 * the offset are compared on every call that reads: the history migrator rewrites transcripts in
 * place, and a rewritten file is scanned again from zero.
 *
 * The launch is the `user` record whose `toolUseResult.backgroundTaskId` answers a remembered `Bash`
 * call; that also covers a command moved to the background with ctrl+b or by its timeout, whose
 * call carries no `run_in_background`. A Monitor launch (`toolUseResult.taskId`) is no shell.
 */
export class ClaudeShellScan {
  static readonly maxBytesPerCallConst = 4 * 1024 * 1024
  static readonly finishedKeptConst = 50
  private static readonly guardBytesConst = 256
  private static readonly bashUsesMaxConst = 64
  private static readonly statesMaxConst = 64
  private static readonly agentNotificationsMaxConst = 1_024
  private static readonly earlyEndsMaxConst = 256
  /** A line longer than this is no launch or notification; it is skipped, never held. */
  private static readonly partialMaxBytesConst = 16 * 1024 * 1024
  private static readonly taskIdPatternConst = /^[A-Za-z0-9_-]{1,64}$/
  private static readonly notificationPrefixConst = '<task-notification>'
  private static readonly newlineConst = 0x0a

  /** By parent transcript path; the map's own order is the LRU order. */
  private readonly states = new Map<string, ScanState>()
  private readonly inFlight = new Map<string, Promise<ClaudeShellReading>>()

  /** Calls for one file run one after the other: each continues from the state the last one left. */
  async scan(ref: ProviderTranscriptRef): Promise<ClaudeShellReading> {
    const previous = this.inFlight.get(ref.file)
    const next = previous === undefined
      ? this.scanNow(ref)
      : previous.then(() => this.scanNow(ref), () => this.scanNow(ref))
    this.inFlight.set(ref.file, next)
    try { return await next }
    finally {
      if (this.inFlight.get(ref.file) === next) this.inFlight.delete(ref.file)
    }
  }

  /** A shell without an end runs while its parent lives; once the parent is gone it did not finish. */
  static rowOf(facts: ClaudeShellFacts, parent: SessionTaskParentState): SessionShellRow {
    const firstLine = facts.command.split(/\r?\n/).find((line) => line.trim() !== '') ?? facts.command
    return {
      kind: 'shell',
      shellId: facts.shellId,
      command: SessionTasksSourceClaude.oneLine(firstLine),
      description: facts.description,
      state: facts.end === null
        ? (parent.live ? 'running' : 'unfinished')
        : ClaudeShellScan.shellStateOf(facts.end.status),
      startedAt: facts.startedAt,
      endedAt: facts.end?.at ?? null,
    }
  }

  static shellStateOf(status: ClaudeTaskEndStatus): SessionShellState {
    switch (status) {
      case 'completed': return 'done'
      case 'failed': return 'failed'
      case 'killed':
      case 'stopped': return 'killed'
      default: throw new Error(`Unknown task end status: ${JSON.stringify(status satisfies never)}`)
    }
  }

  private async scanNow(ref: ProviderTranscriptRef): Promise<ClaudeShellReading> {
    let state = this.states.get(ref.file)
    this.states.delete(ref.file)
    if (state !== undefined && state.offset === ref.size && state.mtimeMs === ref.mtimeMs) {
      this.keep(ref.file, state)
      return ClaudeShellScan.readingOf(state, ref.size)
    }
    if (state === undefined || ref.size < state.offset) state = ClaudeShellScan.fresh()
    let read = await ClaudeShellScan.readFrom(ref.file, state.offset, ref.size)
    if (!read.guard.equals(state.guard)) {
      state = ClaudeShellScan.fresh()
      read = await ClaudeShellScan.readFrom(ref.file, 0, ref.size)
    }
    ClaudeShellScan.consume(state, read.chunk)
    state.offset += read.chunk.length
    state.mtimeMs = ref.mtimeMs
    state.guard = read.guardAfter
    ClaudeShellScan.trim(state)
    this.keep(ref.file, state)
    return ClaudeShellScan.readingOf(state, ref.size)
  }

  private keep(file: string, state: ScanState): void {
    this.states.set(file, state)
    while (this.states.size > ClaudeShellScan.statesMaxConst)
      this.states.delete(this.states.keys().next().value!)
  }

  /**
   * At most `maxBytesPerCallConst` from `offset`, with the guard bytes before it and the guard to keep
   * for the next call, in one read.
   */
  private static async readFrom(
    file: string,
    offset: number,
    size: number,
  ): Promise<{ guard: Buffer; chunk: Buffer; guardAfter: Buffer }> {
    const start = Math.max(0, offset - ClaudeShellScan.guardBytesConst)
    const until = Math.min(size, offset + ClaudeShellScan.maxBytesPerCallConst)
    const length = Math.max(0, until - start)
    const handle = await open(file, 'r')
    try {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, start)
      const bytes = buffer.subarray(0, bytesRead)
      const before = Math.min(offset - start, bytes.length)
      return {
        guard: bytes.subarray(0, before),
        chunk: bytes.subarray(before),
        guardAfter: Buffer.from(bytes.subarray(Math.max(0, bytes.length - ClaudeShellScan.guardBytesConst))),
      }
    }
    finally { await handle.close() }
  }

  private static consume(state: ScanState, chunk: Buffer): void {
    let bytes = chunk
    if (state.skipping) {
      const end = bytes.indexOf(ClaudeShellScan.newlineConst)
      if (end < 0) return
      bytes = bytes.subarray(end + 1)
      state.skipping = false
    }
    const data = state.partial.length === 0 ? bytes : Buffer.concat([state.partial, bytes])
    // A newline byte never occurs inside a UTF-8 sequence, so a cut here never splits a character.
    const last = data.lastIndexOf(ClaudeShellScan.newlineConst)
    const rest = data.subarray(last + 1)
    if (rest.length > ClaudeShellScan.partialMaxBytesConst) {
      state.partial = Buffer.alloc(0)
      state.skipping = true
    }
    else
      state.partial = Buffer.from(rest)
    if (last < 0) return
    for (const line of data.toString('utf8', 0, last).split('\n')) {
      if (!ClaudeShellScan.mayMatter(line)) continue
      const record = ClaudeShellScan.parse(line)
      if (record !== null) ClaudeShellScan.apply(state, record)
    }
  }

  /** Lines that name none of these cannot hold a Bash call, a launch or a notification. */
  private static mayMatter(line: string): boolean {
    return line.includes('"name":"Bash"')
      || line.includes('"backgroundTaskId"')
      || line.includes(ClaudeShellScan.notificationPrefixConst)
      || line.includes('"task_type"')
  }

  private static parse(line: string): Record<string, unknown> | null {
    try { return JsonShape.record(JSON.parse(line)) }
    catch { return null }
  }

  private static apply(state: ScanState, record: Record<string, unknown>): void {
    for (const [toolUseId, use] of ClaudeShellScan.bashUsesOf(record)) {
      state.bashUses.delete(toolUseId)
      state.bashUses.set(toolUseId, use)
      while (state.bashUses.size > ClaudeShellScan.bashUsesMaxConst)
        state.bashUses.delete(state.bashUses.keys().next().value!)
    }
    const launch = ClaudeShellScan.launchOf(record)
    if (launch !== null) {
      const use = state.bashUses.get(launch.toolUseId)
      if (use !== undefined && !state.shells.has(launch.shellId))
        state.shells.set(launch.shellId, {
          shellId: launch.shellId,
          command: use.command,
          description: use.description,
          startedAt: launch.at,
          statedOutput: launch.statedOutput,
          end: state.earlyEnds.get(launch.shellId) ?? null,
        })
      state.earlyEnds.delete(launch.shellId)
    }
    const ended = ClaudeShellScan.notificationOf(record) ?? ClaudeShellScan.taskStopOf(record)
    if (ended === null) return
    const shell = state.shells.get(ended.taskId)
    if (shell !== undefined)
      shell.end = { status: ended.status, at: ended.at }
    else if (ended.taskId.startsWith('a')) {
      state.agentNotifications.delete(ended.taskId)
      state.agentNotifications.set(ended.taskId, { status: ended.status, at: ended.at })
      while (state.agentNotifications.size > ClaudeShellScan.agentNotificationsMaxConst)
        state.agentNotifications.delete(state.agentNotifications.keys().next().value!)
    }
    else {
      // A sub-agent's own shell, a Monitor task, a shell launched before the scan's memory, or a shell
      // whose launch record comes after its end: kept a while for the last one.
      state.earlyEnds.delete(ended.taskId)
      state.earlyEnds.set(ended.taskId, { status: ended.status, at: ended.at })
      while (state.earlyEnds.size > ClaudeShellScan.earlyEndsMaxConst)
        state.earlyEnds.delete(state.earlyEnds.keys().next().value!)
    }
  }

  private static bashUsesOf(record: Record<string, unknown>): Array<[string, BashUse]> {
    if (record.type !== 'assistant') return []
    const content = JsonShape.record(record.message)?.content
    if (!Array.isArray(content)) return []
    const uses: Array<[string, BashUse]> = []
    for (const item of content) {
      const block = JsonShape.record(item)
      if (block?.type !== 'tool_use' || block.name !== 'Bash' || typeof block.id !== 'string') continue
      const input = JsonShape.record(block.input)
      if (typeof input?.command !== 'string') continue
      const description = typeof input.description === 'string' && input.description.trim() !== ''
        ? input.description.trim()
        : null
      uses.push([block.id, { command: input.command, description }])
    }
    return uses
  }

  private static launchOf(
    record: Record<string, unknown>,
  ): { toolUseId: string; shellId: string; at: number; statedOutput: string | null } | null {
    if (record.type !== 'user') return null
    const shellId = JsonShape.record(record.toolUseResult)?.backgroundTaskId
    if (typeof shellId !== 'string' || !ClaudeShellScan.taskIdPatternConst.test(shellId)) return null
    const content = JsonShape.record(record.message)?.content
    if (!Array.isArray(content)) return null
    for (const item of content) {
      const block = JsonShape.record(item)
      if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
      return {
        toolUseId: block.tool_use_id,
        shellId,
        at: ClaudeShellScan.timeOf(record.timestamp) ?? 0,
        statedOutput: ClaudeShellScan.statedOutputOf(ClaudeShellScan.textOf(block.content)),
      }
    }
    return null
  }

  private static statedOutputOf(text: string | null): string | null {
    return text === null ? null : /Output is being written to: (.+?\.output)/.exec(text)?.[1] ?? null
  }

  /** A `queue-operation` enqueue, or the `user` turn that delivers it; the attachment copies are skipped. */
  private static notificationOf(
    record: Record<string, unknown>,
  ): { taskId: string; status: ClaudeTaskEndStatus; at: number } | null {
    let text: string | null = null
    if (record.type === 'queue-operation' && record.operation === 'enqueue' && typeof record.content === 'string')
      text = record.content
    else if (record.type === 'user')
      text = ClaudeShellScan.onlyTextOf(JsonShape.record(record.message)?.content)
    if (text === null || !text.trimStart().startsWith(ClaudeShellScan.notificationPrefixConst)) return null
    const taskId = /<task-id>([^<]*)<\/task-id>/.exec(text)?.[1]
    const status = ClaudeShellScan.statusOf(/<status>([^<]*)<\/status>/.exec(text)?.[1])
    const at = ClaudeShellScan.timeOf(record.timestamp)
    if (taskId === undefined || !ClaudeShellScan.taskIdPatternConst.test(taskId) || status === null || at === null)
      return null
    return { taskId, status, at }
  }

  /**
   * A task the agent stopped with `TaskStop` gets no `<task-notification>`: its end is that call's
   * result, `{ message: 'Successfully stopped task: ...', task_id, task_type, command }`. A stop that
   * found nothing to stop is an error string and ends nothing.
   */
  private static taskStopOf(
    record: Record<string, unknown>,
  ): { taskId: string; status: ClaudeTaskEndStatus; at: number } | null {
    if (record.type !== 'user') return null
    const result = JsonShape.record(record.toolUseResult)
    const taskId = result?.task_id
    if (typeof taskId !== 'string' || !ClaudeShellScan.taskIdPatternConst.test(taskId)) return null
    if (result?.task_type !== 'local_bash' && result?.task_type !== 'local_agent') return null
    if (typeof result.message !== 'string' || !result.message.startsWith('Successfully stopped task')) return null
    const at = ClaudeShellScan.timeOf(record.timestamp)
    return at === null ? null : { taskId, status: 'stopped', at }
  }

  private static statusOf(value: string | undefined): ClaudeTaskEndStatus | null {
    switch (value) {
      case 'completed':
      case 'failed':
      case 'killed':
      case 'stopped':
        return value
      default:
        return null
    }
  }

  private static onlyTextOf(content: unknown): string | null {
    if (typeof content === 'string') return content
    if (!Array.isArray(content) || content.length !== 1) return null
    const block = JsonShape.record(content[0])
    return block?.type === 'text' && typeof block.text === 'string' ? block.text : null
  }

  private static textOf(content: unknown): string | null {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return null
    const texts = content
      .map((item) => JsonShape.record(item))
      .flatMap((block) => block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [])
    return texts.length === 0 ? null : texts.join('\n')
  }

  private static timeOf(value: unknown): number | null {
    if (typeof value !== 'string') return null
    const time = Date.parse(value)
    return Number.isFinite(time) ? time : null
  }

  /** Every shell without an end stays; of the finished ones the newest are kept and the rest counted. */
  private static trim(state: ScanState): void {
    const finished = [...state.shells.values()]
      .filter((shell) => shell.end !== null)
      .sort((a, b) => b.end!.at - a.end!.at)
    for (const shell of finished.slice(ClaudeShellScan.finishedKeptConst)) {
      state.shells.delete(shell.shellId)
      state.droppedFinished += 1
    }
  }

  private static readingOf(state: ScanState, size: number): ClaudeShellReading {
    return {
      shells: [...state.shells.values()].map((shell) => ({ ...shell, end: shell.end === null ? null : { ...shell.end } })),
      olderFinished: state.droppedFinished,
      agentNotifications: new Map(state.agentNotifications),
      catchingUp: state.offset < size,
    }
  }

  private static fresh(): ScanState {
    return {
      offset: 0,
      mtimeMs: 0,
      guard: Buffer.alloc(0),
      partial: Buffer.alloc(0),
      skipping: false,
      bashUses: new Map(),
      shells: new Map(),
      droppedFinished: 0,
      agentNotifications: new Map(),
      earlyEnds: new Map(),
    }
  }
}
