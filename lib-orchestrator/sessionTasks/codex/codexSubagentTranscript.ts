import { open } from 'node:fs/promises'

import { ProviderTranscriptMessages } from '../../projectManager/providerTranscriptMessages'
import type { ProviderSubagentFileRef } from '../../projectManager/providerTranscriptView'
import { ErrorText } from '../../shared/errorText'
import { FileTail } from '../../shared/fileTail'
import { JsonNumber } from '../../shared/jsonNumber'
import { JsonShape } from '../../shared/jsonShape'
import { JsonlRecords } from '../../shared/jsonlRecords'
import { ClaudeSubagentTranscript } from '../claude/claudeSubagentTranscript'
import { SessionTasksSourceClaude } from '../claude/sessionTasksSourceClaude'
import type {
  SessionSubagentEntry,
  SessionSubagentTranscript,
  SessionTaskParentState,
} from '../sessionTasksApi.types'
import { SessionTasksSourceCodex } from './sessionTasksSourceCodex'

/** What one rollout says under one revision; the state is composed per call, because it moves with the clock. */
interface CodexSubagentReading {
  revision: string
  description: string | null
  model: string | null
  contextTokens: number | null
  settled: NonNullable<ReturnType<typeof SessionTasksSourceCodex.settledOf>>['state'] | null
  entries: readonly SessionSubagentEntry[]
  earlierStepsOmitted: boolean
}

interface CodexWalk {
  /** The parent's task: a `prompt`, or `encrypted` when its payload is. Null once the child's own work began. */
  task: SessionSubagentEntry | null
  entries: SessionSubagentEntry[]
  model: string | null
  contextTokens: number | null
}

/**
 * The steps of one Codex child thread, from its own rollout: commands as `exec` lines, applied
 * patches as edits, the messages of both sides, and the parent's task. A multi-agent v2 message
 * arrives encrypted (`gAAAA...`) and is shown only as having been sent.
 *
 * Only `response_item` messages are read: Codex repeats each one as an `event_msg` item for its own
 * display. Commands come from their completed `CommandExecution` items, never from the code-mode
 * `exec` script that ran them, which may run several.
 *
 * Its cache is its own, one reading per file under its `mtimeMs:size`. Never throws for a file: a
 * failed read answers `none`.
 */
export class CodexSubagentTranscript {
  /**
   * The task sits behind the injected instructions, 115 to 230 KiB into the rollouts of this
   * machine, so U3's 64 KiB head would never reach it.
   */
  static readonly headBytesConst = 262_144
  private static readonly cachedMaxConst = 16
  private static readonly encryptedPrefixConst = 'gAAAA'
  /** The plaintext frame a v2 inter-agent message carries around its payload. */
  private static readonly envelopeLinePatternConst = /^(Message Type|Task name|Sender|Payload):/

  private readonly cache = new Map<string, CodexSubagentReading>()

  static revisionOf(ref: ProviderSubagentFileRef): string {
    return `${ref.mtimeMs}:${ref.size}`
  }

  async read(
    ref: ProviderSubagentFileRef,
    parent: SessionTaskParentState,
    known: string | null,
  ): Promise<SessionSubagentTranscript> {
    const revision = CodexSubagentTranscript.revisionOf(ref)
    if (known === revision) return { kind: 'unchanged', revision }
    let reading = this.cache.get(ref.file)
    if (reading?.revision !== revision)
      try { reading = await CodexSubagentTranscript.readingOf(ref, revision) }
      catch (error) {
        this.cache.delete(ref.file)
        return { kind: 'none', code: 'unreadable', reason: `sub-agent rollout unreadable: ${ErrorText.of(error)}` }
      }
    // Delete then set: the map's own order is the LRU order.
    this.cache.delete(ref.file)
    this.cache.set(ref.file, reading)
    while (this.cache.size > CodexSubagentTranscript.cachedMaxConst)
      this.cache.delete(this.cache.keys().next().value!)
    const nickname = ref.thread?.nickname ?? null
    return {
      kind: 'transcript',
      revision,
      header: {
        agentType: nickname ?? 'agent',
        description: reading.description ?? nickname ?? '',
        model: reading.model,
        state: SessionTasksSourceClaude.stateOf(reading.settled, parent, ref.mtimeMs),
        contextTokens: reading.contextTokens,
      },
      entries: reading.entries,
      earlierStepsOmitted: reading.earlierStepsOmitted,
    }
  }

