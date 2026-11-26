import { basename } from 'node:path'

import { z } from 'zod'

import { ProviderTranscriptMessages } from '../projectManager/providerTranscriptMessages'
import type { ProviderTranscriptRef } from '../projectManager/providerTranscriptView'
import { SessionTranscriptSourceAntigravity } from '../sessionTranscriptReader/antigravity/sessionTranscriptSourceAntigravity'
import { JsonShape } from '../shared/jsonShape'
import type { FileChangesAgentId } from './fileChangesManagerApi.types'
import type { FileChangesShellRun, RawFileChangesLogMutation } from './logs/fileChangesLogSource.types'

export type { FileChangesShellRun, RawFileChangesLogMutation } from './logs/fileChangesLogSource.types'
/** The session-owned-files rule of Finish (name plus write time), shared with the uncommitted mark. */
export { FileChangesShellRuns } from './logs/fileChangesShellRuns'

/** A session's own transcript opens message groups; a sub-agent's file opens none and gates nothing on them. */
export type SessionMutationRole = 'session' | 'subagent'

/** What one record of a transcript adds, in file order. */
export interface SessionMutationEvents {
  group(group: { groupId: string; message: string; createdAt: number }): void
  /** A sub-agent spawned under the group at `group`, its index among the groups opened so far. */
  spawn(key: string, group: number): void
  /** A confirmed mutation, filed under the group that was open when it was issued; -1 for a sub-agent. */
  mutation(mutation: RawFileChangesLogMutation, group: number): void
  shellRun(run: FileChangesShellRun): void
}

export interface SessionMutationBatch {
  mutations: RawFileChangesLogMutation[]
  shellRuns: FileChangesShellRun[]
}

/** The incremental reader of one transcript: lines in, confirmed mutations and finished shell runs out. */
export interface SessionMutationExtractor {
  push(lines: readonly string[]): void
  drain(): SessionMutationBatch
  /** Plain JSON: what a later chunk needs of the earlier ones. */
  state(): unknown
}

const mutationSchema = z.object({
  mutationId: z.string(),
  kind: z.enum(['add', 'update', 'delete', 'write', 'move']),
  status: z.enum(['added', 'modified', 'deleted', 'renamed', 'copied', 'replaced', 'untracked', 'conflicted', 'missing', 'obstructed']),
  path: z.string(),
  previousPath: z.string().nullable(),
  beforeContent: z.string().nullable(),
  afterContent: z.string().nullable(),
  oldText: z.string().nullable(),
  newText: z.string().nullable(),
  replaceAll: z.boolean(),
  unifiedDiff: z.string().nullable(),
  createdAt: z.number().finite(),
})
const baseStateFields = {
  sequence: z.number().int().nonnegative(),
  lastCreatedAt: z.number().finite(),
  groups: z.number().int().nonnegative(),
}
const claudeStateSchema = z.object({
  ...baseStateFields,
  pending: z.array(z.tuple([z.string(), z.number().int().min(-1), mutationSchema])),
  shells: z.array(z.tuple([z.string(), z.string(), z.number().finite()])),
})
const codexStateSchema = z.object({
  ...baseStateFields,
  fallback: z.object({ message: z.string(), createdAt: z.number().finite(), sequence: z.number().int().nonnegative() }).nullable(),
})
const antigravityStateSchema = z.object(baseStateFields)

type BaseState = z.infer<typeof antigravityStateSchema>

/**
 * The per-record rules of the three agents' transcripts: which records open a message group, which
 * tool calls count as a confirmed mutation, and which are shell runs. The full parsers of File
 * Changes and the incremental cursor of the uncommitted mark both read through these, so the two
 * can never disagree about what a session wrote. A rules object carries the little a later record
 * needs of the earlier ones, and `state()` hands that out as plain JSON.
 */
