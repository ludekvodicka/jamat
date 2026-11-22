import { open } from 'node:fs/promises'

import type { ProviderSubagentFileRef } from '../../projectManager/providerTranscriptView'
import { ErrorText } from '../../shared/errorText'
import { FileTail } from '../../shared/fileTail'
import { JsonShape } from '../../shared/jsonShape'
import { JsonlRecords } from '../../shared/jsonlRecords'
import { SessionTranscriptSourceAntigravity } from '../../sessionTranscriptReader/antigravity/sessionTranscriptSourceAntigravity'
import type {
  SessionSubagentEntry,
  SessionSubagentTranscript,
  SessionTaskParentState,
} from '../sessionTasksApi.types'
import { SessionTasksSourceAntigravity } from './sessionTasksSourceAntigravity'

interface AntigravitySubagentReading {
  revision: string
  agentType: string
  description: string
  model: string | null
  contextTokens: number | null
  settled: 'done' | 'failed' | null
  entries: readonly SessionSubagentEntry[]
  earlierStepsOmitted: boolean
}

/**
 * Reads one Antigravity sub-agent's child `transcript.jsonl` into bounded entries for the split
 * task viewer.
 */
export class AntigravitySubagentTranscript {
  static readonly headBytesConst = 65_536
  static readonly tailBytesConst = 2_097_152
  static readonly textCharactersConst = 4_000
  static readonly outputCharactersConst = 2_000
  private static readonly cachedMaxConst = 16

  private readonly cache = new Map<string, AntigravitySubagentReading>()

  async read(
    ref: ProviderSubagentFileRef,
    parent: SessionTaskParentState,
    known: string | null,
  ): Promise<SessionSubagentTranscript> {
    const revision = `${ref.mtimeMs}:${ref.size}`
    if (known === revision) return { kind: 'unchanged', revision }
    let reading = this.cache.get(ref.file)
    if (reading?.revision !== revision)
      try { reading = await AntigravitySubagentTranscript.readingOf(ref, revision) }
      catch (error) {
        this.cache.delete(ref.file)
        return { kind: 'none', code: 'unreadable', reason: `sub-agent transcript unreadable: ${ErrorText.of(error)}` }
      }
    this.cache.delete(ref.file)
    this.cache.set(ref.file, reading)
    while (this.cache.size > AntigravitySubagentTranscript.cachedMaxConst)
      this.cache.delete(this.cache.keys().next().value!)
    return {
      kind: 'transcript',
      revision,
      header: {
        agentType: reading.agentType,
        description: reading.description,
        model: reading.model,
        state: SessionTasksSourceAntigravity.stateOf(reading.settled, parent, ref.mtimeMs),
        contextTokens: reading.contextTokens,
      },
      entries: reading.entries,
      earlierStepsOmitted: reading.earlierStepsOmitted,
    }
  }

