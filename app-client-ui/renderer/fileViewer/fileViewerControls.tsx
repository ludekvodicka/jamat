import type {
  FileChangeBaseline,
  FileChangeGroup,
  FileChangesSnapshot,
  FileChangesWorkingTreeSnapshot,
} from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import type {
  FileViewerDocument,
  FileViewerViewMode,
} from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import type { FileViewerBaselineHint } from './fileViewerPanel.types'
import { FileViewerPath } from './fileViewerPath'
import { FileViewerZoom } from './fileViewerZoom'

export interface FileViewerDiffTarget {
  snapshotId: string
  fileId: string
  baseline: FileChangeBaseline
  hint: FileViewerBaselineHint
}

export function FileViewerViewControl(props: {
  modes: readonly FileViewerViewMode[]
  value: FileViewerViewMode
  onChange(mode: FileViewerViewMode): void
}): React.JSX.Element {
  return (
    <div className="file-viewer-view-control" aria-label="File view mode">
      {props.modes.map((mode) => (
        <button
          type="button"
          key={mode}
          aria-pressed={props.value === mode}
          onClick={() => props.onChange(mode)}
        >
          {FileViewerControls.label(mode)}
        </button>
      ))}
    </div>
  )
}

export function FileViewerDiffControl(props: {
  targets: readonly FileViewerDiffTarget[]
  value: FileViewerDiffTarget | null
  onChange(value: FileViewerDiffTarget | null): void
}): React.JSX.Element {
  if (props.targets.length === 0)
    return <span className="file-viewer-diff-empty">No recorded baseline</span>
  return (
    <label className="file-viewer-diff-control">
      <span>Diff against</span>
      <select
        value={props.value === null ? '' : FileViewerDiffTargets.identityOf(props.value.hint)}
        onChange={(event) => {
          const target = props.targets.find((item) =>
            FileViewerDiffTargets.identityOf(item.hint) === event.target.value) ?? null
          props.onChange(target)
        }}
      >
        <option value="">Select baseline</option>
        {props.targets.map((target) => (
          <option
            key={FileViewerDiffTargets.identityOf(target.hint)}
            value={FileViewerDiffTargets.identityOf(target.hint)}
          >
            {target.baseline.label} ({FileViewerControls.baselineLabel(target.baseline)})
          </option>
        ))}
      </select>
    </label>
  )
}

/**
 * Reading size for this document alone, as a percentage of the size every viewer is configured for.
 * The readout is the reset: 100 % is "whatever the settings say", so there is one press back to it
 * from either direction.
 */
export function FileViewerZoomControl(props: {
  percent: number
  onChange(percent: number): void
}): React.JSX.Element {
  return (
    <div className="file-viewer-zoom-control" aria-label="File zoom">
      <button
        type="button"
        aria-label="Zoom out"
        title="Zoom out (Ctrl + wheel down)"
        disabled={FileViewerZoom.isSmallest(props.percent)}
        onClick={() => props.onChange(FileViewerZoom.smaller(props.percent))}
      >
        -
      </button>
      <button
        type="button"
        className="file-viewer-zoom-value"
        title="Reset the zoom to 100 %"
        onClick={() => props.onChange(FileViewerZoom.defaultPercentConst)}
      >
        {props.percent} %
      </button>
      <button
        type="button"
        aria-label="Zoom in"
        title="Zoom in (Ctrl + wheel up)"
        disabled={FileViewerZoom.isLargest(props.percent)}
        onClick={() => props.onChange(FileViewerZoom.larger(props.percent))}
      >
        +
      </button>
    </div>
  )
}

/**
 * The manual half of freshness. The viewer reloads a changed file on its own, so this is what
 * answers "is what I am looking at really what is on disk" without waiting for the next tick - and
 * the only way back for a file that came back after being deleted.
 */
export function FileViewerReloadControl(props: {
  missing: boolean
  onReload(): void
}): React.JSX.Element {
  return (
    <>
      {props.missing && (
        <span className="file-viewer-gone" role="status">File is gone from disk</span>
      )}
      <button
        type="button"
        className="file-viewer-reload"
        title="Read the file from disk again"
        onClick={props.onReload}
      >
        Reload
      </button>
    </>
  )
}

export function FileViewerPathControl(props: {
  document: FileViewerDocument
  onExplorer(): void
}): React.JSX.Element {
  return (
    <div className="file-viewer-path-control">
      <span title={props.document.path}>{props.document.path}</span>
      <FileViewerCopyPathButton documentId={props.document.documentId} />
      <button type="button" onClick={props.onExplorer}>Explorer</button>
    </div>
  )
}

export function FileViewerCopyPathButton(props: { documentId: string }): React.JSX.Element {
  return (
    <button
      type="button"
      className="file-viewer-copy-path"
      title="Copy file path"
      onClick={() => void window.appClient.fileViewer.copyPath(props.documentId)}
    >
      Copy path
    </button>
  )
}

