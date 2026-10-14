import { open } from 'node:fs/promises'

import { ProviderTranscriptMessages } from '../../projectManager/providerTranscriptMessages'
import type { ProviderSubagentFileRef } from '../../projectManager/providerTranscriptView'
import { BoundedMap } from '../../shared/boundedMap'
import { FileTail } from '../../shared/fileTail'
import { JsonShape } from '../../shared/jsonShape'
import { JsonlRecords } from '../../shared/jsonlRecords'
import { SessionTasksSourceClaude } from '../claude/sessionTasksSourceClaude'
import type { SessionSubagentRow, SessionTaskParentState } from '../sessionTasksApi.types'

type CodexSettledState = 'done' | 'failed' | 'stopped'

/** What one child rollout says on its own, before the parent's state is known. */
export interface CodexSubagentFacts {
  /** The first plaintext line of the child's task; null when it is encrypted or out of reach. */
  description: string | null
  /** False while the task is not written yet: the head is read again after the next move. */
  descriptionFinal: boolean
  model: string | null
  step: string | null
  settled: { state: CodexSettledState; at: number } | null
}

/** One session's newest child rollouts, by file, each with the facts read under the stat in `key`. */
export type CodexSubagentMemo = Map<string, { key: string; facts: CodexSubagentFacts }>

/**
 * Codex child threads, each judged from its own rollout: the last turn event of a 64 KiB tail
 * decides the state (`task_complete` done, `turn_aborted` `interrupted` stopped, any other reason
 * failed), else the running rule Claude sub-agents follow.
 *
 * The description comes from the child's head, read until it is known and never again: the task
 * sits behind the injected instructions, 140 to 250 KiB into the file on this machine's rollouts.
 * A multi-agent v2 task arrives encrypted (`gAAAA...`), and such a child is described by its
 * nickname alone.
 *
 * Never throws for a file: one that vanished or cannot be read is left out of this listing and tried
 * again in the next one.
 */
