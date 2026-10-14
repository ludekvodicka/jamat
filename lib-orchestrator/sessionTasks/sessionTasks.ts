import type { ProviderSubagentFileRef, ProviderTranscriptView } from '../projectManager/providerTranscriptView'
import { ErrorText } from '../shared/errorText'
import { ClaudeShellOutput } from './claude/claudeShellOutput'
import { ClaudeShellScan } from './claude/claudeShellScan'
import { ClaudeSubagentTranscript } from './claude/claudeSubagentTranscript'
import {
  type ClaudeSubagentMemo,
  SessionTasksSourceClaude,
} from './claude/sessionTasksSourceClaude'
import { CodexSubagentTranscript } from './codex/codexSubagentTranscript'
import {
  type CodexSubagentMemo,
  SessionTasksSourceCodex,
} from './codex/sessionTasksSourceCodex'
import type {
  SessionShellOutput,
  SessionShellRow,
  SessionSubagentRow,
  SessionSubagentTranscript,
  SessionTaskAgentId,
  SessionTaskListing,
  SessionTaskParentState,
} from './sessionTasksApi.types'

/** One session as the listing is given it: where its agent writes, under which native id. */
export interface SessionTasksContext {
  agentId: SessionTaskAgentId
  cwd: string
  nativeSessionId: string
  /**
   * The record's `createdAt`. Codex files each child thread under the day it started, so a listing
   * reads day directories from here on; without it a Codex listing answers `none`.
   */
  startedAt?: number
}

/** The background shells a listing carries beside the sub-agents; Codex has none to read. */
export interface SessionShellRows {
  rows: readonly SessionShellRow[]
  /** Finished shells the scan no longer keeps. */
  olderFinished: number
  catchingUp: boolean
}

interface ListedSource {
  rows: SessionSubagentRow[]
  unread: number
  shells: SessionShellRows
}

/**
 * What runs inside one agent session besides its own conversation, read from the files the agent's
 * CLI already writes. No agent call, no cadence: the caller decides when to ask.
 *
 * The listing cache is this facade's own, one memo per session, and none of the transcript readers
 * beside it share an entry with it; each sub-agent transcript reader keeps a cache of its own, and
 * the Claude shell scan keeps one state per parent transcript. Never throws for a reading: a failure
 * is a `none` with its reason.
 */
export class SessionTasks {
  private static readonly idPatternConst = /^[A-Za-z0-9_-]{1,64}$/
  private static readonly listedSessionsMaxConst = 64
  private static readonly finishedRowsMaxConst = 50
  /** A scan restarted from zero reads 4 MiB per call; a shell further down needs more calls. */
  private static readonly shellScanCallsMaxConst = 8
  private static readonly noShellsConst: SessionShellRows = { rows: [], olderFinished: 0, catchingUp: false }

  private readonly files: Pick<ProviderTranscriptView, 'subagentFiles' | 'resolve' | 'claudeShellOutputFile'>
  private readonly claude = new SessionTasksSourceClaude()
  private readonly codex = new SessionTasksSourceCodex()
  private readonly shells = new ClaudeShellScan()
  private readonly memos = new Map<string, ClaudeSubagentMemo>()
  private readonly codexMemos = new Map<string, CodexSubagentMemo>()
  private readonly transcripts = new ClaudeSubagentTranscript()
  private readonly codexTranscripts = new CodexSubagentTranscript()

  constructor(files: Pick<ProviderTranscriptView, 'subagentFiles' | 'resolve' | 'claudeShellOutputFile'>) {
    this.files = files
  }

  /**
   * Running rows first, sub-agents before shells, then the newest settled rows of both. Sub-agent
   * `rows` arrive newest movement first and keep that order; settled shells are merged in by their end.
   */
  static listing(
    rows: readonly SessionSubagentRow[],
    unread: number,
    shells: SessionShellRows = SessionTasks.noShellsConst,
  ): SessionTaskListing {
    const running = [
      ...rows.filter((row) => row.state === 'running'),
      ...shells.rows.filter((row) => row.state === 'running').sort((a, b) => b.startedAt - a.startedAt),
    ]
    const settled = SessionTasks.merged(
      rows.filter((row) => row.state !== 'running'),
      shells.rows
        .filter((row) => row.state !== 'running')
        .sort((a, b) => SessionTasks.movedAt(b) - SessionTasks.movedAt(a)),
    )
    return {
      kind: 'tasks',
      rows: [...running, ...settled.slice(0, SessionTasks.finishedRowsMaxConst)],
      olderFinished: unread + shells.olderFinished
        + Math.max(0, settled.length - SessionTasks.finishedRowsMaxConst),
      catchingUp: shells.catchingUp,
    }
  }

