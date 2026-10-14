import { open, readFile } from 'node:fs/promises'

import type { ProviderSubagentFileRef } from '../../projectManager/providerTranscriptView'
import { ErrorText } from '../../shared/errorText'
import { FileTail } from '../../shared/fileTail'
import { JsonShape } from '../../shared/jsonShape'
import { JsonlRecords } from '../../shared/jsonlRecords'
import type {
  SessionSubagentEntry,
  SessionSubagentTranscript,
  SessionTaskParentState,
} from '../sessionTasksApi.types'
import { type ClaudeSubagentFacts, SessionTasksSourceClaude } from './sessionTasksSourceClaude'

/** What one file says under one revision; the state is composed per call, because it moves with the clock. */
interface ClaudeSubagentReading {
  revision: string
  agentType: string
  description: string
  model: string | null
  contextTokens: number | null
  settled: NonNullable<ClaudeSubagentFacts['settled']>['state'] | null
  entries: readonly SessionSubagentEntry[]
  earlierStepsOmitted: boolean
}

interface PendingToolUse {
  index: number
  name: string
  input: Record<string, unknown> | null
  at: number | null
}

/**
 * The steps of one Claude Code sub-agent, from its own `agent-<id>.jsonl`: the prompt from the first
 * 64 KiB, the rest from the last 2 MiB. A file edit counts only once a result that is not an error
 * confirmed it; until then, and when it failed, it is a tool call.
 *
 * Its cache is its own, one reading per file under its `mtimeMs:size`, and shares no entry with the
 * listing's. Never throws for a file: a failed read answers `none`.
 */
export class ClaudeSubagentTranscript {
  static readonly headBytesConst = 65_536
  static readonly tailBytesConst = 2_097_152
  static readonly textCharactersConst = 4_000
  static readonly outputCharactersConst = 2_000
  static readonly previewLinesConst = 20
  private static readonly cachedMaxConst = 16
  private static readonly editToolsConst: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit'])

  private readonly cache = new Map<string, ClaudeSubagentReading>()

  static revisionOf(ref: ProviderSubagentFileRef): string {
    return `${ref.mtimeMs}:${ref.size}`
  }

  async read(
    ref: ProviderSubagentFileRef,
    parent: SessionTaskParentState,
    known: string | null,
  ): Promise<SessionSubagentTranscript> {
    const revision = ClaudeSubagentTranscript.revisionOf(ref)
    if (known === revision) return { kind: 'unchanged', revision }
    let reading = this.cache.get(ref.file)
    if (reading?.revision !== revision)
      try { reading = await ClaudeSubagentTranscript.readingOf(ref, revision) }
      catch (error) {
        this.cache.delete(ref.file)
        return { kind: 'none', code: 'unreadable', reason: `sub-agent transcript unreadable: ${ErrorText.of(error)}` }
      }
    // Delete then set: the map's own order is the LRU order.
    this.cache.delete(ref.file)
    this.cache.set(ref.file, reading)
    while (this.cache.size > ClaudeSubagentTranscript.cachedMaxConst)
      this.cache.delete(this.cache.keys().next().value!)
    return {
      kind: 'transcript',
      revision,
      header: {
        agentType: reading.agentType,
        description: reading.description,
        model: reading.model,
        state: SessionTasksSourceClaude.stateOf(reading.settled, parent, ref.mtimeMs),
        contextTokens: reading.contextTokens,
      },
      entries: reading.entries,
      earlierStepsOmitted: reading.earlierStepsOmitted,
    }
  }

