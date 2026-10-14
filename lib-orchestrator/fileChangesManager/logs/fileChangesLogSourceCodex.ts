import { basename } from 'node:path'

import { ProviderTranscriptMessages } from '../../projectManager/providerTranscriptMessages'
import type { ProviderTranscriptRef } from '../../projectManager/providerTranscriptView'
import { JsonShape } from '../../shared/jsonShape'
import {
  FileChangesLogSource,
  type ParsedFileChangesLog,
  type ParsedSubagentLog,
} from './fileChangesLogSource'
import type {
  RawFileChangesLogGroup,
  RawFileChangesLogMutation,
} from './fileChangesLogSource.types'

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

interface PendingFallback {
  message: string
  createdAt: number
  sequence: number
}

type CodexGroup = RawFileChangesLogGroup & { mutations: RawFileChangesLogMutation[] }

export class FileChangesLogSourceCodex extends FileChangesLogSource {
  /** `rollout-YYYY-MM-DDThh-mm-ss-<thread>.jsonl`, the thread's start in local time cut to the second. */
  private static readonly rolloutStartPatternConst = /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-/

  readonly agentId = 'codex' as const

  /** The child rollouts of a thread start after it, so the listing starts at the parent's own start. */
  subagentsSince(ref: ProviderTranscriptRef): number | null {
    const match = FileChangesLogSourceCodex.rolloutStartPatternConst.exec(basename(ref.file))
    if (match === null) return null
    const startedAt = Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`)
    return Number.isNaN(startedAt) ? null : startedAt
  }

  protected parse(content: string): ParsedFileChangesLog {
    const groups: CodexGroup[] = []
    const spawns = new Map<string, number>()
    let current: CodexGroup | null = null
    let fallback: PendingFallback | null = null
    let sequence = 0
    // The last time this file gave us, so a record whose own timestamp is missing or unreadable
    // inherits its neighbour's rather than the position it happens to sit at. These files are
    // written in order; a sequence number as a time is 1970 and the wrong end of the history.
    let lastCreatedAt = 0
    for (const raw of FileChangesLogSource.records(content)) {
      sequence += 1
      const message = ProviderTranscriptMessages.codex(raw)
      const record = FileChangesLogSourceCodex.recordOf(raw)
      const createdAt = FileChangesLogSource.timestamp(record.timestamp, lastCreatedAt)
      lastCreatedAt = createdAt
      if (message?.kind === 'explicit') {
        current = FileChangesLogSourceCodex.openGroup(groups, message.text, createdAt, sequence)
        fallback = null
        continue
      }
      if (message?.kind === 'fallback') {
        fallback = { message: message.text, createdAt, sequence }
        continue
      }
      if (fallback !== null && ProviderTranscriptMessages.isCodexPromptBoundary(raw)) {
        current = FileChangesLogSourceCodex.openGroup(
          groups,
          fallback.message,
          fallback.createdAt,
          fallback.sequence,
        )
        fallback = null
      }
      const patch = FileChangesLogSourceCodex.appliedPatchOf(record)
      const spawned = FileChangesLogSourceCodex.spawnedThreadsOf(record)
      if (patch === null && spawned.length === 0) continue
      if (current === null && fallback !== null) {
        current = FileChangesLogSourceCodex.openGroup(
          groups,
          fallback.message,
          fallback.createdAt,
          fallback.sequence,
        )
        fallback = null
      }
      if (current === null) continue
      for (const threadId of spawned)
        spawns.set(threadId, groups.length - 1)
      if (patch !== null)
        current.mutations.push(...FileChangesLogSourceCodex.mutationsOf(patch, createdAt, sequence))
    }
    return { groups, spawns }
  }

  /** A child rollout opens no group: its prompt came from the parent's `spawn_agent` call. */
  protected parseSubagent(content: string): ParsedSubagentLog {
    const mutations: RawFileChangesLogMutation[] = []
    let startedAt: number | null = null
    let sequence = 0
    let lastCreatedAt = 0
    for (const raw of FileChangesLogSource.records(content)) {
      sequence += 1
      const record = FileChangesLogSourceCodex.recordOf(raw)
      const createdAt = FileChangesLogSource.timestamp(record.timestamp, lastCreatedAt)
      lastCreatedAt = createdAt
      if (startedAt === null && createdAt > 0) startedAt = createdAt
      const patch = FileChangesLogSourceCodex.appliedPatchOf(record)
      if (patch !== null)
        mutations.push(...FileChangesLogSourceCodex.mutationsOf(patch, createdAt, sequence))
    }
    return { startedAt, mutations }
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
    const item = FileChangesLogSourceCodex.itemOf(record.payload.item)
    return item.type === 'FileChange' && item.status === 'completed'
      ? { callId: item.id, changes: item.changes }
      : null
  }

  /** The child thread ids a completed `spawn_agent` call names. */
  private static spawnedThreadsOf(record: CodexRecord): string[] {
    if (record.type !== 'event_msg' || record.payload?.type !== 'item_completed') return []
    const item = FileChangesLogSourceCodex.itemOf(record.payload.item)
    if (item.type !== 'CollabAgentToolCall' || item.tool !== 'spawn_agent') return []
    if (!Array.isArray(item.receiver_thread_ids)) return []
    return item.receiver_thread_ids.filter((id): id is string => typeof id === 'string' && id !== '')
  }

  private static openGroup(
    groups: CodexGroup[],
    message: string,
    createdAt: number,
    sequence: number,
  ): CodexGroup {
    const group = {
      groupId: `codex-message-${sequence}`,
      message: FileChangesLogSource.shortMessage(message),
      createdAt,
      mutations: [],
    }
    groups.push(group)
    return group
  }

  private static mutationsOf(
    patch: CodexAppliedPatch,
    createdAt: number,
    sequence: number,
  ): RawFileChangesLogMutation[] {
    const changes = FileChangesLogSourceCodex.objectOf(patch.changes)
    return Object.entries(changes).map(([path, rawChange], index) => {
      const change = FileChangesLogSourceCodex.changeOf(rawChange)
      const movePath = typeof change.move_path === 'string' && change.move_path.trim()
        ? change.move_path
        : null
      const mutationId = `${String(patch.callId ?? `codex-patch-${sequence}`)}-${index}`
      if (change.type === 'add' && typeof change.content === 'string')
        return FileChangesLogSourceCodex.mutation(
          mutationId, 'add', 'added', path, null, null, change.content, null, createdAt,
        )
      else if (change.type === 'delete' && typeof change.content === 'string')
        return FileChangesLogSourceCodex.mutation(
          mutationId, 'delete', 'deleted', path, null, change.content, null, null, createdAt,
        )
      else if (change.type === 'update' && typeof change.unified_diff === 'string')
        return FileChangesLogSourceCodex.mutation(
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

  private static recordOf(value: unknown): CodexRecord {
    return (JsonShape.record(value) ?? {}) as CodexRecord
  }

  private static itemOf(value: unknown): CodexItem {
    return (JsonShape.record(value) ?? {}) as CodexItem
  }

  private static objectOf(value: unknown): Record<string, unknown> {
    return (JsonShape.record(value) ?? {}) as Record<string, unknown>
  }

  private static changeOf(value: unknown): CodexChange {
    return (JsonShape.record(value) ?? {}) as CodexChange
  }
}