  async list(context: SessionTasksContext, parent: SessionTaskParentState): Promise<SessionTaskListing> {
    if (!SessionTasks.idPatternConst.test(context.nativeSessionId))
      return { kind: 'none', code: 'transcript-not-found', reason: 'the native session id is not a plain id' }
    if (context.agentId === 'codex' && context.startedAt === undefined)
      return { kind: 'none', code: 'unreadable', reason: 'the session start is not known' }
    let source: (files: readonly ProviderSubagentFileRef[]) => Promise<ListedSource>
    switch (context.agentId) {
      case 'claude': {
        const memo = SessionTasks.memoOf(this.memos, context)
        source = (files) => this.claudeListed(context, files, parent, memo)
        break
      }
      case 'codex': {
        const memo = SessionTasks.memoOf(this.codexMemos, context)
        source = async (files) => ({ ...await this.codex.list(files, parent, memo), shells: SessionTasks.noShellsConst })
        break
      }
      default:
        throw new Error(`Unknown session task agent: ${JSON.stringify(context.agentId satisfies never)}`)
    }
    try {
      const listed = await source(await this.files.subagentFiles({
        agentId: context.agentId,
        cwd: context.cwd,
        nativeSessionId: context.nativeSessionId,
        since: context.startedAt ?? 0,
      }))
      return SessionTasks.listing(listed.rows, listed.unread, listed.shells)
    }
    catch (error) {
      return { kind: 'none', code: 'unreadable', reason: `sub-agents unreadable: ${ErrorText.of(error)}` }
    }
  }

  /** The parent transcript's scan first: its agent notifications settle unsettled sub-agent files. */
  private async claudeListed(
    context: SessionTasksContext,
    files: readonly ProviderSubagentFileRef[],
    parent: SessionTaskParentState,
    memo: ClaudeSubagentMemo,
  ): Promise<ListedSource> {
    const transcript = await this.files.resolve({
      agentId: 'claude',
      cwd: context.cwd,
      nativeSessionId: context.nativeSessionId,
    })
    const scanned = transcript === null ? null : await this.shells.scan(transcript)
    const listed = await this.claude.list(files, parent, memo, scanned?.agentNotifications)
    return {
      ...listed,
      shells: scanned === null
        ? SessionTasks.noShellsConst
        : {
          rows: scanned.shells.map((facts) => ClaudeShellScan.rowOf(facts, parent)),
          olderFinished: scanned.olderFinished,
          catchingUp: scanned.catchingUp,
        },
    }
  }

  /** Two lists, each newest first, into one in which each keeps its own order. */
  private static merged(
    subagents: readonly SessionSubagentRow[],
    shells: readonly SessionShellRow[],
  ): Array<SessionSubagentRow | SessionShellRow> {
    const out: Array<SessionSubagentRow | SessionShellRow> = []
    let left = 0
    let right = 0
    while (left < subagents.length || right < shells.length) {
      if (right >= shells.length
        || (left < subagents.length && SessionTasks.movedAt(subagents[left]) >= SessionTasks.movedAt(shells[right])))
        out.push(subagents[left++])
      else
        out.push(shells[right++])
    }
    return out
  }

  private static movedAt(row: SessionSubagentRow | SessionShellRow): number {
    return row.endedAt ?? row.startedAt
  }