  /** Records of the tail in file order, the prompt taken from the head when the tail began past it. */
  static async readingOf(ref: ProviderSubagentFileRef, revision: string): Promise<ClaudeSubagentReading> {
    const tail = await FileTail.readBounded(ref.file, ref.size, ClaudeSubagentTranscript.tailBytesConst)
    const records = ClaudeSubagentTranscript.recordsOf(tail.content)
    let prompt: { text: string; truncated: boolean } | null
    let walked: readonly Record<string, unknown>[]
    if (tail.startedAtFileBeginning) {
      const index = records.findIndex((record) => ClaudeSubagentTranscript.promptTextOf(record) !== null)
      prompt = index < 0 ? null : ClaudeSubagentTranscript.cut(
        ClaudeSubagentTranscript.promptTextOf(records[index])!,
        ClaudeSubagentTranscript.textCharactersConst,
      )
      walked = index < 0 ? records : records.slice(index + 1)
    }
    else {
      prompt = ClaudeSubagentTranscript.promptOfHead(await ClaudeSubagentTranscript.head(ref))
      walked = records
    }
    const meta = ref.metaFile === null ? null : await ClaudeSubagentTranscript.meta(ref.metaFile)
    const entries = ClaudeSubagentTranscript.entriesOf(walked)
    const promptLine = prompt?.text.split(/\r?\n/).find((line) => line.trim() !== '')
    return {
      revision,
      agentType: ref.workflowId !== null
        ? 'workflow'
        : ClaudeSubagentTranscript.text(meta?.agentType) ?? 'agent',
      description: ClaudeSubagentTranscript.text(meta?.description)
        ?? (promptLine === undefined ? '' : SessionTasksSourceClaude.oneLine(promptLine)),
      model: ClaudeSubagentTranscript.modelOf(records, meta?.model),
      contextTokens: ClaudeSubagentTranscript.contextTokensOf(records),
      settled: SessionTasksSourceClaude.settledOf(records)?.state ?? null,
      entries: prompt === null ? entries : [{ kind: 'prompt', ...prompt }, ...entries],
      earlierStepsOmitted: !tail.startedAtFileBeginning,
    }
  }

  /** The S1 entries of the records after the prompt, in file order. */
  static entriesOf(records: readonly Record<string, unknown>[]): SessionSubagentEntry[] {
    const entries: SessionSubagentEntry[] = []
    const pending = new Map<string, PendingToolUse>()
    for (const record of records) {
      if (record.isMeta === true || record.isCompactSummary === true) continue
      const at = ClaudeSubagentTranscript.timeOf(record.timestamp)
      const content = JsonShape.record(record.message)?.content
      switch (record.type) {
        case 'assistant':
          ClaudeSubagentTranscript.assistantEntries(record, content, at, entries, pending)
          break
        case 'user':
          ClaudeSubagentTranscript.userEntries(record, content, at, entries, pending)
          break
        case 'system':
          if (record.subtype === 'compact_boundary') entries.push({ kind: 'compact', at })
          break
        case 'attachment': {
          const attachment = JsonShape.record(record.attachment)
          if (attachment?.type === 'queued_command' && typeof attachment.prompt === 'string'
            && attachment.prompt.trim() !== '')
            entries.push({ kind: 'message', role: 'user', ...ClaudeSubagentTranscript.textCut(attachment.prompt), at })
          break
        }
        default:
          break
      }
    }
    return entries
  }

  private static assistantEntries(
    record: Record<string, unknown>,
    content: unknown,
    at: number | null,
    entries: SessionSubagentEntry[],
    pending: Map<string, PendingToolUse>,
  ): void {
    if (record.isApiErrorMessage === true) {
      entries.push({ kind: 'error', text: ClaudeSubagentTranscript.textBlocksOf(content) || 'API error', at })
      return
    }
    if (!Array.isArray(content)) return
    for (const raw of content) {
      const block = JsonShape.record(raw)
      switch (block?.type) {
        case 'text':
          if (typeof block.text === 'string' && block.text.trim() !== '')
            entries.push({ kind: 'message', role: 'assistant', ...ClaudeSubagentTranscript.textCut(block.text), at })
          break
        case 'thinking': case 'redacted_thinking':
          if (entries.at(-1)?.kind !== 'thinking') entries.push({ kind: 'thinking', at })
          break
        case 'tool_use': {
          if (typeof block.name !== 'string') break
          const input = JsonShape.record(block.input)
          if (typeof block.id === 'string')
            pending.set(block.id, { index: entries.length, name: block.name, input, at })
          entries.push(ClaudeSubagentTranscript.toolEntry(block.name, input, null, false, at))
          break
        }
        default:
          break
      }
    }
  }

