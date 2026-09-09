import { useEffect, useMemo, useRef, useState } from 'react'

import type {
  FileChangeBaseline,
  FileChangeEntry,
  FileChangeGroup,
} from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import { IpcFailure } from '../ipc/ipcFailure'
import { FileChangesSort, type FileChangesSortKey } from './fileChangesSort'
import { FileChangesTime } from './fileChangesTime'
import { FileChangesStatusMark } from './fileChangesStatusMark'
import type { FileViewerChangedOpen, FileChangesViewModel } from './fileViewerPanel.types'
import './fileTools.css'

export function FileChangesWidget(props: {
  model: FileChangesViewModel
  onOpen(value: FileViewerChangedOpen): void
}): React.JSX.Element {
  const [opening, setOpening] = useState<string | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  /** Which open is the current one, so a slower answer cannot outrank a later click. */
  const openings = useRef(0)
  const [sort, setSort] = useState<FileChangesSortKey>('recent')
  const snapshot = props.model.snapshot
  // The newest thing on screen decides whether the clock is worth running at all.
  const youngest = useMemo(
    () => FileChangesAges.youngestOf(snapshot?.entries ?? [], props.model.groups),
    [props.model.groups, snapshot],
  )
  const now = useSecondsClock(youngest)

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
    const answer = await window.appClient.fileChanges.openFile(snapshot.snapshotId, entry.fileId)
    if (current !== openings.current) return
    setOpening(null)
    const refusal = IpcFailure.of(answer)
    if (refusal !== null) {
      setOpenError(refusal)
      return
    }
    if (!answer.ok || !answer.value.ok) return
    props.onOpen({
      document: answer.value.value,
      snapshot,
      fileId: entry.fileId,
      baselineHint: baseline === null
        ? null
        : { kind: baseline.kind, revision: baseline.revision },
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
            sort={sort}
            now={now}
            opening={opening}
            onOpen={open}
            measured={snapshot.warnings.length === 0}
          />
          {props.model.groups.map((group) => (
            <FileChangeHistoryGroup
              key={group.groupId}
              group={group}
              sort={sort}
              now={now}
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

/**
 * A clock for second-precision "ago" labels, which only exist near the present.
 *
 * It used to tick for the life of the panel, in every panel: a sidebar the layout hides is not
 * unmounted (`SidebarDock` says so out loud), and a dockview tab that is not on top is not either,
 * so a dozen invisible widgets re-rendered once a second forever - for labels that read `3d ago` and
 * do not change again this decade. It ticks while anything on screen is young enough to need it.
 */
class FileChangesAges {
  /** The newest timestamp anything on screen carries, or null when nothing carries one. */
  static youngestOf(
    entries: readonly FileChangeEntry[],
    groups: readonly FileChangeGroup[],
  ): number | null {
    let youngest: number | null = null
    const consider = (stamp: number | null): void => {
      if (stamp !== null && (youngest === null || stamp > youngest)) youngest = stamp
    }
    for (const entry of entries) consider(entry.modifiedAt)
    for (const group of groups) {
      consider(group.createdAt)
      for (const entry of group.entries) consider(entry.modifiedAt)
    }
    return youngest
  }
}

/**
 * The letter on a row's badge.
 *
 * It was `status.slice(0, 1)` over a ten-member union, so `modified`/`missing` both drew M,
 * `copied`/`conflicted` both C and `renamed`/`replaced` both R - and the last pair share a colour
 * too, which made them identical on screen. An eleventh status would have got a letter and a CSS
 * class nobody had written a rule for; here it is a compile error.
 */
function useSecondsClock(youngest: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  const ticking = youngest !== null
    && Date.now() - youngest < FileChangesWidgetConst.tickWhileYoungerThanMilliseconds
  useEffect(() => {
    if (!ticking) return
    const timer = setInterval(
      () => setNow(Date.now()),
      FileChangesWidgetConst.tickMilliseconds,
    )
    return () => clearInterval(timer)
  }, [ticking])
  return now
}

class FileChangesWidgetConst {
  static readonly tickMilliseconds = 1_000
  /**
   * Past an hour every label this draws is in whole days or hours, so a second-by-second clock
   * changes nothing anybody can see.
   */
  static readonly tickWhileYoungerThanMilliseconds = 60 * 60_000
}

function FileChangeHistoryGroup(props: {
  group: FileChangeGroup
  sort: FileChangesSortKey
  now: number
  opening: string | null
  onOpen(entry: FileChangeEntry, baseline: FileChangeBaseline): Promise<void>
}): React.JSX.Element {
  return (
    <details className="file-tools-history">
      <summary>
        <span>{props.group.label}</span>
        <span>{new Date(props.group.createdAt).toLocaleString()}</span>
      </summary>
      {props.group.message && <p>{props.group.message}</p>}
      <FileChangeEntries
        entries={props.group.entries}
        baseline={props.group.baseline}
        sort={props.sort}
        now={props.now}
        opening={props.opening}
        onOpen={props.onOpen}
      />
    </details>
  )
}

function FileChangeEntries(props: {
  entries: readonly FileChangeEntry[]
  baseline: FileChangeBaseline | null
  sort: FileChangesSortKey
  now: number
  opening: string | null
  onOpen(entry: FileChangeEntry, baseline: FileChangeBaseline | null): Promise<void>
  /** False when something above this list failed, so an empty list is not an answer about the tree. */
  measured?: boolean
}): React.JSX.Element {
  // Memoised because the seconds clock above re-renders this every second: without it a list of a
  // few thousand entries is copied and locale-compared once a second, per open panel, forever.
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
              {FileChangesStatusMark.of(entry.status)}
            </span>
            <span className="file-tools-file-path">
              {entry.previousDisplayPath
                ? `${entry.previousDisplayPath} → ${entry.displayPath}`
                : entry.displayPath}
            </span>
            <span className="file-tools-when" title={entry.status}>
              {entry.modifiedAt === null
                ? entry.status
                : FileChangesTime.agoOf(entry.modifiedAt, props.now)}
            </span>
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
