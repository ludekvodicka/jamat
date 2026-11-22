import { open } from 'node:fs/promises'

import type { ProviderSubagentFileRef } from '../../projectManager/providerTranscriptView'
import { BoundedMap } from '../../shared/boundedMap'
import { FileTail } from '../../shared/fileTail'
import { JsonShape } from '../../shared/jsonShape'
import { JsonlRecords } from '../../shared/jsonlRecords'
import { SessionTranscriptSourceAntigravity } from '../../sessionTranscriptReader/antigravity/sessionTranscriptSourceAntigravity'
import type {
  SessionSubagentRow,
  SessionSubagentState,
  SessionTaskParentState,
} from '../sessionTasksApi.types'

export interface AntigravitySubagentFacts {
  agentType: string
  description: string
  depth: 1 | 2
  parentSubagentId: string | null
  startedAt: number
  model: string | null
  step: string | null
  settled: { state: 'done' | 'failed'; at: number } | null
}

export type AntigravitySubagentMemo = Map<string, { key: string; facts: AntigravitySubagentFacts }>

/**
 * Antigravity sub-agents (`invoke_subagent`), each judged from its own child conversation
 * `transcript.jsonl` and its `conversation_summaries.db` thread metadata.
 */
export class SessionTasksSourceAntigravity {
  static readonly classifiedMaxConst = 60
  static readonly quietMillisecondsConst = 120_000
  private static readonly tailBytesConst = 65_536
  private static readonly headBytesConst = 8_192
  private static readonly stepCharactersConst = 160
  private static readonly readConcurrencyConst = 8

