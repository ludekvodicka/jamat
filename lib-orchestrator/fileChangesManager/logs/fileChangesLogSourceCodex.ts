import { JsonShape } from '../../shared/jsonShape'
import { ProviderTranscriptMessages } from '../../projectManager/providerTranscriptMessages'
import { FileChangesLogSource } from './fileChangesLogSource'
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
  }
}

interface CodexChange {
  type?: unknown
  content?: unknown
  unified_diff?: unknown
  move_path?: unknown
}

interface PendingFallback {
  message: string
  createdAt: number
  sequence: number
}

export class FileChangesLogSourceCodex extends FileChangesLogSource {
  readonly agentId = 'codex' as const

  protected parse(content: string): readonly RawFileChangesLogGroup[] {
    const groups: (RawFileChangesLogGroup & { mutations: RawFileChangesLogMutation[] })[] = []
    let current: (RawFileChangesLogGroup & { mutations: RawFileChangesLogMutation[] }) | null = null
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
      if (record.type !== 'event_msg'
        || record.payload?.type !== 'patch_apply_end'
        || record.payload.success !== true)
        continue
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
      current.mutations.push(...FileChangesLogSourceCodex.mutationsOf(record, createdAt, sequence))
    }
    return groups.filter((group) => group.mutations.length > 0)
  }

  private static openGroup(
    groups: (RawFileChangesLogGroup & { mutations: RawFileChangesLogMutation[] })[],
    message: string,
    createdAt: number,
    sequence: number,
  ): RawFileChangesLogGroup & { mutations: RawFileChangesLogMutation[] } {
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
    record: CodexRecord,
    createdAt: number,
    sequence: number,
  ): RawFileChangesLogMutation[] {
    const changes = FileChangesLogSourceCodex.objectOf(record.payload?.changes)
    return Object.entries(changes).map(([path, rawChange], index) => {
      const change = FileChangesLogSourceCodex.changeOf(rawChange)
      const movePath = typeof change.move_path === 'string' && change.move_path.trim()
        ? change.move_path
        : null
      const mutationId = `${String(record.payload?.call_id ?? `codex-patch-${sequence}`)}-${index}`
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

  private static objectOf(value: unknown): Record<string, unknown> {
    return (JsonShape.record(value) ?? {}) as Record<string, unknown>
  }

  private static changeOf(value: unknown): CodexChange {
    return (JsonShape.record(value) ?? {}) as CodexChange
  }
}