  /**
   * The last 2 MiB in file order, the task taken from the head when the tail began past it. A file
   * the head and the tail would overlap in is read whole, so the task is never read twice.
   */
  static async readingOf(ref: ProviderSubagentFileRef, revision: string): Promise<CodexSubagentReading> {
    const whole = ref.size <= ClaudeSubagentTranscript.tailBytesConst + CodexSubagentTranscript.headBytesConst
    const tail = await FileTail.readBounded(ref.file, ref.size, whole ? ref.size : ClaudeSubagentTranscript.tailBytesConst)
    const records = CodexSubagentTranscript.recordsOf(tail.content)
    const walked = CodexSubagentTranscript.walk(records, tail.startedAtFileBeginning)
    const head = tail.startedAtFileBeginning
      ? null
      : CodexSubagentTranscript.walk(CodexSubagentTranscript.recordsOf(await CodexSubagentTranscript.head(ref)), true)
    const task = head?.task ?? walked.task
    return {
      revision,
      description: task?.kind === 'prompt' ? CodexSubagentTranscript.firstLineOf(task.text) : null,
      model: walked.model ?? head?.model ?? null,
      contextTokens: walked.contextTokens,
      settled: SessionTasksSourceCodex.settledOf(records)?.state ?? null,
      entries: task === null ? walked.entries : [task, ...walked.entries],
      earlierStepsOmitted: !tail.startedAtFileBeginning,
    }
  }

  /**
   * The S1 entries of the records in file order. With `taskExpected`, the first message to the
   * child before any step of its own is the task, returned apart from the entries.
   */
  static walk(records: readonly Record<string, unknown>[], taskExpected: boolean): CodexWalk {
    const walk: CodexWalk = { task: null, entries: [], model: null, contextTokens: null }
    const pending = new Map<string, number>()
    let taskOpen = taskExpected
    for (const record of records) {
      const payload = JsonShape.record(record.payload)
      if (payload === null) continue
      const at = CodexSubagentTranscript.timeOf(record.timestamp)
      const before = walk.entries.length
      switch (record.type) {
        case 'turn_context':
          walk.model = CodexSubagentTranscript.text(payload.model) ?? walk.model
          break
        case 'compacted':
          CodexSubagentTranscript.compact(walk.entries, at)
          break
        case 'response_item': {
          const incoming = CodexSubagentTranscript.incomingOf(record, payload, at)
          if (incoming !== null && taskOpen) {
            walk.task = incoming.kind === 'message' ? { kind: 'prompt', text: incoming.text, truncated: incoming.truncated } : incoming
            taskOpen = false
          }
          else if (incoming !== null)
            walk.entries.push(incoming)
          else
            CodexSubagentTranscript.responseEntries(payload, at, walk.entries, pending)
          break
        }
        case 'event_msg':
          if (payload.type === 'token_count')
            walk.contextTokens = JsonNumber.wholeCount(JsonShape.record(JsonShape.record(payload.info)?.last_token_usage)?.total_tokens)
              ?? walk.contextTokens
          else
            CodexSubagentTranscript.eventEntries(payload, at, walk.entries)
          break
        default:
          break
      }
      if (walk.entries.length > before) taskOpen = false
    }
    return walk
  }

  /** A message to the child: the parent's plaintext user message, or another agent's message. */
  private static incomingOf(
    record: Record<string, unknown>,
    payload: Record<string, unknown>,
    at: number | null,
  ): Extract<SessionSubagentEntry, { kind: 'message' | 'encrypted' }> | null {
    let text: string | null = null
    if (payload.type === 'message' && payload.role === 'user') {
      const message = ProviderTranscriptMessages.codex(record)?.text ?? null
      // `<recommended_plugins>` and other tagged blocks are Codex's own context, not a message.
      text = message === null || message.trimStart().startsWith('<') ? null : message
    }
    else if (payload.type === 'agent_message') {
      if (!Array.isArray(payload.content)) return null
      const parts = payload.content.map((part) => JsonShape.record(part))
      if (parts.some((part) => part?.type === 'encrypted_content')) return { kind: 'encrypted', at }
      text = parts
        .flatMap((part) => part?.type === 'input_text' && typeof part.text === 'string' ? [part.text] : [])
        .join('\n')
        .split(/\r?\n/)
        .filter((line) => !CodexSubagentTranscript.envelopeLinePatternConst.test(line))
        .join('\n')
        .trim()
    }
    if (text === null || text === '') return null
    if (text.startsWith(CodexSubagentTranscript.encryptedPrefixConst)) return { kind: 'encrypted', at }
    return { kind: 'message', role: 'user', ...CodexSubagentTranscript.textCut(text), at }
  }