export abstract class SessionMutationRules {
  protected readonly role: SessionMutationRole
  protected sequence: number
  /**
   * The last time this file gave us, so a record whose own timestamp is missing or unreadable
   * inherits its neighbour's rather than the position it happens to sit at. These files are
   * written in order; a sequence number as a time is 1970 and the wrong end of the history.
   */
  protected lastCreatedAt: number
  /** How many groups were opened; a session's mutation before the first is dropped. */
  protected groups: number
  /** The first time this reader saw; only a full parse of a sub-agent file asks, so it is no part of `state()`. */
  startedAt: number | null = null

  protected constructor(role: SessionMutationRole, state: BaseState | null) {
    this.role = role
    this.sequence = state?.sequence ?? 0
    this.lastCreatedAt = state?.lastCreatedAt ?? 0
    this.groups = state?.groups ?? 0
  }

  /** Throws on a state another agent or version wrote; the caller then reads the file from its start. */
  static of(agentId: FileChangesAgentId, role: SessionMutationRole, state?: unknown): SessionMutationRules {
    if (agentId === 'claude')
      return new ClaudeMutationRules(role, state === undefined ? null : claudeStateSchema.parse(state))
    else if (agentId === 'codex')
      return new CodexMutationRules(role, state === undefined ? null : codexStateSchema.parse(state))
    else if (agentId === 'antigravity') {
      if (role === 'subagent') throw new Error('Antigravity has no sub-agent transcripts')
      return new AntigravityMutationRules(state === undefined ? null : antigravityStateSchema.parse(state))
    }
    else
      throw new Error(`Unknown agent: ${JSON.stringify(agentId satisfies never)}`)
  }

  /** Where the sub-agent listing of a session's transcript starts; null lists none. */
  static subagentsSince(ref: ProviderTranscriptRef): number | null {
    if (ref.agentId === 'claude') return 0
    else if (ref.agentId === 'codex') return CodexMutationRules.startOf(ref.file)
    else if (ref.agentId === 'antigravity') return null
    else throw new Error(`Unknown agent: ${JSON.stringify(ref.agentId satisfies never)}`)
  }

  /** Whatever `JSON.parse` gave for one non-blank line. */
  record(raw: unknown, events: SessionMutationEvents): void {
    this.sequence += 1
    this.read(raw, events)
  }

  abstract state(): unknown

  protected abstract read(raw: unknown, events: SessionMutationEvents): void

  protected baseState(): BaseState {
    return { sequence: this.sequence, lastCreatedAt: this.lastCreatedAt, groups: this.groups }
  }

  protected time(value: unknown): number {
    if (typeof value === 'string') {
      const parsed = Date.parse(value)
      if (!Number.isNaN(parsed)) this.lastCreatedAt = parsed
    }
    if (this.startedAt === null && this.lastCreatedAt > 0) this.startedAt = this.lastCreatedAt
    return this.lastCreatedAt
  }

  protected openGroup(events: SessionMutationEvents, groupId: string, message: string, createdAt: number): void {
    events.group({ groupId, message, createdAt })
    this.groups += 1
  }

  protected static shortMessage(value: string): string {
    return value.replace(/\s+/g, ' ').trim().slice(0, 240)
  }
}

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

/**
 * An `Edit` or `Write` counts only once its tool_result came back without an error. A shell call
 * counts with any result, because a failed command can have written files before it failed. The
 * calls still waiting for a result are the state a later chunk needs.
 */
class ClaudeMutationRules extends SessionMutationRules {
  private static readonly spawnToolNameConst = 'Agent'
  private static readonly shellToolNamesConst: readonly unknown[] = ['Bash', 'PowerShell']

  private readonly pending: Map<string, { group: number; mutation: RawFileChangesLogMutation }>
  private readonly shells: Map<string, { command: string; startedAt: number }>

  constructor(role: SessionMutationRole, state: z.infer<typeof claudeStateSchema> | null) {
    super(role, state)
    this.pending = new Map(state?.pending.map(([id, group, mutation]) => [id, { group, mutation }]))
    this.shells = new Map(state?.shells.map(([id, command, startedAt]) => [id, { command, startedAt }]))
  }