  private static userEntries(
    record: Record<string, unknown>,
    content: unknown,
    at: number | null,
    entries: SessionSubagentEntry[],
    pending: Map<string, PendingToolUse>,
  ): void {
    const results = Array.isArray(content)
      ? content.map((raw) => JsonShape.record(raw)).filter((block): block is Record<string, unknown> => block?.type === 'tool_result')
      : []
    if (results.length > 0) {
      const patch = results.length === 1 ? JsonShape.record(record.toolUseResult)?.structuredPatch : undefined
      for (const result of results) {
        if (typeof result.tool_use_id !== 'string') continue
        const use = pending.get(result.tool_use_id)
        if (use === undefined) continue
        pending.delete(result.tool_use_id)
        const failed = result.is_error === true
        const edit = failed || !ClaudeSubagentTranscript.editToolsConst.has(use.name)
          ? null
          : ClaudeSubagentTranscript.editEntry(use, patch)
        entries[use.index] = edit ?? ClaudeSubagentTranscript.toolEntry(
          use.name,
          use.input,
          ClaudeSubagentTranscript.outputOf(result.content),
          failed,
          use.at,
        )
      }
      return
    }
    const text = ClaudeSubagentTranscript.textOf(content)
    if (text === null) return
    if (text.startsWith(SessionTasksSourceClaude.interruptMarkerConst))
      entries.push({ kind: 'interrupted', at })
    else
      entries.push({ kind: 'message', role: 'user', ...ClaudeSubagentTranscript.textCut(text), at })
  }

  private static toolEntry(
    tool: string,
    input: Record<string, unknown> | null,
    output: string | null,
    failed: boolean,
    at: number | null,
  ): SessionSubagentEntry {
    const summary = SessionTasksSourceClaude.summaryOf(tool, input)
    const cut = output === null ? null : ClaudeSubagentTranscript.cut(output, ClaudeSubagentTranscript.outputCharactersConst)
    return {
      kind: 'tool',
      tool,
      summary: summary === null ? '' : SessionTasksSourceClaude.oneLine(summary),
      output: cut?.text ?? null,
      outputTruncated: cut?.truncated ?? false,
      failed,
      at,
    }
  }

  /**
   * Counts from the patch Claude Code recorded with the result when there is one, else from the
   * call's own input: an Edit's old and new strings, a Write's whole content as added.
   */
  private static editEntry(use: PendingToolUse, patch: unknown): SessionSubagentEntry | null {
    const path = ClaudeSubagentTranscript.text(use.input?.file_path)
    if (path === null) return null
    let lines: string[]
    if (Array.isArray(patch) && patch.length > 0)
      lines = patch.flatMap((hunk) => {
        const hunkLines = JsonShape.record(hunk)?.lines
        return Array.isArray(hunkLines) ? hunkLines.filter((line) => typeof line === 'string') : []
      })
    else if (use.name === 'Write')
      lines = ClaudeSubagentTranscript.linesOf(use.input?.content).map((line) => `+${line}`)
    else {
      const edits = use.name === 'MultiEdit' && Array.isArray(use.input?.edits)
        ? use.input.edits.map((one) => JsonShape.record(one))
        : [use.input]
      lines = edits.flatMap((one) => [
        ...ClaudeSubagentTranscript.linesOf(one?.old_string).map((line) => `-${line}`),
        ...ClaudeSubagentTranscript.linesOf(one?.new_string).map((line) => `+${line}`),
      ])
    }
    return {
      kind: 'edit',
      path,
      added: lines.filter((line) => line.startsWith('+')).length,
      removed: lines.filter((line) => line.startsWith('-')).length,
      preview: ClaudeSubagentTranscript.cut(
        lines.slice(0, ClaudeSubagentTranscript.previewLinesConst).join('\n'),
        ClaudeSubagentTranscript.outputCharactersConst,
      ).text,
      at: use.at,
    }
  }

  /** The prompt is the first `user` text; a fork's inherited context before it is not the agent's own. */
  private static promptTextOf(record: Record<string, unknown>): string | null {
    if (record.type !== 'user' || record.isMeta === true) return null
    return ClaudeSubagentTranscript.textOf(JsonShape.record(record.message)?.content)
  }

