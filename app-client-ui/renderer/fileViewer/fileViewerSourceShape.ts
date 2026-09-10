import type {
  FileChangeBaselineKind,
  FileChangesWorkingTreeSource,
} from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import type {
  FileViewerDocumentSource,
  FileViewerLocation,
} from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import { JsonShape } from '../../shared/jsonShape'
import type { FileViewerBaselineHint } from './fileViewerPanel.types'

/**
 * What a document source and its baseline hint have to look like before anything trusts them.
 *
 * Two surfaces read these out of a saved layout now, not one: the file viewer panel, whose whole
 * parameters are a source, and a split item, which carries one per inner tab. The rules lived
 * inside `FileViewerPanelState` until the split arrived; a second copy there would have been two
 * answers to "is this a source" that could drift apart while both looked right.
 */
export class FileViewerSourceShape {
  /** `null` rather than a throw: both callers are reading a file somebody else may have written. */
  static read(value: unknown): FileViewerDocumentSource | null {
    if (!JsonShape.isRecord(value))
      return null
    const candidate = value as Partial<FileViewerDocumentSource>
    if (typeof candidate.sessionId !== 'string' || typeof candidate.path !== 'string')
      return null
    if (candidate.kind === 'workspace')
      return candidate as Extract<FileViewerDocumentSource, { kind: 'workspace' }>
    else if (candidate.kind === 'external')
      return typeof candidate.anchorPath === 'string'
        ? candidate as Extract<FileViewerDocumentSource, { kind: 'external' }>
        : null
    else if (candidate.kind === 'filesystem')
      return candidate as Extract<FileViewerDocumentSource, { kind: 'filesystem' }>
    else if (candidate.kind === 'detected')
      return candidate as Extract<FileViewerDocumentSource, { kind: 'detected' }>
    else
      return null
  }

  static hint(value: unknown): FileViewerBaselineHint | undefined {
    if (!JsonShape.isRecord(value))
      return undefined
    const candidate = value as Partial<FileViewerBaselineHint>
    // Typed, so a sixth kind is a compile error here rather than a saved panel quietly reopening
    // without the baseline it was diffing against, dropping out of diff mode and saying nothing.
    const kinds: readonly FileChangeBaselineKind[] = [
      'git-head', 'svn-base', 'git-commit', 'svn-revision', 'chat-message',
    ]
    if (typeof candidate.kind !== 'string'
      || !kinds.includes(candidate.kind as FileChangeBaselineKind))
      return undefined
    if (candidate.revision !== null && typeof candidate.revision !== 'string')
      return undefined
    const sources: readonly FileChangesWorkingTreeSource[] = [
      'checkpoint', 'svn', 'worktree-base', 'git',
    ]
    if (candidate.workingTreeSource !== undefined
      && !sources.includes(candidate.workingTreeSource))
      return undefined
    return candidate as FileViewerBaselineHint
  }

  static location(value: unknown): FileViewerLocation | undefined {
    if (!JsonShape.isRecord(value)
      || !Number.isSafeInteger(value.line)
      || (value.line as number) < 1)
      return undefined
    return value as unknown as FileViewerLocation
  }
}
