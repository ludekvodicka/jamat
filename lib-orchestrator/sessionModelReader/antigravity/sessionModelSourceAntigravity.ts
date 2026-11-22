import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { ProviderTranscriptRef } from '../../projectManager/providerTranscriptView'
import { ErrorText } from '../../shared/errorText'
import { FileTail } from '../../shared/fileTail'
import { JsonNumber } from '../../shared/jsonNumber'
import { JsonShape } from '../../shared/jsonShape'
import { JsonlRecords } from '../../shared/jsonlRecords'
import type { SessionModelReading } from '../sessionModelReaderApi.types'
import { type SessionModelContext, SessionModelSource } from '../sessionModelSource'

interface AntigravityTurn {
  model: string
  tokens: number
}

interface AntigravityContextSnapshot {
  model: string | null
  displayName: string | null
  effort: string | null
  contextWindowSize: number | null
  usedPercentage: number | null
}

/**
 * Model, effort and context usage for one Antigravity (`agy`) session, read from
 * `<home>/brain/<conversationId>/.system_generated/logs/transcript.jsonl` and enriched with the
 * live status line snapshot written by `AntigravityStatusLine` when present.
 */
export class SessionModelSourceAntigravity extends SessionModelSource {
  private static readonly firstPassBytesConst = 262_144
  private static readonly secondPassBytesConst = 1_048_576
  private static readonly snapshotBytesConst = 4096
  private static readonly sessionIdConst = /^[0-9A-Za-z-]{1,64}$/
  private static readonly effortSuffixConst = /^(.+)-(low|medium|high|xhigh|max)$/i

  readonly agentId = 'antigravity' as const

  private readonly snapshots: string | null

  constructor(snapshots?: string | null) {
    super()
    this.snapshots = snapshots ?? null
  }

  override async cacheSaltOf(context: SessionModelContext): Promise<string> {
    return JSON.stringify([
      context.launchModel,
      await this.snapshotOf(context.nativeSessionId),
    ])
  }

  /** Reads a live session snapshot (`session-<sessionId>.json`) written before `conversation_id` exists. */
  async readSessionSnapshot(sessionId: string): Promise<SessionModelReading> {
    if (this.snapshots === null || !SessionModelSourceAntigravity.sessionIdConst.test(sessionId))
      return { kind: 'none', reason: 'no antigravity session snapshot' }
    const snapshot = await this.snapshotFileOf(`session-${sessionId}.json`)
    if (snapshot === null || (snapshot.model === null && snapshot.displayName === null))
      return { kind: 'none', reason: 'no antigravity session snapshot' }
    return { kind: 'ok', info: SessionModelSourceAntigravity.infoFromSnapshot(snapshot) }
  }

  async read(
    ref: ProviderTranscriptRef,
    context: SessionModelContext,
  ): Promise<SessionModelReading> {
    let turn: AntigravityTurn | null
    try {
      turn = SessionModelSourceAntigravity.scan(
        await FileTail.read(ref.file, ref.size, SessionModelSourceAntigravity.firstPassBytesConst),
      )
      if (turn === null && ref.size > SessionModelSourceAntigravity.firstPassBytesConst)
        turn = SessionModelSourceAntigravity.scan(
          await FileTail.read(ref.file, ref.size, SessionModelSourceAntigravity.secondPassBytesConst),
        )
    }
    catch (error) {
      return { kind: 'none', reason: `transcript unreadable: ${ErrorText.of(error)}` }
    }
    const snapshot = await this.snapshotOf(context.nativeSessionId)
    if (turn === null) {
      if (snapshot !== null && (snapshot.model !== null || snapshot.displayName !== null))
        return { kind: 'ok', info: SessionModelSourceAntigravity.infoFromSnapshot(snapshot) }
      return { kind: 'none', reason: 'no planner response in the transcript tail' }
    }
    const { baseModel, effortLevel } = SessionModelSourceAntigravity.splitEffort(turn.model)
    const snapshotMatches = snapshot !== null && SessionModelSourceAntigravity.modelMatches(snapshot.model, turn.model, baseModel)
    const liveSwitched = snapshot !== null && !snapshotMatches && (snapshot.model !== null || snapshot.displayName !== null)
    if (liveSwitched) {
      const switched = SessionModelSourceAntigravity.infoFromSnapshot(snapshot)
      return {
        kind: 'ok',
        info: {
          ...switched,
          contextTokens: turn.tokens > 0 ? turn.tokens : switched.contextTokens,
        },
      }
    }
    return {
      kind: 'ok',
      info: {
        model: turn.model,
        modelLabel: (snapshotMatches && snapshot.displayName !== null)
          ? snapshot.displayName
          : SessionModelSourceAntigravity.labelOf(baseModel),
        effortLevel: (snapshotMatches && snapshot.effort !== null) ? snapshot.effort : effortLevel,
        contextTokens: turn.tokens,
        contextWindow: snapshotMatches ? snapshot.contextWindowSize : null,
      },
    }
  }