  state(): z.infer<typeof claudeStateSchema> {
    return {
      ...this.baseState(),
      pending: [...this.pending].map(([id, { group, mutation }]) => [id, group, mutation]),
      shells: [...this.shells].map(([id, { command, startedAt }]) => [id, command, startedAt]),
    }
  }

  protected read(raw: unknown, events: SessionMutationEvents): void {
    if (!JsonShape.isRecord(raw)) return
    const record = raw as ClaudeRecord
    const createdAt = this.time(record.timestamp)
    if (this.role === 'session') {
      const message = ClaudeMutationRules.userMessage(record)
      if (message !== null) {
        const groupId = typeof record.uuid === 'string' ? record.uuid : `claude-message-${this.sequence}`
        this.openGroup(events, groupId, SessionMutationRules.shortMessage(message), createdAt)
        return
      }
    }
    for (const block of ClaudeMutationRules.blocks(record.message?.content)) {
      if (this.role === 'session'
        && block.type === 'tool_use'
        && block.name === ClaudeMutationRules.spawnToolNameConst
        && typeof block.id === 'string'
        && this.groups > 0)
        events.spawn(block.id, this.groups - 1)
      this.collect(block, events, createdAt)
    }
  }

  private collect(block: ClaudeContentBlock, events: SessionMutationEvents, createdAt: number): void {
    if (block.type === 'tool_use' && typeof block.id === 'string') {
      const command = ClaudeMutationRules.inputOf(block.input).command
      if (ClaudeMutationRules.shellToolNamesConst.includes(block.name) && typeof command === 'string')
        this.shells.set(block.id, { command, startedAt: createdAt })
      const group = this.role === 'session' ? this.groups - 1 : -1
      const mutation = this.role === 'session' && this.groups === 0
        ? null
        : ClaudeMutationRules.mutationOf(block, createdAt, this.sequence)
      if (mutation !== null) this.pending.set(block.id, { group, mutation })
    }
    else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      const shell = this.shells.get(block.tool_use_id)
      this.shells.delete(block.tool_use_id)
      if (shell !== undefined) events.shellRun({ ...shell, endedAt: createdAt })
      const found = this.pending.get(block.tool_use_id)
      this.pending.delete(block.tool_use_id)
      if (found && block.is_error !== true) events.mutation(found.mutation, found.group)
    }
  }

  private static userMessage(record: ClaudeRecord): string | null {
    if (record.type !== 'user' || record.isMeta === true || record.isSidechain === true) return null
    const content = record.message?.content
    if (typeof content === 'string') return content.trim() || null
    if (!Array.isArray(content)) return null
    if (content.some((block) => ClaudeMutationRules.blockOf(block).type === 'tool_result'))
      return null
    const text = content
      .map((block) => ClaudeMutationRules.blockOf(block))
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
    const input = ClaudeMutationRules.inputOf(block.input)
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
    return value.map(ClaudeMutationRules.blockOf)
  }

  private static blockOf(value: unknown): ClaudeContentBlock {
    return (JsonShape.record(value) ?? {}) as ClaudeContentBlock
  }

  private static inputOf(value: unknown): ClaudeToolInput {
    return (JsonShape.record(value) ?? {}) as ClaudeToolInput
  }
}

interface CodexRecord {
  timestamp?: unknown
  type?: unknown
  payload?: {
    type?: unknown
    success?: unknown
    call_id?: unknown
    changes?: unknown
    item?: unknown
  }
}

interface CodexItem {
  type?: unknown
  id?: unknown
  tool?: unknown
  status?: unknown
  changes?: unknown
  receiver_thread_ids?: unknown
  command?: unknown
  duration?: unknown
}

interface CodexDuration {
  secs?: unknown
  nanos?: unknown
}

interface CodexChange {
  type?: unknown
  content?: unknown
  unified_diff?: unknown
  move_path?: unknown
}

interface CodexAppliedPatch {
  callId: unknown
  changes: unknown
}

