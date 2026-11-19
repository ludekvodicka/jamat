import { JsonShape } from '../../shared/jsonShape'
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

interface ClaudeRecord {
  type?: unknown
  uuid?: unknown
  timestamp?: unknown
  isMeta?: unknown
  isSidechain?: unknown
  message?: {
    content?: unknown
  }
}

interface ClaudeContentBlock {
  type?: unknown
  id?: unknown
  tool_use_id?: unknown
  name?: unknown
  input?: unknown
  is_error?: unknown
  text?: unknown
}

interface ClaudeToolInput {
  file_path?: unknown
  old_string?: unknown
  new_string?: unknown
  replace_all?: unknown
  content?: unknown
  command?: unknown
}

interface PendingClaudeMutation {
  group: { mutations: RawFileChangesLogMutation[] }
  mutation: RawFileChangesLogMutation
}

/** The tool calls of one file waiting for their results. */
interface ClaudeCalls {
  mutations: Map<string, PendingClaudeMutation>
  shells: Map<string, { command: string; startedAt: number }>
  shellRuns: FileChangesShellRun[]
}

export class FileChangesLogSourceClaude extends FileChangesLogSource {
  private static readonly spawnToolNameConst = 'Agent'
  private static readonly shellToolNamesConst: readonly unknown[] = ['Bash', 'PowerShell']

  readonly agentId = 'claude' as const

  subagentsSince(): number {
    return 0
  }

  protected parse(content: string): ParsedFileChangesLog {
    const groups: (RawFileChangesLogGroup & { mutations: RawFileChangesLogMutation[] })[] = []
    const spawns = new Map<string, number>()
    const calls = FileChangesLogSourceClaude.calls()
    let current: (RawFileChangesLogGroup & { mutations: RawFileChangesLogMutation[] }) | null = null
    let sequence = 0
    // The last time this file gave us, so a record whose own timestamp is missing or unreadable
    // inherits its neighbour's rather than the position it happens to sit at. These files are
    // written in order; a sequence number as a time is 1970 and the wrong end of the history.
    let lastCreatedAt = 0
    for (const raw of FileChangesLogSource.records(content)) {
      sequence += 1
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const record = raw as ClaudeRecord
      const createdAt = FileChangesLogSource.timestamp(record.timestamp, lastCreatedAt)
      lastCreatedAt = createdAt
      const message = FileChangesLogSourceClaude.userMessage(record)
      if (message !== null) {
        current = {
          groupId: typeof record.uuid === 'string' ? record.uuid : `claude-message-${sequence}`,
          message: FileChangesLogSource.shortMessage(message),
          createdAt,
          mutations: [],
        }
        groups.push(current)
        continue
      }
      for (const block of FileChangesLogSourceClaude.blocks(record.message?.content)) {
        if (block.type === 'tool_use'
          && block.name === FileChangesLogSourceClaude.spawnToolNameConst
          && typeof block.id === 'string'
          && current !== null)
          spawns.set(block.id, groups.length - 1)
        FileChangesLogSourceClaude.collect(block, current, calls, createdAt, sequence)
      }
    }
    return { groups, spawns, shellRuns: calls.shellRuns }
  }

  /** A sidechain file opens no group: its prompt is the parent's `Agent` call, not a user message. */
  protected parseSubagent(content: string): ParsedSubagentLog {
    const target = { mutations: [] as RawFileChangesLogMutation[] }
    const calls = FileChangesLogSourceClaude.calls()
    let startedAt: number | null = null
    let sequence = 0
    let lastCreatedAt = 0
    for (const raw of FileChangesLogSource.records(content)) {
      sequence += 1
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const record = raw as ClaudeRecord
      const createdAt = FileChangesLogSource.timestamp(record.timestamp, lastCreatedAt)
      lastCreatedAt = createdAt
      if (startedAt === null && createdAt > 0) startedAt = createdAt
      for (const block of FileChangesLogSourceClaude.blocks(record.message?.content))
        FileChangesLogSourceClaude.collect(block, target, calls, createdAt, sequence)
    }
    return { startedAt, mutations: target.mutations, shellRuns: calls.shellRuns }
  }

