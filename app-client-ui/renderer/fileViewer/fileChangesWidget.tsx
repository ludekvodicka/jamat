import type { AppClientUiBridge } from '../../shared/appClientUiIpc'
import { useEffect, useMemo, useRef, useState } from 'react'

import type {
  FileChangeBaseline,
  FileChangeEntry,
  FileChangeGroup,
} from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import { IpcFailure } from '../ipc/ipcFailure'
import { FileChangesOpen } from './fileChangesOpen'
import { FileChangesSort, type FileChangesSortKey } from './fileChangesSort'
import { FileChangesTime } from './fileChangesTime'
import { FileChangesStatusMark, type FileChangesMarkConventions } from './fileChangesStatusMark'
import type { FileViewerChangedOpen, FileChangesViewModel } from './fileViewerPanel.types'
import './fileTools.css'

export function FileChangesWidget(props: {
  openFile: AppClientUiBridge['fileChanges']['openFile']
  release: AppClientUiBridge['fileViewer']['release']
  model: FileChangesViewModel
  visible?: boolean
  onOpen(value: FileViewerChangedOpen): void
}): React.JSX.Element {
  const [opening, setOpening] = useState<string | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  /** Which open is the current one, so a slower answer cannot outrank a later click. */
  const openings = useRef(0)
  const [sort, setSort] = useState<FileChangesSortKey>('recent')
  const snapshot = props.model.snapshot
  const visible = props.visible !== false
  const latestSnapshot = useRef(snapshot)
  useEffect(() => {
    latestSnapshot.current = snapshot
    setOpening(null)
    setOpenError(null)
  }, [snapshot?.snapshotId])
  useEffect(() => () => { openings.current += 1 }, [])

  /**
   * Two clicks are one keystroke apart in a list of changes, and the answers come back in whatever
   * order the disk decides. Without the guard the panel showed whichever answer arrived SECOND, the
   * first answer cleared the mark from the second row, and a refusal for one file was drawn over
   * another that opened fine. Click a large file and then a small one: the small one opened and the
   * panel then jumped to the large one.
   */
  const open = async (entry: FileChangeEntry, baseline: FileChangeBaseline | null): Promise<void> => {
    if (!snapshot || entry.nodeKind !== 'file') return
    const current = ++openings.current
    setOpening(entry.fileId)
    setOpenError(null)
    const isCurrent = (fresh: FileViewerChangedOpen['snapshot']): boolean => current === openings.current
      && (latestSnapshot.current?.snapshotId === snapshot.snapshotId || latestSnapshot.current?.snapshotId === fresh.snapshotId)
    const opened = await FileChangesOpen.read({ snapshot, entry, openFile: props.openFile,
      baselineHint: baseline === null ? null : { kind: baseline.kind, revision: baseline.revision },
      refresh: () => props.model.reload(), isCurrent })
    const { answer } = opened
    if (!isCurrent(opened.snapshot)) {
      if (answer.ok && answer.value.ok) await props.release(answer.value.value.documentId)
      return
    }
    setOpening(null)
    const refusal = IpcFailure.of(answer)
    if (refusal !== null) {
      setOpenError(refusal)
      return
    }
    if (!answer.ok || !answer.value.ok) return
    props.onOpen({
      document: answer.value.value,
      snapshot: opened.snapshot,
      fileId: opened.fileId,
      baselineHint: opened.baselineHint,
    })
  }

  return (
    <div className="file-tools-changes">
      <div className="file-tools-controls">
        {snapshot && snapshot.vcs.available.length > 1 && (
          <select
            aria-label="Version control system"
            value={props.model.preferredVcs ?? ''}
            onChange={(event) => {
              const value = event.target.value
              if (value === '') void props.model.reload(null)
              else if (value === 'git' || value === 'svn') void props.model.reload(value)
              else throw new Error(`Unknown VCS selection: ${JSON.stringify(value)}`)
            }}
          >
            <option value="">Configured VCS</option>
            {snapshot.vcs.available.map((vcs) => (
              <option value={vcs} key={vcs}>{vcs.toUpperCase()}</option>
            ))}
          </select>
        )}
        <select
          className="file-tools-sort"
          aria-label="Sort changed files"
          title="Sort changed files"
          value={sort}
          onChange={(event) => {
            const value = event.target.value
            if (value === 'recent' || value === 'name') setSort(value)
            else throw new Error(`Unknown sort selection: ${JSON.stringify(value)}`)
          }}
        >
          <option value="recent">{FileChangesSort.labelOf('recent')}</option>
          <option value="name">{FileChangesSort.labelOf('name')}</option>
        </select>
        <button
          type="button"
          disabled={props.model.loading}
          onClick={() => void props.model.reload()}
        >
          Refresh
        </button>
      </div>
      {props.model.loading && <p className="file-tools-note">Reading changes...</p>}
      {props.model.error && <p className="file-tools-error">{props.model.error}</p>}
      {openError && <p className="file-tools-error">{openError}</p>}
      {snapshot && (
        <>
          {/*
            First, not last. These used to be printed after the entries, after every history group
            and after the Load-older button, which is below the fold in any list worth scrolling -
            so a measurement that FAILED was drawn as `GIT · 0 changed` with `No changed files.`
            under it, and the one line saying otherwise was somewhere off screen. "There is nothing
            here" is the state a person acts on before discarding a worktree; it must never be a
            failure wearing that face.
          */}
          {snapshot.warnings.map((warning) => (
            <p className="file-tools-warning" key={warning}>{warning}</p>
          ))}
          <div className="file-tools-summary">
            <span>{snapshot.vcs.selected?.toUpperCase() ?? 'No VCS'}</span>
            <span>{snapshot.entries.length} changed</span>
          </div>
          <FileChangeEntries
            entries={snapshot.entries}
            baseline={snapshot.defaultBaseline}
            conventions={FileChangesStatusMark.ofVcs(snapshot.vcs.selected)}
            sort={sort}
            visible={visible}
            opening={opening}
            onOpen={open}
            measured={snapshot.warnings.length === 0}
          />
          {props.model.groups.map((group) => (
            <FileChangeHistoryGroup
              key={group.groupId}
              group={group}
              conventions={FileChangesStatusMark.ofVcs(snapshot.vcs.selected)}
              sort={sort}
              visible={visible}
              opening={opening}
              onOpen={open}
            />
          ))}
          {props.model.nextCursor !== null && (
            <button
              className="file-tools-load-more"
              type="button"
              disabled={props.model.loadingMore}
              onClick={() => void props.model.loadMore()}
            >
              {props.model.loadingMore ? 'Loading...' : 'Load older changes'}
            </button>
          )}
        </>
      )}
    </div>
  )
}

