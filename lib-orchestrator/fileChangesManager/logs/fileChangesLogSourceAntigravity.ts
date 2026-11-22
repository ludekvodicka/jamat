import { JsonShape } from '../../shared/jsonShape'
import { SessionTranscriptSourceAntigravity } from '../../sessionTranscriptReader/antigravity/sessionTranscriptSourceAntigravity'
import {
  FileChangesLogSource,
  type ParsedFileChangesLog,
  type ParsedSubagentLog,
} from './fileChangesLogSource'
import type {
  FileChangesShellRun,
  RawFileChangesLogGroup,
  RawFileChangesLogMutation,
} from './fileChangesLogSource.types'

interface AntigravityToolCall {
  name?: unknown
  args?: unknown
}

/**
 * Extracts file mutations (`edit_file`, `write_file`) and shell command runs (`run_command`)
 * from an Antigravity CLI transcript (`transcript.jsonl`).
 */
export class FileChangesLogSourceAntigravity extends FileChangesLogSource {
  readonly agentId = 'antigravity' as const

  subagentsSince(): number | null {
    return null
  }

  protected parse(content: string): ParsedFileChangesLog {
    const groups: (RawFileChangesLogGroup & { mutations: RawFileChangesLogMutation[] })[] = []
    const shellRuns: FileChangesShellRun[] = []
    let current: (RawFileChangesLogGroup & { mutations: RawFileChangesLogMutation[] }) | null = null
    let sequence = 0
    let lastCreatedAt = 0
    for (const raw of FileChangesLogSource.records(content)) {
      sequence += 1
      const record = JsonShape.record(raw)
      if (record === null) continue
      const createdAt = FileChangesLogSource.timestamp(record['created_at'], lastCreatedAt)
      lastCreatedAt = createdAt
      if (record['type'] === 'USER_INPUT' && record['source'] === 'USER_EXPLICIT') {
        const message = SessionTranscriptSourceAntigravity.extractUserText(record['content'])
        if (message !== null) {
          const stepIndex = typeof record['step_index'] === 'number' ? record['step_index'] : sequence
          current = {
            groupId: `antigravity-step-${stepIndex}`,
            message: FileChangesLogSource.shortMessage(message),
            createdAt,
            mutations: [],
          }
          groups.push(current)
        }
        continue
      }
      if (record['type'] !== 'PLANNER_RESPONSE') continue
      const toolCalls = record['tool_calls']
      if (!Array.isArray(toolCalls)) continue
      for (let callIndex = 0; callIndex < toolCalls.length; callIndex += 1) {
        const call = (JsonShape.record(toolCalls[callIndex]) ?? {}) as AntigravityToolCall
        const args = JsonShape.record(call.args)
        if (args === null) continue
        if (call.name === 'run_command') {
          const command = FileChangesLogSourceAntigravity.stringArg(args['CommandLine'])
          if (command !== null)
            shellRuns.push({ command, startedAt: createdAt, endedAt: createdAt })
          continue
        }
        if (current === null) continue
        const mutation = FileChangesLogSourceAntigravity.mutationOf(
          call.name,
          args,
          createdAt,
          `antigravity-tool-${sequence}-${callIndex}`,
        )
        if (mutation !== null) current.mutations.push(mutation)
      }
    }
    return { groups, spawns: new Map(), shellRuns }
  }

  protected parseSubagent(): ParsedSubagentLog {
    return { startedAt: null, mutations: [], shellRuns: [] }
  }

  private static mutationOf(
    name: unknown,
    args: Record<string, unknown>,
    createdAt: number,
    mutationId: string,
  ): RawFileChangesLogMutation | null {
    if (name !== 'edit_file' && name !== 'write_file') return null
    const path = FileChangesLogSourceAntigravity.stringArg(args['Path'])
    if (path === null || !path.trim()) return null
    if (name === 'write_file') {
      const afterContent = FileChangesLogSourceAntigravity.stringArg(args['Content'])
      if (afterContent === null) return null
      return {
        mutationId,
        kind: 'write',
        status: 'modified',
        path,
        previousPath: null,
        beforeContent: null,
        afterContent,
        oldText: null,
        newText: null,
        replaceAll: false,
        unifiedDiff: null,
        createdAt,
      }
    }
    const oldText = FileChangesLogSourceAntigravity.stringArg(args['Target'])
    const newText = FileChangesLogSourceAntigravity.stringArg(args['Replacement'])
    if (oldText === null || newText === null) return null
    return {
      mutationId,
      kind: 'update',
      status: 'modified',
      path,
      previousPath: null,
      beforeContent: null,
      afterContent: null,
      oldText,
      newText,
      replaceAll: true,
      unifiedDiff: null,
      createdAt,
    }
  }

  /**
   * Compact `transcript.jsonl` stores tool call arg values as JSON-encoded strings (e.g. `"\"q:\\\\...\""`),
   * whereas full transcripts or direct objects may hold plain strings. Unwrap once if JSON-quoted.
   */
  private static stringArg(value: unknown): string | null {
    if (typeof value !== 'string') return null
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        const parsed: unknown = JSON.parse(value)
        if (typeof parsed === 'string') return parsed
      }
      catch { /* keep raw string */ }
    }
    return value
  }
}