  private static calls(): ClaudeCalls {
    return { mutations: new Map(), shells: new Map(), shellRuns: [] }
  }

  /**
   * An `Edit` or `Write` counts only once its tool_result came back without an error. A shell call
   * counts with any result, because a failed command can have written files before it failed.
   */
  private static collect(
    block: ClaudeContentBlock,
    group: { mutations: RawFileChangesLogMutation[] } | null,
    calls: ClaudeCalls,
    createdAt: number,
    sequence: number,
  ): void {
    if (block.type === 'tool_use' && typeof block.id === 'string') {
      const command = FileChangesLogSourceClaude.inputOf(block.input).command
      if (FileChangesLogSourceClaude.shellToolNamesConst.includes(block.name) && typeof command === 'string')
        calls.shells.set(block.id, { command, startedAt: createdAt })
      const mutation = group === null ? null : FileChangesLogSourceClaude.mutationOf(block, createdAt, sequence)
      if (mutation !== null && group !== null)
        calls.mutations.set(block.id, { group, mutation })
    }
    else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      const shell = calls.shells.get(block.tool_use_id)
      calls.shells.delete(block.tool_use_id)
      if (shell !== undefined) calls.shellRuns.push({ ...shell, endedAt: createdAt })
      const found = calls.mutations.get(block.tool_use_id)
      calls.mutations.delete(block.tool_use_id)
      if (found && block.is_error !== true) found.group.mutations.push(found.mutation)
    }
  }

  private static userMessage(record: ClaudeRecord): string | null {
    if (record.type !== 'user' || record.isMeta === true || record.isSidechain === true) return null
    const content = record.message?.content
    if (typeof content === 'string') return content.trim() || null
    if (!Array.isArray(content)) return null
    if (content.some((block) => FileChangesLogSourceClaude.blockOf(block).type === 'tool_result'))
      return null
    const text = content
      .map((block) => FileChangesLogSourceClaude.blockOf(block))
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => String(block.text))
      .join('\n')
      .trim()
    return text || null
  }

  private static mutationOf(
    block: ClaudeContentBlock,
    createdAt: number,
    sequence: number,
  ): RawFileChangesLogMutation | null {
    if (block.name !== 'Edit' && block.name !== 'Write') return null
    const input = FileChangesLogSourceClaude.inputOf(block.input)
    if (typeof input.file_path !== 'string' || !input.file_path.trim()) return null
    const mutationId = typeof block.id === 'string' ? block.id : `claude-tool-${sequence}`
    if (block.name === 'Write') {
      if (typeof input.content !== 'string') return null
      return {
        mutationId,
        kind: 'write',
        status: 'modified',
        path: input.file_path,
        previousPath: null,
        beforeContent: null,
        afterContent: input.content,
        oldText: null,
        newText: null,
        replaceAll: false,
        unifiedDiff: null,
        createdAt,
      }
    }
    if (typeof input.old_string !== 'string' || typeof input.new_string !== 'string') return null
    return {
      mutationId,
      kind: 'update',
      status: 'modified',
      path: input.file_path,
      previousPath: null,
      beforeContent: null,
      afterContent: null,
      oldText: input.old_string,
      newText: input.new_string,
      replaceAll: input.replace_all === true,
      unifiedDiff: null,
      createdAt,
    }
  }

  private static blocks(value: unknown): ClaudeContentBlock[] {
    if (!Array.isArray(value)) return []
    return value.map(FileChangesLogSourceClaude.blockOf)
  }

  private static blockOf(value: unknown): ClaudeContentBlock {
    return (JsonShape.record(value) ?? {}) as ClaudeContentBlock
  }

  private static inputOf(value: unknown): ClaudeToolInput {
    return (JsonShape.record(value) ?? {}) as ClaudeToolInput
  }
}
