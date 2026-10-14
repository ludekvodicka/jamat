import { open, readFile, stat } from 'node:fs/promises'

import type { ProviderSubagentFileRef } from '../../projectManager/providerTranscriptView'
import { BoundedMap } from '../../shared/boundedMap'
import { FileTail } from '../../shared/fileTail'
import { JsonShape } from '../../shared/jsonShape'
import { JsonlRecords } from '../../shared/jsonlRecords'
import type { ClaudeTaskEnd, ClaudeTaskEndStatus } from './claudeShellScan'
import type {
  SessionSubagentRow,
  SessionSubagentState,
  SessionTaskParentState,
} from '../sessionTasksApi.types'

type ClaudeSettledState = 'done' | 'failed' | 'stopped'

/** What one sub-agent file says on its own, before the parent's state is known. */
export interface ClaudeSubagentFacts {
  agentType: string
  description: string
  depth: 1 | 2
  parentSubagentId: string | null
  startedAt: number
  model: string | null
  step: string | null
  settled: { state: ClaudeSettledState; at: number } | null
  /** The time of the last record of the tail that states one. */
  lastRecordAt: number | null
}

/** One session's newest files, by file, each with the facts read under the stat in `key`. */
export type ClaudeSubagentMemo = Map<string, { key: string; facts: ClaudeSubagentFacts }>

/**
 * Claude Code sub-agents, each judged from its own `agent-<id>.jsonl` and its meta.
 *
 * The state is read off the last meaningful PARSED record, never a substring: an agent whose last
 * line is a `Bash` call quoting `[Request interrupted by user` is still working. The parent
 * transcript is never opened here; the end notifications its scan found arrive as the witness and
 * settle only a file that ends unsettled, and only when the notification is newer than its last record.
 *
 * Never throws for a file: one that vanished or cannot be read between the listing and the read is
 * left out of this listing and tried again in the next one.
 */
export class SessionTasksSourceClaude {
  static readonly classifiedMaxConst = 60
  /** An unsettled agent of an idle live parent counts as running this long after its file moved. */
  static readonly quietMillisecondsConst = 120_000
  private static readonly tailBytesConst = 65_536
  private static readonly headBytesConst = 4_096
  private static readonly stepCharactersConst = 160
  private static readonly readConcurrencyConst = 8
  static readonly interruptMarkerConst = '[Request interrupted by user'

