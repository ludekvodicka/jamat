import { open } from 'node:fs/promises'

import type { ProviderTranscriptRef } from '../../projectManager/providerTranscriptView'
import { JsonShape } from '../../shared/jsonShape'
import type { SessionShellRow, SessionShellState, SessionTaskParentState } from '../sessionTasksApi.types'

export type AntigravityTaskEndStatus = 'completed' | 'failed' | 'killed'

export interface AntigravityTaskEnd {
  status: AntigravityTaskEndStatus
  at: number
}

export interface AntigravityShellFacts {
  shellId: string
  command: string
  description: string | null
  startedAt: number
  end: AntigravityTaskEnd | null
}

export interface AntigravityShellReading {
  shells: readonly AntigravityShellFacts[]
  olderFinished: number
  catchingUp: boolean
}

interface CommandCall {
  command: string
  description: string | null
}

interface ScanState {
  offset: number
  mtimeMs: number
  guard: Buffer
  partial: Buffer
  skipping: boolean
  recentCommands: CommandCall[]
  shells: Map<string, AntigravityShellFacts>
  droppedFinished: number
  earlyEnds: Map<string, AntigravityTaskEnd>
}

/**
 * Background shell tasks of one Antigravity CLI session, found by an append-only scan of its
 * parent `transcript.jsonl`.
 *
 * Antigravity records backgrounded `run_command` steps as `GENERIC` rows with
 * `Tool is running as a background task with task id: <conversationId>/<task-N>` and delivers their
 * completion as `SYSTEM_MESSAGE` rows naming `Task id "<conversationId>/<task-N>" finished with result:`.
 */
export class AntigravityShellScan {
  static readonly maxBytesPerCallConst = 4 * 1024 * 1024
  static readonly finishedKeptConst = 50
  private static readonly guardBytesConst = 256
  private static readonly recentCommandsMaxConst = 32
  private static readonly statesMaxConst = 64
  private static readonly earlyEndsMaxConst = 256
  private static readonly partialMaxBytesConst = 16 * 1024 * 1024
  private static readonly newlineConst = 0x0a
  private static readonly stepCharactersConst = 160
  private static readonly launchPatternConst = /Tool is running as a background task with task id:\s*[A-Za-z0-9_-]+\/(task-\d+)/
  private static readonly taskDescPatternConst = /^Task Description:\s*(.+)$/m
  private static readonly finishedPatternConst = /Task id "([A-Za-z0-9_-]+)\/(task-\d+)" finished with result:\s*\r?\n([\s\S]*)/
  private static readonly exitCodePatternConst = /^Command exited with code (\d+)\./m

  private readonly states = new Map<string, ScanState>()
  private readonly inFlight = new Map<string, Promise<AntigravityShellReading>>()