  private static responseEntries(
    payload: Record<string, unknown>,
    at: number | null,
    entries: SessionSubagentEntry[],
    pending: Map<string, number>,
  ): void {
    switch (payload.type) {
      case 'reasoning':
        if (entries.at(-1)?.kind !== 'thinking') entries.push({ kind: 'thinking', at })
        break
      case 'message': {
        if (payload.role !== 'assistant') break
        const text = CodexSubagentTranscript.partsTextOf(payload.content)
        if (text !== '')
          entries.push(CodexSubagentTranscript.outgoingOf(text, at))
        break
      }
      case 'function_call': {
        const name = CodexSubagentTranscript.text(payload.name)
        if (name === null) break
        const input = CodexSubagentTranscript.argumentsOf(payload.arguments)
        if (name === 'send_message' && typeof input?.message === 'string' && input.message.trim() !== '') {
          entries.push(CodexSubagentTranscript.outgoingOf(input.message.trim(), at))
          break
        }
        if (typeof payload.call_id === 'string') pending.set(payload.call_id, entries.length)
        const summary = SessionTasksSourceClaude.summaryOf(name, input)
        entries.push({
          kind: 'tool',
          tool: name,
          summary: summary === null ? '' : SessionTasksSourceClaude.oneLine(summary),
          output: null,
          outputTruncated: false,
          failed: false,
          at,
        })
        break
      }
      case 'function_call_output': {
        const callId = typeof payload.call_id === 'string' ? payload.call_id : null
        const index = callId === null ? undefined : pending.get(callId)
        if (callId === null || index === undefined) break
        pending.delete(callId)
        const call = entries[index]
        const output = typeof payload.output === 'string' ? CodexSubagentTranscript.outputOf(payload.output) : null
        if (call.kind === 'tool' && output !== null)
          entries[index] = { ...call, output: output.text, outputTruncated: output.truncated }
        break
      }
      default:
        break
    }
  }

  private static eventEntries(payload: Record<string, unknown>, at: number | null, entries: SessionSubagentEntry[]): void {
    switch (payload.type) {
      case 'item_completed': {
        const item = JsonShape.record(payload.item)
        if (item?.type === 'CommandExecution')
          entries.push(CodexSubagentTranscript.commandOf(item, at))
        else if (item?.type === 'FileChange' && item.status === 'completed')
          entries.push(...CodexSubagentTranscript.editsOf(item.changes, at))
        else if (item?.type === 'ContextCompaction')
          CodexSubagentTranscript.compact(entries, at)
        break
      }
      // Older CLIs write the applied patch only as this event; current ones only as a FileChange item.
      case 'patch_apply_end':
        if (payload.success === true) entries.push(...CodexSubagentTranscript.editsOf(payload.changes, at))
        break
      case 'turn_aborted':
        entries.push(payload.reason === 'interrupted'
          ? { kind: 'interrupted', at }
          : { kind: 'error', text: `The turn was aborted: ${CodexSubagentTranscript.text(payload.reason) ?? 'no reason given'}`, at })
        break
      default:
        break
    }
  }

  private static commandOf(item: Record<string, unknown>, at: number | null): SessionSubagentEntry {
    const argv = Array.isArray(item.command) ? item.command.at(-1) : item.command
    const parsed = Array.isArray(item.parsed_cmd) ? JsonShape.record(item.parsed_cmd[0]) : null
    const command = CodexSubagentTranscript.text(argv) ?? CodexSubagentTranscript.text(parsed?.cmd) ?? ''
    const output = typeof item.aggregated_output === 'string' ? CodexSubagentTranscript.outputOf(item.aggregated_output) : null
    return {
      kind: 'tool',
      tool: 'exec',
      summary: SessionTasksSourceClaude.oneLine(command),
      output: output?.text ?? null,
      outputTruncated: output?.truncated ?? false,
      failed: item.status === 'failed' || item.status === 'declined'
        || (typeof item.exit_code === 'number' && item.exit_code !== 0),
      at,
    }
  }