  /**
   * Rows of the newest `classifiedMaxConst` files by mtime, newest first; the older files are
   * counted, never read. A file whose stat has not moved is not read again.
   */
  async list(
    files: readonly ProviderSubagentFileRef[],
    parent: SessionTaskParentState,
    memo: ClaudeSubagentMemo,
    witness: ReadonlyMap<string, ClaudeTaskEnd> = new Map(),
  ): Promise<{ rows: SessionSubagentRow[]; unread: number }> {
    const newest = [...files]
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, SessionTasksSourceClaude.classifiedMaxConst)
    const kept = new Set(newest.map((ref) => ref.file))
    for (const file of memo.keys())
      if (!kept.has(file)) memo.delete(file)
    const rows = await BoundedMap.run(newest, SessionTasksSourceClaude.readConcurrencyConst, async (ref) => {
      const facts = await SessionTasksSourceClaude.factsOf(ref, memo)
      return facts === null
        ? null
        : SessionTasksSourceClaude.rowOf(ref, facts, parent, witness.get(ref.subagentId) ?? null)
    })
    return {
      rows: rows.filter((row) => row !== null),
      unread: files.length - newest.length,
    }
  }

  static rowOf(
    ref: ProviderSubagentFileRef,
    facts: ClaudeSubagentFacts,
    parent: SessionTaskParentState,
    witness: ClaudeTaskEnd | null = null,
  ): SessionSubagentRow {
    const settled = facts.settled
      ?? SessionTasksSourceClaude.witnessedOf(witness, facts.lastRecordAt ?? ref.mtimeMs)
    const state = SessionTasksSourceClaude.stateOf(settled?.state ?? null, parent, ref.mtimeMs)
    return {
      kind: 'subagent',
      subagentId: ref.subagentId,
      agentType: facts.agentType,
      description: facts.description,
      depth: facts.depth,
      parentSubagentId: facts.parentSubagentId,
      state,
      startedAt: facts.startedAt,
      endedAt: settled?.at ?? null,
      model: facts.model,
      step: settled === null ? facts.step : null,
    }
  }

  /** An end notification newer than the file's last record settles it; an older one was resumed past. */
  static witnessedOf(
    witness: ClaudeTaskEnd | null,
    lastRecordAt: number,
  ): { state: ClaudeSettledState; at: number } | null {
    if (witness === null || witness.at <= lastRecordAt) return null
    return { state: SessionTasksSourceClaude.witnessStateOf(witness.status), at: witness.at }
  }

  private static witnessStateOf(status: ClaudeTaskEndStatus): ClaudeSettledState {
    switch (status) {
      case 'completed': return 'done'
      case 'failed': return 'failed'
      case 'killed':
      case 'stopped': return 'stopped'
      default: throw new Error(`Unknown task end status: ${JSON.stringify(status satisfies never)}`)
    }
  }

  static stateOf(
    settled: ClaudeSettledState | null,
    parent: SessionTaskParentState,
    movedAt: number,
  ): SessionSubagentState {
    if (settled !== null) return settled
    if (parent.live
      && (parent.busy || parent.now - movedAt < SessionTasksSourceClaude.quietMillisecondsConst))
      return 'running'
    return 'unfinished'
  }

  /** The last meaningful record of the tail decides; attachments and system records are skipped. */
  static settledOf(
    records: readonly Record<string, unknown>[],
  ): { state: ClaudeSettledState; record: Record<string, unknown> } | null {
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index]
      if (record.type === 'attachment' || record.type === 'system') continue
      if (record.type === 'assistant') {
        if (record.isApiErrorMessage === true) return { state: 'failed', record }
        return JsonShape.record(record.message)?.stop_reason === 'end_turn'
          ? { state: 'done', record }
          : null
      }
      if (record.type === 'user') {
        const text = SessionTasksSourceClaude.onlyTextOf(JsonShape.record(record.message)?.content)
        return text?.startsWith(SessionTasksSourceClaude.interruptMarkerConst) === true
          ? { state: 'stopped', record }
          : null
      }
      return null
    }
    return null
  }

  /** `Bash pnpm test`, `Read docs/x.md`: the last tool call of the tail, one line. */
  static stepOf(records: readonly Record<string, unknown>[]): string | null {
    for (let index = records.length - 1; index >= 0; index -= 1) {
      if (records[index].type !== 'assistant') continue
      const content = JsonShape.record(records[index].message)?.content
      if (!Array.isArray(content)) continue
      for (let block = content.length - 1; block >= 0; block -= 1) {
        const use = JsonShape.record(content[block])
        if (use?.type !== 'tool_use' || typeof use.name !== 'string') continue
        const summary = SessionTasksSourceClaude.summaryOf(use.name, JsonShape.record(use.input))
        return SessionTasksSourceClaude.oneLine(summary === null ? use.name : `${use.name} ${summary}`)
      }
    }
    return null
  }

  static summaryOf(tool: string, input: Record<string, unknown> | null): string | null {
    if (input === null) return null
    switch (tool) {
      case 'Bash': return SessionTasksSourceClaude.text(input.command)
      case 'Read': case 'Write': case 'Edit': case 'MultiEdit':
        return SessionTasksSourceClaude.text(input.file_path)
      case 'NotebookEdit': return SessionTasksSourceClaude.text(input.notebook_path)
      case 'Grep': case 'Glob': return SessionTasksSourceClaude.text(input.pattern)
      case 'Agent': case 'Task': return SessionTasksSourceClaude.text(input.description)
      default:
        for (const value of Object.values(input)) {
          const found = SessionTasksSourceClaude.text(value)
          if (found !== null) return found
        }
        return null
    }
  }

  private static async factsOf(
    ref: ProviderSubagentFileRef,
    memo: ClaudeSubagentMemo,
  ): Promise<ClaudeSubagentFacts | null> {
    const key = `${ref.mtimeMs}\0${ref.size}`
    const held = memo.get(ref.file)
    if (held !== undefined && held.key === key) return held.facts
    try {
      const facts = await SessionTasksSourceClaude.readFacts(ref)
      memo.set(ref.file, { key, facts })
      return facts
    }
    catch {
      memo.delete(ref.file)
      return null
    }
  }

  private static async readFacts(ref: ProviderSubagentFileRef): Promise<ClaudeSubagentFacts> {
    const tail = await FileTail.readBounded(ref.file, ref.size, SessionTasksSourceClaude.tailBytesConst)
    const head = await SessionTasksSourceClaude.head(ref.file, SessionTasksSourceClaude.headBytesConst)
    const meta = ref.metaFile === null ? null : await SessionTasksSourceClaude.meta(ref.metaFile)
    const records = JsonlRecords.of(tail.content)
      .map((record) => JsonShape.record(record))
      .filter((record) => record !== null)
    const first = SessionTasksSourceClaude.firstRecordOf(head)
    const settled = SessionTasksSourceClaude.settledOf(records)
    const description = SessionTasksSourceClaude.text(meta?.fields.description)
      ?? SessionTasksSourceClaude.promptLineOf(head, first)
      ?? ''
    const spawnDepth = meta?.fields.spawnDepth
    return {
      agentType: ref.workflowId !== null
        ? 'workflow'
        : SessionTasksSourceClaude.text(meta?.fields.agentType) ?? 'agent',
      description,
      depth: typeof spawnDepth === 'number' && spawnDepth >= 2 ? 2 : 1,
      parentSubagentId: SessionTasksSourceClaude.text(meta?.fields.parentAgentId),
      startedAt: SessionTasksSourceClaude.timeOf(first?.timestamp) ?? meta?.mtimeMs ?? ref.mtimeMs,
      model: SessionTasksSourceClaude.modelOf(records, meta?.fields.model),
      step: SessionTasksSourceClaude.stepOf(records),
      settled: settled === null
        ? null
        : {
          state: settled.state,
          at: SessionTasksSourceClaude.timeOf(settled.record.timestamp) ?? ref.mtimeMs,
        },
      lastRecordAt: SessionTasksSourceClaude.lastTimeOf(records),
    }
  }

  private static lastTimeOf(records: readonly Record<string, unknown>[]): number | null {
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const time = SessionTasksSourceClaude.timeOf(records[index].timestamp)
      if (time !== null) return time
    }
    return null
  }

  private static modelOf(records: readonly Record<string, unknown>[], metaModel: unknown): string | null {
    for (let index = records.length - 1; index >= 0; index -= 1) {
      if (records[index].type !== 'assistant') continue
      const model = SessionTasksSourceClaude.text(JsonShape.record(records[index].message)?.model)
      if (model !== null && model !== '<synthetic>') return model
    }
    const fromMeta = SessionTasksSourceClaude.text(metaModel)
    return fromMeta === 'inherit' ? null : fromMeta
  }

  /**
   * The first line of the prompt. The first record holds the whole prompt and is often longer than
   * the head, so a cut record still gives the start of its `content` string.
   */
  private static promptLineOf(head: string, first: Record<string, unknown> | null): string | null {
    let prompt: string | null = null
    if (first !== null) {
      const content = JsonShape.record(first.message)?.content
      prompt = typeof content === 'string' ? content : SessionTasksSourceClaude.onlyTextOf(content)
    }
    else {
      const cut = /"content":"((?:[^"\\]|\\.)*)/.exec(head.split('\n', 1)[0])?.[1]
      if (cut !== undefined)
        try { prompt = JSON.parse(`"${cut}"`) as string }
        catch { prompt = null }
    }
    const line = prompt?.split(/\r?\n/).find((one) => one.trim() !== '')
    return line === undefined ? null : SessionTasksSourceClaude.oneLine(line)
  }

  private static firstRecordOf(head: string): Record<string, unknown> | null {
    const end = head.indexOf('\n')
    if (end < 0) return null
    try { return JsonShape.record(JSON.parse(head.slice(0, end))) }
    catch { return null }
  }

  private static onlyTextOf(content: unknown): string | null {
    if (typeof content === 'string') return content
    if (!Array.isArray(content) || content.length !== 1) return null
    const block = JsonShape.record(content[0])
    return block?.type === 'text' && typeof block.text === 'string' ? block.text : null
  }

  static oneLine(text: string): string {
    const line = text.replace(/\s+/g, ' ').trim()
    return line.length <= SessionTasksSourceClaude.stepCharactersConst
      ? line
      : `${line.slice(0, SessionTasksSourceClaude.stepCharactersConst - 1)}…`
  }

  private static text(value: unknown): string | null {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
  }

  private static timeOf(value: unknown): number | null {
    if (typeof value !== 'string') return null
    const time = Date.parse(value)
    return Number.isFinite(time) ? time : null
  }

  private static async head(file: string, maxBytes: number): Promise<string> {
    const handle = await open(file, 'r')
    try {
      const buffer = Buffer.alloc(maxBytes)
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
      return buffer.toString('utf8', 0, bytesRead)
    }
    finally { await handle.close() }
  }

  private static async meta(
    metaFile: string,
  ): Promise<{ fields: Record<string, unknown>; mtimeMs: number } | null> {
    try {
      const [content, stats] = await Promise.all([readFile(metaFile, 'utf8'), stat(metaFile)])
      const fields = JsonShape.record(JSON.parse(content))
      return fields === null ? null : { fields, mtimeMs: stats.mtimeMs }
    }
    catch { return null }
  }
}