  async scan(ref: ProviderTranscriptRef): Promise<AntigravityShellReading> {
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

  static rowOf(facts: AntigravityShellFacts, parent: SessionTaskParentState): SessionShellRow {
    const firstLine = facts.command.split(/\r?\n/).find((line) => line.trim() !== '') ?? facts.command
    return {
      kind: 'shell',
      shellId: facts.shellId,
      command: AntigravityShellScan.oneLine(firstLine),
      description: facts.description,
      state: facts.end === null
        ? (parent.live ? 'running' : 'unfinished')
        : AntigravityShellScan.shellStateOf(facts.end.status),
      startedAt: facts.startedAt,
      endedAt: facts.end?.at ?? null,
    }
  }

  static shellStateOf(status: AntigravityTaskEndStatus): SessionShellState {
    switch (status) {
      case 'completed': return 'done'
      case 'failed': return 'failed'
      case 'killed': return 'killed'
      default: throw new Error(`Unknown Antigravity task end status: ${JSON.stringify(status satisfies never)}`)
    }
  }

  private async scanNow(ref: ProviderTranscriptRef): Promise<AntigravityShellReading> {
    let state = this.states.get(ref.file)
    this.states.delete(ref.file)
    if (state !== undefined && state.offset === ref.size && state.mtimeMs === ref.mtimeMs) {
      this.keep(ref.file, state)
      return AntigravityShellScan.readingOf(state, ref.size)
    }
    if (state === undefined || ref.size < state.offset) state = AntigravityShellScan.fresh()
    let read = await AntigravityShellScan.readFrom(ref.file, state.offset, ref.size)
    if (!read.guard.equals(state.guard)) {
      state = AntigravityShellScan.fresh()
      read = await AntigravityShellScan.readFrom(ref.file, 0, ref.size)
    }
    AntigravityShellScan.consume(state, read.chunk)
    state.offset += read.chunk.length
    state.mtimeMs = ref.mtimeMs
    state.guard = read.guardAfter
    AntigravityShellScan.trim(state)
    this.keep(ref.file, state)
    return AntigravityShellScan.readingOf(state, ref.size)
  }

  private keep(file: string, state: ScanState): void {
    this.states.set(file, state)
    while (this.states.size > AntigravityShellScan.statesMaxConst)
      this.states.delete(this.states.keys().next().value!)
  }

  private static async readFrom(
    file: string,
    offset: number,
    size: number,
  ): Promise<{ guard: Buffer; chunk: Buffer; guardAfter: Buffer }> {
    const start = Math.max(0, offset - AntigravityShellScan.guardBytesConst)
    const until = Math.min(size, offset + AntigravityShellScan.maxBytesPerCallConst)
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
        guardAfter: Buffer.from(bytes.subarray(Math.max(0, bytes.length - AntigravityShellScan.guardBytesConst))),
      }
    }
    finally { await handle.close() }
  }

  private static consume(state: ScanState, chunk: Buffer): void {
    let bytes = chunk
    if (state.skipping) {
      const end = bytes.indexOf(AntigravityShellScan.newlineConst)
      if (end < 0) return
      bytes = bytes.subarray(end + 1)
      state.skipping = false
    }
    const data = state.partial.length === 0 ? bytes : Buffer.concat([state.partial, bytes])
    const last = data.lastIndexOf(AntigravityShellScan.newlineConst)
    const rest = data.subarray(last + 1)
    if (rest.length > AntigravityShellScan.partialMaxBytesConst) {
      state.partial = Buffer.alloc(0)
      state.skipping = true
    }
    else
      state.partial = Buffer.from(rest)
    if (last < 0) return
    for (const line of data.toString('utf8', 0, last).split('\n')) {
      if (!AntigravityShellScan.mayMatter(line)) continue
      let record: Record<string, unknown> | null
      try { record = JsonShape.record(JSON.parse(line)) }
      catch { record = null }
      if (record !== null) AntigravityShellScan.apply(state, record)
    }
  }

  private static mayMatter(line: string): boolean {
    return line.includes('"run_command"')
      || line.includes('background task with task id:')
      || line.includes('finished with result:')
  }

  private static apply(state: ScanState, record: Record<string, unknown>): void {
    if (record['type'] === 'PLANNER_RESPONSE' && Array.isArray(record['tool_calls'])) {
      for (const item of record['tool_calls']) {
        const call = JsonShape.record(item)
        if (call?.['name'] !== 'run_command') continue
        const args = JsonShape.record(call['args'])
        const command = AntigravityShellScan.unquote(args?.['CommandLine'])
        if (command === null) continue
        const description = AntigravityShellScan.unquote(args?.['toolSummary'])
        state.recentCommands.push({ command, description })
        if (state.recentCommands.length > AntigravityShellScan.recentCommandsMaxConst)
          state.recentCommands.shift()
      }
      return
    }
    const content = typeof record['content'] === 'string' ? record['content'] : null
    if (content === null) return
    const at = AntigravityShellScan.timeOf(record['created_at']) ?? 0
    if (record['type'] === 'GENERIC') {
      const launched = AntigravityShellScan.launchPatternConst.exec(content)
      if (launched !== null) {
        const shellId = launched[1]!
        if (!state.shells.has(shellId)) {
          const descMatch = AntigravityShellScan.taskDescPatternConst.exec(content)
          const commandFromTask = descMatch?.[1]?.trim() ?? ''
          const matched = commandFromTask.length > 0
            ? [...state.recentCommands].reverse().find((item) =>
              item.command === commandFromTask
              || item.command.split(/\r?\n/).find((line) => line.trim() !== '')?.trim() === commandFromTask)
            : state.recentCommands.at(-1)
          state.shells.set(shellId, {
            shellId,
            command: commandFromTask || matched?.command || shellId,
            description: matched?.description ?? null,
            startedAt: at,
            end: state.earlyEnds.get(shellId) ?? null,
          })
        }
        state.earlyEnds.delete(shellId)
      }
      return
    }
    if (record['type'] === 'SYSTEM_MESSAGE') {
      const finished = AntigravityShellScan.finishedPatternConst.exec(content)
      if (finished === null) return
      const shellId = finished[2]!
      const resultBody = finished[3] ?? ''
      const status = AntigravityShellScan.statusOf(resultBody)
      const shell = state.shells.get(shellId)
      if (shell !== undefined)
        shell.end = { status, at }
      else {
        state.earlyEnds.delete(shellId)
        state.earlyEnds.set(shellId, { status, at })
        while (state.earlyEnds.size > AntigravityShellScan.earlyEndsMaxConst)
          state.earlyEnds.delete(state.earlyEnds.keys().next().value!)
      }
    }
  }

  private static statusOf(body: string): AntigravityTaskEndStatus {
    // Only inspect header lines before `Command output:` so arbitrary command stdout cannot spoof exit status.
    const outputAt = body.search(/^Command output:/m)
    const header = outputAt >= 0 ? body.slice(0, outputAt) : body.slice(0, 1024)
    const exitMatch = AntigravityShellScan.exitCodePatternConst.exec(header)
    if (exitMatch !== null) return exitMatch[1] === '0' ? 'completed' : 'failed'
    const lower = header.trim().toLowerCase()
    if (lower.includes('exited with code 0')) return 'completed'
    if (lower.includes('killed') || lower.includes('terminated') || lower.includes('cancelled')) return 'killed'
    return 'failed'
  }

  private static unquote(value: unknown): string | null {
    if (typeof value !== 'string') return null
    let text = value.trim()
    if (text.length >= 2 && text.startsWith('"') && text.endsWith('"'))
      try {
        const parsed = JSON.parse(text)
        if (typeof parsed === 'string') text = parsed.trim()
      }
      catch { /* keep raw */ }
    return text.length > 0 ? text : null
  }

  private static timeOf(value: unknown): number | null {
    if (typeof value !== 'string') return null
    const time = Date.parse(value)
    return Number.isFinite(time) ? time : null
  }

  private static oneLine(text: string): string {
    const flat = text.replace(/\s+/g, ' ').trim()
    return flat.length <= AntigravityShellScan.stepCharactersConst
      ? flat
      : `${flat.slice(0, AntigravityShellScan.stepCharactersConst - 1)}…`
  }

  private static trim(state: ScanState): void {
    const finished = [...state.shells.values()]
      .filter((shell) => shell.end !== null)
      .sort((a, b) => b.end!.at - a.end!.at)
    for (const shell of finished.slice(AntigravityShellScan.finishedKeptConst)) {
      state.shells.delete(shell.shellId)
      state.droppedFinished += 1
    }
  }

  private static readingOf(state: ScanState, size: number): AntigravityShellReading {
    return {
      shells: [...state.shells.values()].map((shell) => ({ ...shell, end: shell.end === null ? null : { ...shell.end } })),
      olderFinished: state.droppedFinished,
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
      recentCommands: [],
      shells: new Map(),
      droppedFinished: 0,
      earlyEnds: new Map(),
    }
  }
}