  /** One edit per file of the patch; a change in a shape this reader does not know is left out. */
  private static editsOf(changes: unknown, at: number | null): SessionSubagentEntry[] {
    const byPath = JsonShape.record(changes)
    if (byPath === null) return []
    return Object.entries(byPath).flatMap(([path, raw]) => {
      const change = JsonShape.record(raw)
      let lines: string[]
      if (change?.type === 'update' && typeof change.unified_diff === 'string')
        lines = CodexSubagentTranscript.linesOf(change.unified_diff)
          .filter((line) => !line.startsWith('@@') && !line.startsWith('\\'))
      else if (change?.type === 'add' && typeof change.content === 'string')
        lines = CodexSubagentTranscript.linesOf(change.content).map((line) => `+${line}`)
      else if (change?.type === 'delete' && typeof change.content === 'string')
        lines = CodexSubagentTranscript.linesOf(change.content).map((line) => `-${line}`)
      else
        return []
      return [{
        kind: 'edit' as const,
        path: CodexSubagentTranscript.text(change.move_path) ?? path,
        added: lines.filter((line) => line.startsWith('+')).length,
        removed: lines.filter((line) => line.startsWith('-')).length,
        preview: CodexSubagentTranscript.cut(
          lines.slice(0, ClaudeSubagentTranscript.previewLinesConst).join('\n'),
          ClaudeSubagentTranscript.outputCharactersConst,
        ).text,
        at,
      }]
    })
  }

  /** What the child said: plaintext as its message, an encrypted payload as only having been sent. */
  private static outgoingOf(text: string, at: number | null): SessionSubagentEntry {
    if (text.startsWith(CodexSubagentTranscript.encryptedPrefixConst)) return { kind: 'encrypted', at }
    return { kind: 'message', role: 'assistant', ...CodexSubagentTranscript.textCut(text), at }
  }

  /** One divider per compaction: Codex writes it as a `compacted` record and as an item. */
  private static compact(entries: SessionSubagentEntry[], at: number | null): void {
    if (entries.at(-1)?.kind !== 'compact') entries.push({ kind: 'compact', at })
  }

  private static partsTextOf(content: unknown): string {
    if (!Array.isArray(content)) return ''
    return content
      .flatMap((raw) => {
        const text = JsonShape.record(raw)?.text
        return typeof text === 'string' ? [text] : []
      })
      .join('')
      .trim()
  }

  private static argumentsOf(value: unknown): Record<string, unknown> | null {
    if (typeof value !== 'string') return null
    try { return JsonShape.record(JSON.parse(value)) }
    catch { return null }
  }

  /** Leading whitespace is kept: command output is often aligned columns. */
  private static outputOf(text: string): { text: string; truncated: boolean } | null {
    const output = text.replace(/\r\n/g, '\n').trimEnd()
    if (output.trim() === '' || output.trimStart().startsWith(CodexSubagentTranscript.encryptedPrefixConst)) return null
    return CodexSubagentTranscript.cut(output, ClaudeSubagentTranscript.outputCharactersConst)
  }

  private static firstLineOf(text: string): string | null {
    const line = text.split(/\r?\n/).find((one) => one.trim() !== '')
    return line === undefined ? null : SessionTasksSourceClaude.oneLine(line)
  }

  private static recordsOf(content: string): Record<string, unknown>[] {
    return JsonlRecords.of(content)
      .map((record) => JsonShape.record(record))
      .filter((record) => record !== null)
  }

  private static textCut(text: string): { text: string; truncated: boolean } {
    return CodexSubagentTranscript.cut(text.trim(), ClaudeSubagentTranscript.textCharactersConst)
  }

  private static cut(text: string, maximum: number): { text: string; truncated: boolean } {
    return text.length <= maximum ? { text, truncated: false } : { text: text.slice(0, maximum), truncated: true }
  }

  private static linesOf(value: string): string[] {
    if (value === '') return []
    return value.replace(/\r?\n$/, '').split(/\r?\n/)
  }

  private static text(value: unknown): string | null {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
  }

  private static timeOf(value: unknown): number | null {
    if (typeof value !== 'string') return null
    const time = Date.parse(value)
    return Number.isFinite(time) ? time : null
  }

  private static async head(ref: ProviderSubagentFileRef): Promise<string> {
    const length = Math.min(ref.size, CodexSubagentTranscript.headBytesConst)
    const handle = await open(ref.file, 'r')
    try {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, 0)
      return buffer.toString('utf8', 0, bytesRead)
    }
    finally { await handle.close() }
  }
}