  /**
   * The steps of one sub-agent, found by its id in this session's own listing, never by a path.
   * `known` equal to the file's current `mtimeMs:size` answers `unchanged` without a read.
   */
  async transcript(
    context: SessionTasksContext,
    subagentId: string,
    parent: SessionTaskParentState,
    known: string | null,
  ): Promise<SessionSubagentTranscript> {
    if (!SessionTasks.idPatternConst.test(context.nativeSessionId))
      return { kind: 'none', code: 'transcript-not-found', reason: 'the native session id is not a plain id' }
    let reader: ClaudeSubagentTranscript | CodexSubagentTranscript
    switch (context.agentId) {
      case 'claude':
        reader = this.transcripts
        break
      case 'codex':
        if (context.startedAt === undefined)
          return { kind: 'none', code: 'unreadable', reason: 'the session start is not known' }
        reader = this.codexTranscripts
        break
      default:
        throw new Error(`Unknown session task agent: ${JSON.stringify(context.agentId satisfies never)}`)
    }
    if (!SessionTasks.idPatternConst.test(subagentId))
      return { kind: 'none', code: 'unknown-task', reason: 'the sub-agent id is not a plain id' }
    try {
      const files = await this.files.subagentFiles({
        agentId: context.agentId,
        cwd: context.cwd,
        nativeSessionId: context.nativeSessionId,
        since: context.startedAt ?? 0,
      })
      const ref = files.find((one) => one.subagentId === subagentId)
      if (ref === undefined)
        return { kind: 'none', code: 'unknown-task', reason: `the session has no sub-agent ${subagentId}` }
      return await reader.read(ref, parent, known)
    }
    catch (error) {
      return { kind: 'none', code: 'unreadable', reason: `sub-agents unreadable: ${ErrorText.of(error)}` }
    }
  }

  /**
   * The end of one background shell's output, found by its id in this session's own transcript scan,
   * never by a path the caller names. `known` equal to the current revision answers `unchanged`
   * without a read.
   */
  async shellOutput(
    context: SessionTasksContext,
    shellId: string,
    parent: SessionTaskParentState,
    known: string | null,
  ): Promise<SessionShellOutput> {
    if (!SessionTasks.idPatternConst.test(context.nativeSessionId))
      return { kind: 'none', code: 'transcript-not-found', reason: 'the native session id is not a plain id' }
    switch (context.agentId) {
      case 'claude':
        break
      case 'codex':
        return { kind: 'none', code: 'unknown-task', reason: 'Codex background shells are not read' }
      default:
        throw new Error(`Unknown session task agent: ${JSON.stringify(context.agentId satisfies never)}`)
    }
    if (!SessionTasks.idPatternConst.test(shellId))
      return { kind: 'none', code: 'unknown-task', reason: 'the shell id is not a plain id' }
    try {
      const transcript = await this.files.resolve({
        agentId: 'claude',
        cwd: context.cwd,
        nativeSessionId: context.nativeSessionId,
      })
      if (transcript === null)
        return { kind: 'none', code: 'transcript-not-found', reason: 'the session transcript was not found' }
      let scanned = await this.shells.scan(transcript)
      for (let calls = 1; calls < SessionTasks.shellScanCallsMaxConst && scanned.catchingUp
        && !scanned.shells.some((one) => one.shellId === shellId); calls += 1)
        scanned = await this.shells.scan(transcript)
      const facts = scanned.shells.find((one) => one.shellId === shellId)
      if (facts === undefined)
        return { kind: 'none', code: 'unknown-task', reason: `the session has no background shell ${shellId}` }
      const row = ClaudeShellScan.rowOf(facts, parent)
      const file = await this.files.claudeShellOutputFile({
        cwd: context.cwd,
        nativeSessionId: context.nativeSessionId,
        shellId,
        statedPath: facts.statedOutput,
      })
      if (file !== null) return await ClaudeShellOutput.read(file, row, known)
      if (row.state !== 'running')
        return { kind: 'none', code: 'unreadable', reason: `the output file of shell ${shellId} is gone` }
      // Claude Code may not have created the file yet: an empty output keeps the view following it.
      const revision = `missing:${row.state}`
      if (known === revision) return { kind: 'unchanged', revision }
      return {
        kind: 'output', revision, command: row.command, state: row.state, startedAt: row.startedAt, endedAt: row.endedAt,
        text: '', earlierOutputOmitted: false,
      }
    }
    catch (error) {
      return { kind: 'none', code: 'unreadable', reason: `shell output unreadable: ${ErrorText.of(error)}` }
    }
  }

  private static memoOf<T>(memos: Map<string, Map<string, T>>, context: SessionTasksContext): Map<string, T> {
    const key = `${context.agentId}\0${context.nativeSessionId}`
    const memo = memos.get(key) ?? new Map<string, T>()
    // Delete then set: the map's own order is the LRU order.
    memos.delete(key)
    memos.set(key, memo)
    while (memos.size > SessionTasks.listedSessionsMaxConst)
      memos.delete(memos.keys().next().value!)
    return memo
  }
}