export class FileViewerDiffTargets {
  /**
   * What a baseline IS, rather than which listing it came from.
   *
   * `baselineId` is a token minted with `randomUUID()` on every `list()`, so the same commit, the
   * same HEAD and the same BASE get a different one after every refresh. Pairing a chosen baseline
   * by that id therefore matched nothing the moment a listing was rebuilt, and the selection fell
   * silently back to HEAD: a diff against a commit from last week became a diff against HEAD with
   * nothing said, while the question on screen still read as the one that had been asked.
   *
   * The kind and the revision are the fact the baseline names, and they are unique per baseline in
   * one listing - a chat message carries its own group id as its revision.
   */
  static identityOf(baseline: FileViewerBaselineHint): string {
    return JSON.stringify([
      baseline.kind,
      baseline.revision,
      baseline.workingTreeSource ?? null,
    ])
  }

  static of(
    snapshot: FileChangesSnapshot | null,
    groups: readonly FileChangeGroup[],
    path: string,
    workingSnapshots: readonly FileChangesWorkingTreeSnapshot[] = [],
  ): readonly FileViewerDiffTarget[] {
    const targets: FileViewerDiffTarget[] = []
    if (snapshot !== null) {
      const current = snapshot.entries.find((entry) =>
        entry.nodeKind === 'file' && FileViewerPath.equal(entry.path, path))
      if (current && snapshot.defaultBaseline)
        targets.push(FileViewerDiffTargets.target(
          snapshot.snapshotId,
          current.fileId,
          snapshot.defaultBaseline,
        ))
      for (const group of groups) {
        const entry = group.entries.find((item) =>
          item.nodeKind === 'file' && FileViewerPath.equal(item.path, path))
        if (entry)
          targets.push(FileViewerDiffTargets.target(
            snapshot.snapshotId,
            entry.fileId,
            group.baseline,
          ))
      }
    }
    for (const working of workingSnapshots) {
      const source = working.source.selected
      const entry = working.entries.find((item) =>
        item.nodeKind === 'file' && FileViewerPath.equal(item.path, path))
      if (source !== null && entry && working.defaultBaseline)
        targets.push(FileViewerDiffTargets.target(
          working.snapshotId,
          entry.fileId,
          working.defaultBaseline,
          source,
        ))
    }
    const seen = new Set<string>()
    return targets.filter((target) => {
      const identity = FileViewerDiffTargets.identityOf(target.hint)
      if (seen.has(identity)) return false
      seen.add(identity)
      return true
    })
  }

  static initial(
    targets: readonly FileViewerDiffTarget[],
    hint: FileViewerBaselineHint | undefined,
  ): FileViewerDiffTarget | null {
    if (hint) {
      const matched = FileViewerDiffTargets.sameAs(targets, hint)
      if (matched) return matched
    }
    return targets[0] ?? null
  }

  /** The target for one baseline in a listing that was just rebuilt, or null where it is gone. */
  static sameAs(
    targets: readonly FileViewerDiffTarget[],
    baseline: FileViewerBaselineHint,
  ): FileViewerDiffTarget | null {
    const identity = FileViewerDiffTargets.identityOf(baseline)
    return targets.find((target) =>
      FileViewerDiffTargets.identityOf(target.hint) === identity) ?? null
  }

  /**
   * What stays chosen when the listing is rebuilt: the same baseline under its fresh id, and only a
   * baseline that is genuinely gone falls back to the hint or to the first target.
   *
   * A decision about baselines rather than about React, so the panel's effect is one call to it. It
   * lived inside that effect until 2026-08-24, where the only way to reach it was to render the
   * panel and reload it, which nothing did - and it was wrong the whole time.
   */
  static keep(
    current: FileViewerDiffTarget | null,
    targets: readonly FileViewerDiffTarget[],
    hint: FileViewerBaselineHint | undefined,
  ): FileViewerDiffTarget | null {
    const matched = current === null ? null : FileViewerDiffTargets.sameAs(targets, current.hint)
    return matched ?? FileViewerDiffTargets.initial(targets, hint)
  }

  private static target(
    snapshotId: string,
    fileId: string,
    baseline: FileChangeBaseline,
    workingTreeSource?: FileViewerBaselineHint['workingTreeSource'],
  ): FileViewerDiffTarget {
    return {
      snapshotId,
      fileId,
      baseline,
      hint: {
        kind: baseline.kind,
        revision: baseline.revision,
        ...(workingTreeSource === undefined ? {} : { workingTreeSource }),
      },
    }
  }
}

export class FileViewerControls {
  static label(mode: FileViewerViewMode): string {
    if (mode === 'rendered') return 'Rendered'
    else if (mode === 'raw') return 'Raw'
    else if (mode === 'diff') return 'Diff'
    else if (mode === 'preview') return 'Preview'
    else if (mode === 'hex') return 'Hex'
    else throw new Error(`Unknown file viewer mode: ${JSON.stringify(mode)}`)
  }

  static baselineLabel(baseline: FileChangeBaseline): string {
    if (baseline.kind === 'git-head') return 'Git HEAD'
    else if (baseline.kind === 'svn-base') return 'SVN BASE'
    else if (baseline.kind === 'git-commit') return 'Git commit'
    else if (baseline.kind === 'svn-revision') return 'SVN revision'
    else if (baseline.kind === 'chat-message') return 'chat message'
    else throw new Error(`Unknown baseline kind: ${JSON.stringify(baseline.kind)}`)
  }
}