  private static async readingOf(ref: ProviderSubagentFileRef, revision: string): Promise<AntigravitySubagentReading> {
    const tail = await FileTail.readBounded(ref.file, ref.size, AntigravitySubagentTranscript.tailBytesConst)
    const records = AntigravitySubagentTranscript.recordsOf(tail.content)
    let promptText: string | null = null
    let walked: readonly Record<string, unknown>[]
    if (tail.startedAtFileBeginning) {
      const index = records.findIndex((row) => row['type'] === 'USER_INPUT'
        && SessionTranscriptSourceAntigravity.extractUserText(row['content']) !== null)
      if (index >= 0) {
        promptText = SessionTranscriptSourceAntigravity.extractUserText(records[index]!['content'])
        walked = records.slice(index + 1)
      }
      else walked = records
    }
    else {
      const headRecords = AntigravitySubagentTranscript.recordsOf(await AntigravitySubagentTranscript.readHead(ref.file))
      const first = headRecords.find((row) => row['type'] === 'USER_INPUT'
        && SessionTranscriptSourceAntigravity.extractUserText(row['content']) !== null)
      promptText = first ? SessionTranscriptSourceAntigravity.extractUserText(first['content']) : null
      walked = records
    }
    const entries: SessionSubagentEntry[] = []
    if (promptText !== null) {
      const cut = AntigravitySubagentTranscript.cut(promptText, AntigravitySubagentTranscript.textCharactersConst)
      entries.push({ kind: 'prompt', text: cut.text, truncated: cut.truncated })
    }
    let model: string | null = null
    let contextTokens: number | null = null
    let settled: 'done' | 'failed' | null = null
    const pendingToolIndices: number[] = []
    for (const row of walked) {
      const type = row['type']
      const at = AntigravitySubagentTranscript.timeOf(row['created_at'])
      if (type === 'USER_INPUT') {
        const text = SessionTranscriptSourceAntigravity.extractUserText(row['content'])
        if (text !== null) {
          const cut = AntigravitySubagentTranscript.cut(text, AntigravitySubagentTranscript.textCharactersConst)
          entries.push({ kind: 'message', role: 'user', text: cut.text, truncated: cut.truncated, at })
        }
      }
      else if (type === 'PLANNER_RESPONSE') {
        if (typeof row['model'] === 'string' && row['model'].length > 0) model = row['model']
        const input = typeof row['input_tokens'] === 'number' ? row['input_tokens'] : 0
        const cached = typeof row['cache_read_tokens'] === 'number' ? row['cache_read_tokens'] : 0
        if (input + cached > 0) contextTokens = input + cached
        if (typeof row['thinking'] === 'string' && row['thinking'].trim().length > 0)
          entries.push({ kind: 'thinking', at })
        const toolCalls = Array.isArray(row['tool_calls']) ? row['tool_calls'] : []
        pendingToolIndices.length = 0
        for (const item of toolCalls) {
          const call = JsonShape.record(item)
          if (call === null) continue
          const name = typeof call['name'] === 'string' ? call['name'] : 'tool'
          const index = entries.push({
            kind: 'tool',
            tool: name,
            summary: SessionTasksSourceAntigravity.toolSummaryOf(call),
            output: null,
            outputTruncated: false,
            failed: false,
            at,
          }) - 1
          pendingToolIndices.push(index)
        }
        const text = typeof row['content'] === 'string' ? row['content'].trim() : ''
        if (text.length > 0) {
          const cut = AntigravitySubagentTranscript.cut(text, AntigravitySubagentTranscript.textCharactersConst)
          entries.push({ kind: 'message', role: 'assistant', text: cut.text, truncated: cut.truncated, at })
        }
        if (toolCalls.length > 0) settled = null
        else if (text.length > 0 && row['status'] === 'DONE') settled = 'done'
      }
      else if (type === 'GENERIC' && typeof row['content'] === 'string') {
        const targetIndex = pendingToolIndices.shift()
        if (targetIndex !== undefined) {
          const entry = entries[targetIndex]
          if (entry && entry.kind === 'tool') {
            const cut = AntigravitySubagentTranscript.cut(row['content'].trim(), AntigravitySubagentTranscript.outputCharactersConst)
            entries[targetIndex] = {
              ...entry,
              output: cut.text.length > 0 ? cut.text : null,
              outputTruncated: cut.truncated,
              failed: /Command exited with code [1-9]|Encountered error/i.test(row['content']),
            }
          }
        }
      }
    }
    return {
      revision,
      agentType: ref.thread?.nickname || 'subagent',
      description: SessionTasksSourceAntigravity.oneLine(promptText ?? ref.thread?.nickname ?? ref.subagentId),
      model,
      contextTokens,
      settled,
      entries,
      earlierStepsOmitted: !tail.startedAtFileBeginning,
    }
  }

  private static async readHead(file: string): Promise<string> {
    const handle = await open(file, 'r')
    try {
      const buffer = Buffer.alloc(AntigravitySubagentTranscript.headBytesConst)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      return buffer.subarray(0, bytesRead).toString('utf8')
    }
    finally { await handle.close() }
  }

  private static recordsOf(content: string): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = []
    for (const raw of JsonlRecords.of(content)) {
      const row = JsonShape.record(raw)
      if (row !== null) out.push(row)
    }
    return out
  }

  private static cut(text: string, max: number): { text: string; truncated: boolean } {
    return text.length <= max ? { text, truncated: false } : { text: text.slice(0, max), truncated: true }
  }

  private static timeOf(value: unknown): number | null {
    if (typeof value !== 'string') return null
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
}