export class SessionTasksSourceCodex {
  static readonly classifiedMaxConst = 60
  private static readonly tailBytesConst = 65_536
  private static readonly headBytesConst = 262_144
  private static readonly readConcurrencyConst = 8
  private static readonly encryptedPrefixConst = 'gAAAA'
  /** The plaintext frame a v2 inter-agent message carries around its payload. */
  private static readonly envelopeLinePatternConst = /^(Message Type|Task name|Sender|Payload):/
  private static readonly execCommandPatternConst = /\bcmd\s*:\s*"((?:[^"\\]|\\.)*)"/

  /**
   * Rows of the newest `classifiedMaxConst` child rollouts by mtime, newest first; the older ones
   * are counted, never read. A rollout whose stat has not moved is not read again.
   */
  async list(
    files: readonly ProviderSubagentFileRef[],
    parent: SessionTaskParentState,
    memo: CodexSubagentMemo,
  ): Promise<{ rows: SessionSubagentRow[]; unread: number }> {
    const newest = [...files]
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, SessionTasksSourceCodex.classifiedMaxConst)
    const kept = new Set(newest.map((ref) => ref.file))
    for (const file of memo.keys())
      if (!kept.has(file)) memo.delete(file)
    const rows = await BoundedMap.run(newest, SessionTasksSourceCodex.readConcurrencyConst, async (ref) => {
      const facts = await SessionTasksSourceCodex.factsOf(ref, memo)
      return facts === null ? null : SessionTasksSourceCodex.rowOf(ref, facts, parent)
    })
    return {
      rows: rows.filter((row) => row !== null),
      unread: files.length - newest.length,
    }
  }

  static rowOf(
    ref: ProviderSubagentFileRef,
    facts: CodexSubagentFacts,
    parent: SessionTaskParentState,
  ): SessionSubagentRow | null {
    const thread = ref.thread
    if (thread === null) return null
    return {
      kind: 'subagent',
      subagentId: ref.subagentId,
      agentType: thread.nickname ?? 'agent',
      description: facts.description ?? thread.nickname ?? '',
      depth: thread.depth,
      parentSubagentId: thread.parentSubagentId,
      state: SessionTasksSourceClaude.stateOf(facts.settled?.state ?? null, parent, ref.mtimeMs),
      startedAt: thread.startedAt,
      endedAt: facts.settled?.at ?? null,
      model: facts.model,
      step: facts.settled === null ? facts.step : null,
    }
  }

  /** The last turn event of the tail decides; a turn started after the last ending is unsettled. */
  static settledOf(records: readonly Record<string, unknown>[]): { state: CodexSettledState; at: number | null } | null {
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index]
      if (record.type !== 'event_msg') continue
      const payload = JsonShape.record(record.payload)
      const at = SessionTasksSourceCodex.timeOf(record.timestamp)
      switch (payload?.type) {
        case 'task_complete': return { state: 'done', at }
        case 'turn_aborted': return { state: payload.reason === 'interrupted' ? 'stopped' : 'failed', at }
        case 'task_started': return null
        default: continue
      }
    }
    return null
  }

  /** `Shell <command>`, `Edit <path>`, or the tool's name: the last step of the tail, one line. */
  static stepOf(records: readonly Record<string, unknown>[]): string | null {
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index]
      const payload = JsonShape.record(record.payload)
      if (payload === null) continue
      let step: string | null = null
      if (record.type === 'event_msg' && payload.type === 'item_completed')
        step = SessionTasksSourceCodex.itemStepOf(JsonShape.record(payload.item))
      else if (record.type === 'response_item' && payload.type === 'custom_tool_call')
        step = SessionTasksSourceCodex.customCallStepOf(payload)
      else if (record.type === 'response_item' && payload.type === 'function_call')
        step = SessionTasksSourceCodex.text(payload.name)
      if (step !== null) return SessionTasksSourceClaude.oneLine(step)
    }
    return null
  }

  /**
   * The first plaintext line of the child's task, read from the head. `final` is false only when the
   * head ended before the task: the file is still being written and the next move reads it again.
   */
  static descriptionOf(head: string, wholeFile: boolean): { description: string | null; final: boolean } {
    for (const record of JsonlRecords.of(head)) {
      const value = JsonShape.record(record)
      if (value === null) continue
      const payload = JsonShape.record(value.payload)
      if (value.type === 'response_item' && payload?.type === 'agent_message')
        return { description: SessionTasksSourceCodex.taskLineOf(payload.content), final: true }
      const message = ProviderTranscriptMessages.codex(record)
      // `<recommended_plugins>` and other tagged blocks are Codex's own context, not the task.
      if (message !== null && !message.text.trimStart().startsWith('<'))
        return { description: SessionTasksSourceCodex.plainLineOf(message.text), final: true }
      if (SessionTasksSourceCodex.isAgentStep(value.type, payload))
        return { description: null, final: true }
    }
    return { description: null, final: !wholeFile }
  }

  /**
   * The child's own work began, so no task follows. Not the shared prompt boundary: a child's
   * rollout opens with `task_started` before its task is written.
   */
  private static isAgentStep(type: unknown, payload: Record<string, unknown> | null): boolean {
    if (type === 'response_item')
      return payload?.type === 'reasoning'
        || payload?.type === 'custom_tool_call'
        || payload?.type === 'function_call'
        || (payload?.type === 'message' && payload.role === 'assistant')
    if (type === 'event_msg')
      return payload?.type === 'agent_message' || payload?.type === 'task_complete'
    return false
  }

  private static taskLineOf(content: unknown): string | null {
    if (!Array.isArray(content)) return null
    const text = content
      .flatMap((part) => {
        const block = JsonShape.record(part)
        return block?.type === 'input_text' && typeof block.text === 'string' ? [block.text] : []
      })
      .join('\n')
      .split(/\r?\n/)
      .filter((line) => !SessionTasksSourceCodex.envelopeLinePatternConst.test(line))
      .join('\n')
    return SessionTasksSourceCodex.plainLineOf(text)
  }

  private static plainLineOf(text: string): string | null {
    const line = text.split(/\r?\n/).find((one) => one.trim() !== '')
    if (line === undefined || line.trim().startsWith(SessionTasksSourceCodex.encryptedPrefixConst)) return null
    return SessionTasksSourceClaude.oneLine(line)
  }

  private static itemStepOf(item: Record<string, unknown> | null): string | null {
    if (item === null) return null
    switch (item.type) {
      case 'CommandExecution': {
        const parsed = Array.isArray(item.parsed_cmd) ? JsonShape.record(item.parsed_cmd[0]) : null
        const command = Array.isArray(item.command) ? item.command[item.command.length - 1] : item.command
        const shown = SessionTasksSourceCodex.text(parsed?.cmd) ?? SessionTasksSourceCodex.text(command)
        return shown === null ? 'Shell' : `Shell ${shown}`
      }
      case 'FileChange': {
        const changes = JsonShape.record(item.changes)
        const path = changes === null ? undefined : Object.keys(changes)[0]
        return path === undefined ? 'Edit' : `Edit ${path}`
      }
      default:
        return null
    }
  }

  /** A code-mode `exec` call quotes its command inside the script it runs. */
  private static customCallStepOf(payload: Record<string, unknown>): string | null {
    const name = SessionTasksSourceCodex.text(payload.name)
    if (name !== 'exec' || typeof payload.input !== 'string') return name
    const quoted = SessionTasksSourceCodex.execCommandPatternConst.exec(payload.input)?.[1]
    if (quoted === undefined) return name
    try { return `Shell ${JSON.parse(`"${quoted}"`) as string}` }
    catch { return name }
  }

  private static async factsOf(
    ref: ProviderSubagentFileRef,
    memo: CodexSubagentMemo,
  ): Promise<CodexSubagentFacts | null> {
    const key = `${ref.mtimeMs}\0${ref.size}`
    const held = memo.get(ref.file)
    if (held !== undefined && held.key === key) return held.facts
    try {
      const facts = await SessionTasksSourceCodex.readFacts(ref, held?.facts ?? null)
      memo.set(ref.file, { key, facts })
      return facts
    }
    catch {
      memo.delete(ref.file)
      return null
    }
  }

  private static async readFacts(
    ref: ProviderSubagentFileRef,
    previous: CodexSubagentFacts | null,
  ): Promise<CodexSubagentFacts> {
    const tail = await FileTail.readBounded(ref.file, ref.size, SessionTasksSourceCodex.tailBytesConst)
    const records = JsonlRecords.of(tail.content)
      .map((record) => JsonShape.record(record))
      .filter((record) => record !== null)
    let described = { description: previous?.description ?? null, final: true }
    let headModel: string | null = null
    if (previous?.descriptionFinal !== true) {
      const head = await SessionTasksSourceCodex.head(ref.file, SessionTasksSourceCodex.headBytesConst)
      described = SessionTasksSourceCodex.descriptionOf(head, ref.size <= SessionTasksSourceCodex.headBytesConst)
      headModel = SessionTasksSourceCodex.modelOf(JsonlRecords.of(head)
        .map((record) => JsonShape.record(record))
        .filter((record) => record !== null))
    }
    const settled = SessionTasksSourceCodex.settledOf(records)
    return {
      description: described.description,
      descriptionFinal: described.final,
      // A long turn pushes its turn_context out of the tail; the model it named still holds.
      model: SessionTasksSourceCodex.modelOf(records) ?? previous?.model ?? headModel,
      step: SessionTasksSourceCodex.stepOf(records),
      settled: settled === null ? null : { state: settled.state, at: settled.at ?? ref.mtimeMs },
    }
  }

  private static modelOf(records: readonly Record<string, unknown>[]): string | null {
    for (let index = records.length - 1; index >= 0; index -= 1) {
      if (records[index].type !== 'turn_context') continue
      const model = SessionTasksSourceCodex.text(JsonShape.record(records[index].payload)?.model)
      if (model !== null) return model
    }
    return null
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
}