class FileChangesWidgetConst {
  static readonly secondTickMilliseconds = 1_000
  static readonly minuteTickMilliseconds = 60_000
  /**
   * Past an hour every label this draws is in whole days or hours, so a second-by-second clock
   * changes nothing anybody can see.
   */
  static readonly tickWhileYoungerThanMilliseconds = 60 * 60_000

  static nextTickDelay(elapsedMs: number): number | null {
    const elapsed = Math.max(0, elapsedMs)
    if (elapsed >= FileChangesWidgetConst.tickWhileYoungerThanMilliseconds) return null
    if (elapsed < FileChangesWidgetConst.minuteTickMilliseconds) return FileChangesWidgetConst.secondTickMilliseconds
    return FileChangesWidgetConst.minuteTickMilliseconds
  }
}

/**
 * Leaf clock for one row's "ago" label: updates only its own span, pauses while the panel or
 * sidebar is hidden, backs off from 1 s to 1 min past a minute, and stops past an hour.
 */
function FileChangeAge(props: {
  modifiedAt: number | null
  status: string
  visible: boolean
}): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!props.visible || props.modifiedAt === null) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const schedule = (): void => {
      const current = Date.now()
      setNow(current)
      const delay = FileChangesWidgetConst.nextTickDelay(current - props.modifiedAt!)
      if (delay !== null) timer = setTimeout(schedule, delay)
    }
    const current = Date.now()
    if (current - now >= FileChangesWidgetConst.secondTickMilliseconds) setNow(current)
    const initialDelay = FileChangesWidgetConst.nextTickDelay(current - props.modifiedAt)
    if (initialDelay !== null) timer = setTimeout(schedule, initialDelay)
    return () => { if (timer !== null) clearTimeout(timer) }
  }, [props.modifiedAt, props.visible])
  return (
    <span className="file-tools-when" title={props.status}>
      {props.modifiedAt === null
        ? props.status
        : FileChangesTime.agoOf(props.modifiedAt, now)}
    </span>
  )
}

function FileChangeHistoryGroup(props: {
  group: FileChangeGroup
  conventions: FileChangesMarkConventions
  sort: FileChangesSortKey
  visible: boolean
  opening: string | null
  onOpen(entry: FileChangeEntry, baseline: FileChangeBaseline): Promise<void>
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const createdLabel = useMemo(() => new Date(props.group.createdAt).toLocaleString(), [props.group.createdAt])
  return (
    <details
      className="file-tools-history"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span>{props.group.label}</span>
        <span>{createdLabel}</span>
      </summary>
      {open && (
        <>
          {props.group.message && <p>{props.group.message}</p>}
          <FileChangeEntries
            entries={props.group.entries}
            baseline={props.group.baseline}
            conventions={props.conventions}
            sort={props.sort}
            visible={props.visible}
            opening={props.opening}
            onOpen={props.onOpen}
          />
        </>
      )}
    </details>
  )
}

function FileChangeEntries(props: {
  entries: readonly FileChangeEntry[]
  baseline: FileChangeBaseline | null
  conventions: FileChangesMarkConventions
  sort: FileChangesSortKey
  visible: boolean
  opening: string | null
  onOpen(entry: FileChangeEntry, baseline: FileChangeBaseline | null): Promise<void>
  /** False when something above this list failed, so an empty list is not an answer about the tree. */
  measured?: boolean
}): React.JSX.Element {
  const sorted = useMemo(
    () => FileChangesSort.apply(props.entries, props.sort),
    [props.entries, props.sort],
  )
  if (props.entries.length === 0)
    return props.measured === false
      ? <p className="file-tools-note">Changes could not be measured.</p>
      : <p className="file-tools-note">No changed files.</p>
  return (
    <ul className="file-tools-file-list">
      {sorted.map((entry) => (
        <li key={`${entry.fileId}:${entry.displayPath}`}>
          <button
            type="button"
            disabled={entry.nodeKind === 'directory' || props.opening === entry.fileId}
            title={entry.path}
            onClick={() => void props.onOpen(entry, props.baseline)}
          >
            <span
              className={`file-tools-status file-tools-status--${entry.status}`}
              title={entry.status}
            >
              {FileChangesStatusMark.of(entry.status, props.conventions)}
            </span>
            <span className="file-tools-file-path">
              {entry.previousDisplayPath
                ? `${entry.previousDisplayPath} → ${entry.displayPath}`
                : entry.displayPath}
            </span>
            <FileChangeAge modifiedAt={entry.modifiedAt} status={entry.status} visible={props.visible} />
            {entry.gitState && (
              <span className="file-tools-location" title="Git index / worktree">
                {entry.gitState.index}/{entry.gitState.worktree}
              </span>
            )}
            <span className="file-tools-location">{entry.location === 'external' ? 'outside' : ''}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}