  async list(
    files: readonly ProviderSubagentFileRef[],
    parent: SessionTaskParentState,
    memo: AntigravitySubagentMemo,
  ): Promise<{ rows: SessionSubagentRow[]; unread: number }> {
    const newest = [...files]
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, SessionTasksSourceAntigravity.classifiedMaxConst)
    const kept = new Set(newest.map((ref) => ref.file))
    for (const file of memo.keys())
      if (!kept.has(file)) memo.delete(file)
    const rows = await BoundedMap.run(newest, SessionTasksSourceAntigravity.readConcurrencyConst, async (ref) => {
      const facts = await SessionTasksSourceAntigravity.factsOf(ref, memo)
      return facts === null ? null : SessionTasksSourceAntigravity.rowOf(ref, facts, parent)
    })
    return {
      rows: rows.filter((row) => row !== null),
      unread: files.length - newest.length,
    }
  }

  static rowOf(
    ref: ProviderSubagentFileRef,
    facts: AntigravitySubagentFacts,
    parent: SessionTaskParentState,
  ): SessionSubagentRow {
    const state = SessionTasksSourceAntigravity.stateOf(facts.settled?.state ?? null, parent, ref.mtimeMs)
    return {
      kind: 'subagent',
      subagentId: ref.subagentId,
      agentType: facts.agentType,
      description: facts.description,
      depth: facts.depth,
      parentSubagentId: facts.parentSubagentId,
      state,
      startedAt: facts.startedAt,
      endedAt: state === 'running' ? null : (facts.settled?.at ?? ref.mtimeMs),
      model: facts.model,
      step: state === 'running' ? facts.step : null,
    }
  }

  static stateOf(
    settled: 'done' | 'failed' | null,
    parent: SessionTaskParentState,
    mtimeMs: number,
  ): SessionSubagentState {
    if (settled !== null) return settled
    if (!parent.live) return 'unfinished'
    if (parent.busy) return 'running'
    return parent.now - mtimeMs <= SessionTasksSourceAntigravity.quietMillisecondsConst ? 'running' : 'unfinished'
  }

  private static async factsOf(
    ref: ProviderSubagentFileRef,
    memo: AntigravitySubagentMemo,
  ): Promise<AntigravitySubagentFacts | null> {
    const key = `${ref.mtimeMs}:${ref.size}`
    const cached = memo.get(ref.file)
    if (cached?.key === key) return cached.facts
    try {
      const [head, tail] = await Promise.all([
        SessionTasksSourceAntigravity.readHead(ref.file),
        FileTail.readBounded(ref.file, ref.size, SessionTasksSourceAntigravity.tailBytesConst),
      ])
      const headRecords = SessionTasksSourceAntigravity.recordsOf(head)
      const tailRecords = SessionTasksSourceAntigravity.recordsOf(tail.content)
      const prompt = headRecords
        .filter((row) => row['type'] === 'USER_INPUT')
        .map((row) => SessionTranscriptSourceAntigravity.extractUserText(row['content']))
        .find((text) => text !== null) ?? null
      const startedAt = ref.thread?.startedAt
        || SessionTasksSourceAntigravity.timeOf(headRecords[0]?.['created_at'])
        || ref.mtimeMs
      let model: string | null = null
      let step: string | null = null
      let settled: { state: 'done' | 'failed'; at: number } | null = null
      for (const row of tailRecords) {
        if (row['type'] !== 'PLANNER_RESPONSE') continue
        if (typeof row['model'] === 'string' && row['model'].length > 0) model = row['model']
        const at = SessionTasksSourceAntigravity.timeOf(row['created_at']) ?? ref.mtimeMs
        const toolCalls = Array.isArray(row['tool_calls']) ? row['tool_calls'] : []
        if (toolCalls.length > 0) {
          const last = JsonShape.record(toolCalls.at(-1))
          step = last ? SessionTasksSourceAntigravity.toolSummaryOf(last) : step
          settled = null
        }
        else if (typeof row['content'] === 'string' && row['content'].trim().length > 0 && row['status'] === 'DONE') {
          settled = { state: 'done', at }
        }
      }
      const facts: AntigravitySubagentFacts = {
        agentType: ref.thread?.nickname || 'subagent',
        description: SessionTasksSourceAntigravity.oneLine(prompt ?? ref.thread?.nickname ?? ref.subagentId),
        depth: ref.thread?.depth ?? 1,
        parentSubagentId: ref.thread?.parentSubagentId ?? null,
        startedAt,
        model,
        step,
        settled,
      }
      memo.set(ref.file, { key, facts })
      return facts
    }
    catch { return null }
  }

  private static async readHead(file: string): Promise<string> {
    const handle = await open(file, 'r')
    try {
      const buffer = Buffer.alloc(SessionTasksSourceAntigravity.headBytesConst)
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

  static toolSummaryOf(call: Record<string, unknown>): string {
    const name = typeof call['name'] === 'string' ? call['name'] : 'tool'
    const args = JsonShape.record(call['args'])
    const detail = args
      ? (SessionTasksSourceAntigravity.unquote(args['toolSummary'])
        ?? SessionTasksSourceAntigravity.unquote(args['Path'])
        ?? SessionTasksSourceAntigravity.unquote(args['CommandLine'])
        ?? SessionTasksSourceAntigravity.unquote(args['Role'])
        ?? SessionTasksSourceAntigravity.unquote(args['query']))
      : null
    return SessionTasksSourceAntigravity.oneLine(detail ? `${name} ${detail}` : name)
  }

  private static unquote(value: unknown): string | null {
    if (typeof value !== 'string') return null
    let text = value.trim()
    if (text.length >= 2 && text.startsWith('"') && text.endsWith('"'))
      try {
        const parsed = JSON.parse(text)
        if (typeof parsed === 'string') text = parsed.trim()
      }
      catch { /* raw */ }
    return text.length > 0 ? text : null
  }

  private static timeOf(value: unknown): number | null {
    if (typeof value !== 'string') return null
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }

  static oneLine(text: string): string {
    const flat = text.replace(/\s+/g, ' ').trim()
    return flat.length <= SessionTasksSourceAntigravity.stepCharactersConst
      ? flat
      : `${flat.slice(0, SessionTasksSourceAntigravity.stepCharactersConst - 1)}…`
  }
}