  private static infoFromSnapshot(snapshot: AntigravityContextSnapshot): {
    model: string
    modelLabel: string
    effortLevel: string | null
    contextTokens: number
    contextWindow: number | null
  } {
    const model = snapshot.model ?? snapshot.displayName!
    const { baseModel, effortLevel } = SessionModelSourceAntigravity.splitEffort(model)
    const contextTokens = snapshot.contextWindowSize !== null && snapshot.usedPercentage !== null
      ? Math.round((snapshot.contextWindowSize * Math.max(0, Math.min(100, snapshot.usedPercentage))) / 100)
      : 0
    return {
      model,
      modelLabel: snapshot.displayName ?? SessionModelSourceAntigravity.labelOf(baseModel),
      effortLevel: snapshot.effort ?? effortLevel,
      contextTokens,
      contextWindow: snapshot.contextWindowSize,
    }
  }

  private async snapshotOf(nativeSessionId: string): Promise<AntigravityContextSnapshot | null> {
    if (this.snapshots === null || !SessionModelSourceAntigravity.sessionIdConst.test(nativeSessionId)) return null
    return this.snapshotFileOf(`${nativeSessionId}.json`)
  }

  private async snapshotFileOf(filename: string): Promise<AntigravityContextSnapshot | null> {
    if (this.snapshots === null) return null
    let parsed: unknown
    try {
      const text = await readFile(join(this.snapshots, filename), 'utf8')
      if (text.length > SessionModelSourceAntigravity.snapshotBytesConst) return null
      parsed = JSON.parse(text)
    }
    catch {
      return null
    }
    const record = JsonShape.record(parsed)
    if (record?.['schemaVersion'] !== 1) return null
    const model = SessionModelSource.nonEmptyString(record['model'])
    const displayName = SessionModelSource.nonEmptyString(record['displayName'])
    const effort = SessionModelSource.nonEmptyString(record['effort'])?.toLowerCase() ?? null
    const size = JsonNumber.positiveInteger(record['contextWindowSize'])
    const usedPercentage = typeof record['usedPercentage'] === 'number' && Number.isFinite(record['usedPercentage'])
      ? record['usedPercentage']
      : null
    return { model, displayName, effort, contextWindowSize: size, usedPercentage }
  }

  private static scan(content: string): AntigravityTurn | null {
    const records = JsonlRecords.of(content)
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = JsonShape.record(records[index])
      if (record === null || record['type'] !== 'PLANNER_RESPONSE') continue
      const model = SessionModelSource.nonEmptyString(record['model'])
      if (model === null) continue
      const inputTokens = JsonNumber.wholeCount(record['input_tokens'])
      const cacheReadTokens = JsonNumber.wholeCount(record['cache_read_tokens']) ?? 0
      if (inputTokens === null) continue
      return { model, tokens: inputTokens + cacheReadTokens }
    }
    return null
  }

  private static splitEffort(model: string): { baseModel: string; effortLevel: string | null } {
    const match = SessionModelSourceAntigravity.effortSuffixConst.exec(model)
    if (match === null) return { baseModel: model, effortLevel: null }
    return { baseModel: match[1]!, effortLevel: match[2]!.toLowerCase() }
  }

  private static modelMatches(snapshotModel: string | null, turnModel: string, baseModel: string): boolean {
    if (snapshotModel === null || snapshotModel === turnModel || snapshotModel === baseModel) return true
    const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '')
    const normSnapshot = normalize(snapshotModel)
    const normTurn = normalize(turnModel)
    const normBase = normalize(baseModel)
    return normSnapshot.length > 0 && (normSnapshot === normTurn || normSnapshot === normBase || normSnapshot.startsWith(normBase))
  }

  private static labelOf(model: string): string {
    return model
      .split('-')
      .filter(Boolean)
      .map((part) => /^\d/.test(part) ? part : `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
      .join(' ')
  }
}
