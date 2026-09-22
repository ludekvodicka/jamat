import type { FileChangeEntry } from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import type { AppClientUiBridge } from '../../shared/appClientUiIpc'
import type { FileViewerBaselineHint, FileViewerChangedOpen } from './fileViewerPanel.types'
import { FileViewerDiffTargets } from './fileViewerControls'
import { FileViewerPath } from './fileViewerPath'

export class FileChangesOpen {
  static async read(input: {
    snapshot: FileViewerChangedOpen['snapshot']
    entry: FileChangeEntry
    baselineHint: FileViewerBaselineHint | null
    openFile: AppClientUiBridge['fileChanges']['openFile']
    refresh(): Promise<FileViewerChangedOpen['snapshot'] | null>
    isCurrent(snapshot: FileViewerChangedOpen['snapshot']): boolean
  }): Promise<{
    answer: Awaited<ReturnType<AppClientUiBridge['fileChanges']['openFile']>>
    snapshot: FileViewerChangedOpen['snapshot']
    fileId: string
    baselineHint: FileViewerBaselineHint | null
  }> {
    let snapshot = input.snapshot
    let fileId = input.entry.fileId
    let baselineHint = input.baselineHint
    let answer = await input.openFile(snapshot.snapshotId, fileId)
    if (answer.ok && !answer.value.ok && answer.value.code === 'snapshot-expired' && input.isCurrent(snapshot)) {
      const fresh = await input.refresh()
      if (fresh === null)
        return { answer: { ok: false, error: 'Could not refresh the file changes. Try opening the file again.' }, snapshot, fileId, baselineHint }
      snapshot = fresh
      if (input.isCurrent(snapshot)) {
        const entry = snapshot.entries.find((item) => item.nodeKind === 'file' && FileViewerPath.equal(item.path, input.entry.path))
        const isDefault = input.baselineHint === null || (input.snapshot.defaultBaseline !== null
          && input.baselineHint.kind === input.snapshot.defaultBaseline.kind
          && input.baselineHint.revision === input.snapshot.defaultBaseline.revision)
        const target = 'source' in snapshot || isDefault || input.baselineHint === null ? null : FileViewerDiffTargets.sameAs(
          FileViewerDiffTargets.of(snapshot, snapshot.history.groups, input.entry.path), input.baselineHint)
        if ('source' in input.snapshot && 'source' in snapshot && snapshot.source.selected !== input.snapshot.source.selected)
          answer = { ok: true, value: { ok: false, code: 'invalid-source', detail: 'The selected change source is no longer available.' } }
        else if ((isDefault && entry === undefined) || (!isDefault && target === null))
          answer = { ok: true, value: { ok: false, code: 'not-found', detail: 'This file or its selected baseline is no longer in the refreshed changes.' } }
        else {
          fileId = isDefault ? entry!.fileId : target!.fileId
          const baseline = isDefault ? snapshot.defaultBaseline : target!.baseline
          baselineHint = baseline === null ? null : {
            kind: baseline.kind, revision: baseline.revision,
            ...('source' in snapshot && snapshot.source.selected !== null ? { workingTreeSource: snapshot.source.selected } : {}),
          }
          answer = await input.openFile(snapshot.snapshotId, fileId)
        }
      }
    }
    return { answer, snapshot, fileId, baselineHint }
  }
}