  /**
   * The first record often holds a prompt longer than the head, so a cut first line still gives
   * the start of its `content` string.
   */
  private static promptOfHead(head: string): { text: string; truncated: boolean } | null {
    const lines = head.split('\n')
    const complete = lines.slice(0, -1)
    for (const record of ClaudeSubagentTranscript.recordsOf(complete.join('\n'))) {
      const text = ClaudeSubagentTranscript.promptTextOf(record)
      if (text !== null) return ClaudeSubagentTranscript.cut(text, ClaudeSubagentTranscript.textCharactersConst)
    }
    if (complete.length > 0) return null
    const cutContent = /"content":"((?:[^"\\]|\\.)*)/.exec(lines[0])?.[1]
    if (cutContent === undefined) return null
    let text: string
    try { text = JSON.parse(`"${cutContent}"`) as string }
    catch { return null }
    return { ...ClaudeSubagentTranscript.cut(text, ClaudeSubagentTranscript.textCharactersConst), truncated: true }
  }

  private static modelOf(records: readonly Record<string, unknown>[], metaModel: unknown): string | null {
    for (let index = records.length - 1; index >= 0; index -= 1) {
      if (records[index].type !== 'assistant') continue
      const model = ClaudeSubagentTranscript.text(JsonShape.record(records[index].message)?.model)
      if (model !== null && model !== '<synthetic>') return model
    }
    const fromMeta = ClaudeSubagentTranscript.text(metaModel)
    return fromMeta === 'inherit' ? null : fromMeta
  }

  private static contextTokensOf(records: readonly Record<string, unknown>[]): number | null {
    for (let index = records.length - 1; index >= 0; index -= 1) {
      if (records[index].type !== 'assistant' || records[index].isApiErrorMessage === true) continue
      const usage = JsonShape.record(JsonShape.record(records[index].message)?.usage)
      if (usage === null || typeof usage.input_tokens !== 'number') continue
      return usage.input_tokens
        + ClaudeSubagentTranscript.count(usage.cache_read_input_tokens)
        + ClaudeSubagentTranscript.count(usage.cache_creation_input_tokens)
    }
    return null
  }

  private static recordsOf(content: string): Record<string, unknown>[] {
    return JsonlRecords.of(content)
      .map((record) => JsonShape.record(record))
      .filter((record) => record !== null)
  }

  /** A string, or the text blocks of a block list joined; null when nothing is said. */
  private static textOf(content: unknown): string | null {
    const text = typeof content === 'string' ? content.trim() : ClaudeSubagentTranscript.textBlocksOf(content)
    return text === '' ? null : text
  }

  /** Leading whitespace is kept: tool output is often aligned columns. */
  private static outputOf(content: unknown): string | null {
    const parts = typeof content === 'string'
      ? [content]
      : Array.isArray(content)
        ? content.flatMap((raw) => {
          const block = JsonShape.record(raw)
          return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []
        })
        : []
    const text = parts.join('\n').trimEnd()
    return text.trim() === '' ? null : text
  }

  private static textBlocksOf(content: unknown): string {
    if (!Array.isArray(content)) return ''
    return content
      .flatMap((raw) => {
        const block = JsonShape.record(raw)
        return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []
      })
      .join('\n')
      .trim()
  }

  private static textCut(text: string): { text: string; truncated: boolean } {
    return ClaudeSubagentTranscript.cut(text.trim(), ClaudeSubagentTranscript.textCharactersConst)
  }

  private static cut(text: string, maximum: number): { text: string; truncated: boolean } {
    return text.length <= maximum ? { text, truncated: false } : { text: text.slice(0, maximum), truncated: true }
  }

  private static linesOf(value: unknown): string[] {
    if (typeof value !== 'string' || value === '') return []
    return value.replace(/\r?\n$/, '').split(/\r?\n/)
  }

  private static count(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
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
    const length = Math.min(ref.size, ClaudeSubagentTranscript.headBytesConst)
    const handle = await open(ref.file, 'r')
    try {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, 0)
      return buffer.toString('utf8', 0, bytesRead)
    }
    finally { await handle.close() }
  }

  private static async meta(metaFile: string): Promise<Record<string, unknown> | null> {
    try { return JsonShape.record(JSON.parse(await readFile(metaFile, 'utf8'))) }
    catch { return null }
  }
}