/**
 * A rollout states the user's prompt twice: an explicit `user_message` event, and a `message`
 * response item that only counts (as a fallback) when no explicit one follows before the turn's
 * first boundary. The pending fallback is the state a later chunk needs.
 */
class CodexMutationRules extends SessionMutationRules {
  /** `rollout-YYYY-MM-DDThh-mm-ss-<thread>.jsonl`, the thread's start in local time cut to the second. */
  private static readonly rolloutStartPatternConst = /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-/

  private fallback: { message: string; createdAt: number; sequence: number } | null

  constructor(role: SessionMutationRole, state: z.infer<typeof codexStateSchema> | null) {
    super(role, state)
    this.fallback = state?.fallback ?? null
  }

  /** The child rollouts of a thread start after it, so the listing starts at the parent's own start. */
  static startOf(file: string): number | null {
    const match = CodexMutationRules.rolloutStartPatternConst.exec(basename(file))
    if (match === null) return null
    const startedAt = Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`)
    return Number.isNaN(startedAt) ? null : startedAt
  }

  state(): z.infer<typeof codexStateSchema> {
    return { ...this.baseState(), fallback: this.fallback }
  }

  protected read(raw: unknown, events: SessionMutationEvents): void {
    const record = (JsonShape.record(raw) ?? {}) as CodexRecord
    const createdAt = this.time(record.timestamp)
    const shellRun = CodexMutationRules.shellRunOf(record, createdAt)
    if (shellRun !== null) events.shellRun(shellRun)
    if (this.role === 'subagent') {
      const patch = CodexMutationRules.appliedPatchOf(record)
      if (patch !== null)
        for (const mutation of CodexMutationRules.mutationsOf(patch, createdAt, this.sequence))
          events.mutation(mutation, -1)
      return
    }
    const message = ProviderTranscriptMessages.codex(raw)
    if (message?.kind === 'explicit') {
      this.openGroup(events, `codex-message-${this.sequence}`, SessionMutationRules.shortMessage(message.text), createdAt)
      this.fallback = null
      return
    }
    if (message?.kind === 'fallback') {
      this.fallback = { message: SessionMutationRules.shortMessage(message.text), createdAt, sequence: this.sequence }
      return
    }
    if (this.fallback !== null && ProviderTranscriptMessages.isCodexPromptBoundary(raw))
      this.openFallback(events)
    const patch = CodexMutationRules.appliedPatchOf(record)
    const spawned = CodexMutationRules.spawnedThreadsOf(record)
    if (patch === null && spawned.length === 0) return
    if (this.groups === 0 && this.fallback !== null) this.openFallback(events)
    if (this.groups === 0) return
    for (const threadId of spawned)
      events.spawn(threadId, this.groups - 1)
    if (patch !== null)
      for (const mutation of CodexMutationRules.mutationsOf(patch, createdAt, this.sequence))
        events.mutation(mutation, this.groups - 1)
  }

  private openFallback(events: SessionMutationEvents): void {
    const fallback = this.fallback!
    this.openGroup(events, `codex-message-${fallback.sequence}`, fallback.message, fallback.createdAt)
    this.fallback = null
  }

  /**
   * A finished `CommandExecution` item, failed ones too: a failed command can have written files
   * before it failed. The record is written at its end, so the start is that time less its duration.
   */
  private static shellRunOf(record: CodexRecord, endedAt: number): FileChangesShellRun | null {
    if (record.type !== 'event_msg' || record.payload?.type !== 'item_completed') return null
    const item = CodexMutationRules.itemOf(record.payload.item)
    if (item.type !== 'CommandExecution' || !Array.isArray(item.command)) return null
    const command = item.command.filter((part): part is string => typeof part === 'string').join(' ')
    const duration = (JsonShape.record(item.duration) ?? {}) as CodexDuration
    const milliseconds = (typeof duration.secs === 'number' ? duration.secs * 1_000 : 0)
      + (typeof duration.nanos === 'number' ? duration.nanos / 1_000_000 : 0)
    return command === '' ? null : { command, startedAt: endedAt - milliseconds, endedAt }
  }

  /**
   * A successful `patch_apply_end`, or a completed `FileChange` item: the rollouts Codex writes
   * since mid-2026 carry an applied patch only as that item, with the same `changes` map.
   */
  private static appliedPatchOf(record: CodexRecord): CodexAppliedPatch | null {
    if (record.type !== 'event_msg') return null
    if (record.payload?.type === 'patch_apply_end')
      return record.payload.success === true
        ? { callId: record.payload.call_id, changes: record.payload.changes }
        : null
    if (record.payload?.type !== 'item_completed') return null
    const item = CodexMutationRules.itemOf(record.payload.item)
    return item.type === 'FileChange' && item.status === 'completed'
      ? { callId: item.id, changes: item.changes }
      : null
  }

  /** The child thread ids a completed `spawn_agent` call names. */
  private static spawnedThreadsOf(record: CodexRecord): string[] {
    if (record.type !== 'event_msg' || record.payload?.type !== 'item_completed') return []
    const item = CodexMutationRules.itemOf(record.payload.item)
    if (item.type !== 'CollabAgentToolCall' || item.tool !== 'spawn_agent') return []
    if (!Array.isArray(item.receiver_thread_ids)) return []
    return item.receiver_thread_ids.filter((id): id is string => typeof id === 'string' && id !== '')
  }

  private static mutationsOf(
    patch: CodexAppliedPatch,
    createdAt: number,
    sequence: number,
  ): RawFileChangesLogMutation[] {
    const changes = (JsonShape.record(patch.changes) ?? {}) as Record<string, unknown>
    return Object.entries(changes).map(([path, rawChange], index) => {
      const change = (JsonShape.record(rawChange) ?? {}) as CodexChange
      const movePath = typeof change.move_path === 'string' && change.move_path.trim()
        ? change.move_path
        : null
      const mutationId = `${String(patch.callId ?? `codex-patch-${sequence}`)}-${index}`
      if (change.type === 'add' && typeof change.content === 'string')
        return CodexMutationRules.mutation(
          mutationId, 'add', 'added', path, null, null, change.content, null, createdAt,
        )
      else if (change.type === 'delete' && typeof change.content === 'string')
        return CodexMutationRules.mutation(
          mutationId, 'delete', 'deleted', path, null, change.content, null, null, createdAt,
        )
      else if (change.type === 'update' && typeof change.unified_diff === 'string')
        return CodexMutationRules.mutation(
          mutationId,
          movePath === null ? 'update' : 'move',
          movePath === null ? 'modified' : 'renamed',
          movePath ?? path,
          movePath === null ? null : path,
          null,
          null,
          change.unified_diff,
          createdAt,
        )
      // Skipped, not thrown. The exhaustive-else-throws rule is for a discriminant this tree owns;
      // this one belongs to Codex's on-disk format, written by another program on its own release
      // schedule. Thrown, it escaped the parse entirely and the session lost its WHOLE transcript -
      // every group before this record included - and the cache is filled after the parse, so the
      // next listing read the file again and threw again. The Claude reader beside this one has
      // always skipped what it does not recognise.
      return null
    }).filter((mutation) => mutation !== null)
  }

  private static mutation(
    mutationId: string,
    kind: RawFileChangesLogMutation['kind'],
    status: RawFileChangesLogMutation['status'],
    path: string,
    previousPath: string | null,
    beforeContent: string | null,
    afterContent: string | null,
    unifiedDiff: string | null,
    createdAt: number,
  ): RawFileChangesLogMutation {
    return {
      mutationId,
      kind,
      status,
      path,
      previousPath,
      beforeContent,
      afterContent,
      oldText: null,
      newText: null,
      replaceAll: false,
      unifiedDiff,
      createdAt,
    }
  }

  private static itemOf(value: unknown): CodexItem {
    return (JsonShape.record(value) ?? {}) as CodexItem
  }
}

interface AntigravityToolCall {
  name?: unknown
  args?: unknown
}

/** `edit_file` and `write_file` are mutations, `run_command` a shell run; Antigravity has no sub-agent files. */
class AntigravityMutationRules extends SessionMutationRules {
  constructor(state: BaseState | null) {
    super('session', state)
  }

  state(): BaseState {
    return this.baseState()
  }

  protected read(raw: unknown, events: SessionMutationEvents): void {
    const record = JsonShape.record(raw)
    if (record === null) return
    const createdAt = this.time(record['created_at'])
    if (record['type'] === 'USER_INPUT' && record['source'] === 'USER_EXPLICIT') {
      const message = SessionTranscriptSourceAntigravity.extractUserText(record['content'])
      if (message !== null) {
        const stepIndex = typeof record['step_index'] === 'number' ? record['step_index'] : this.sequence
        this.openGroup(events, `antigravity-step-${stepIndex}`, SessionMutationRules.shortMessage(message), createdAt)
      }
      return
    }
    if (record['type'] !== 'PLANNER_RESPONSE') return
    const toolCalls = record['tool_calls']
    if (!Array.isArray(toolCalls)) return
    for (let callIndex = 0; callIndex < toolCalls.length; callIndex += 1) {
      const call = (JsonShape.record(toolCalls[callIndex]) ?? {}) as AntigravityToolCall
      const args = JsonShape.record(call.args)
      if (args === null) continue
      if (call.name === 'run_command') {
        const command = AntigravityMutationRules.stringArg(args['CommandLine'])
        if (command !== null)
          events.shellRun({ command, startedAt: createdAt, endedAt: createdAt })
        continue
      }
      if (this.groups === 0) continue
      const mutation = AntigravityMutationRules.mutationOf(
        call.name,
        args,
        createdAt,
        `antigravity-tool-${this.sequence}-${callIndex}`,
      )
      if (mutation !== null) events.mutation(mutation, this.groups - 1)
    }
  }

  private static mutationOf(
    name: unknown,
    args: Record<string, unknown>,
    createdAt: number,
    mutationId: string,
  ): RawFileChangesLogMutation | null {
    if (name !== 'edit_file' && name !== 'write_file') return null
    const path = AntigravityMutationRules.stringArg(args['Path'])
    if (path === null || !path.trim()) return null
    if (name === 'write_file') {
      const afterContent = AntigravityMutationRules.stringArg(args['Content'])
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
    const oldText = AntigravityMutationRules.stringArg(args['Target'])
    const newText = AntigravityMutationRules.stringArg(args['Replacement'])
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

/** Lines that are blank or no JSON count for nothing, exactly as the full parsers skip them. */
class SessionMutationLineExtractor implements SessionMutationExtractor {
  private readonly rules: SessionMutationRules
  private batch: SessionMutationBatch = { mutations: [], shellRuns: [] }
  private readonly events: SessionMutationEvents

  constructor(rules: SessionMutationRules) {
    this.rules = rules
    this.events = {
      group: () => {},
      spawn: () => {},
      mutation: (mutation) => { this.batch.mutations.push(mutation) },
      shellRun: (run) => { this.batch.shellRuns.push(run) },
    }
  }

  push(lines: readonly string[]): void {
    for (const line of lines) {
      if (!line.trim()) continue
      let raw: unknown
      try { raw = JSON.parse(line) }
      catch { continue }
      this.rules.record(raw, this.events)
    }
  }

  drain(): SessionMutationBatch {
    const batch = this.batch
    this.batch = { mutations: [], shellRuns: [] }
    return batch
  }

  state(): unknown {
    return this.rules.state()
  }
}

/** Throws on a `state` that does not fit the agent; the caller then reads the file from its start. */
export function sessionMutationExtractor(
  agentId: FileChangesAgentId,
  role: SessionMutationRole,
  state?: unknown,
): SessionMutationExtractor {
  return new SessionMutationLineExtractor(SessionMutationRules.of(agentId, role, state))
}
