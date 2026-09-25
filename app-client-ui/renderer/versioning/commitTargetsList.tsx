import { useRef, useState } from 'react'

import type { FileChangeEntry, FileChangesWorkingTreeSnapshot } from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import { VersioningRevert } from '../../shared/versioningCommit'
import { FileChangesStatusMark } from '../fileViewer/fileChangesStatusMark'
import { ContextMenu, type ContextMenuPosition } from '../widgets/contextMenu'

export class CommitTargets {
  static blocked(entry: FileChangeEntry): boolean {
    return entry.status === 'conflicted' || entry.status === 'obstructed'
  }

  static eligible(snapshot: FileChangesWorkingTreeSnapshot): readonly FileChangeEntry[] {
    return snapshot.entries.filter((entry) => !CommitTargets.blocked(entry)
      && CommitTargets.carrier(entry, snapshot.entries) === null
      && CommitTargets.removedBy(entry, snapshot.entries) === null)
  }

  /**
   * The deleted directory a row sits inside, or null when this commit removes nothing above it.
   *
   * `svn delete --keep-local` publishes the removal and leaves the files on disk, so every one of
   * them comes back as an untracked row below a `deleted` directory. Checking one is not a second
   * change beside the deletion: staging it runs `svn add --parents`, which REPLACES that directory
   * instead, and the subtree the dialog says it deletes is published again. Every eligible row is
   * checked by default, which puts that reversal one confirmation away, so this row carries no
   * checkbox of its own.
   *
   * SVN only, without asking which VCS: git has no directory node, and a directory row this
   * listing composes is `deleted` only when every descendant it has is, which leaves no untracked
   * row inside it.
   */
  static removedBy(entry: FileChangeEntry, entries: readonly FileChangeEntry[]): FileChangeEntry | null {
    if (entry.status !== 'untracked') return null
    const path = entry.path.replace(/\\/g, '/')
    return entries.filter((candidate) => candidate.nodeKind === 'directory' && candidate.status === 'deleted'
      && path.startsWith(`${candidate.path.replace(/\\/g, '/').replace(/\/$/, '')}/`))
      .sort((left, right) => right.path.length - left.path.length)[0] ?? null
  }

  /**
   * The copied directory a row is published by, or null when the row stands on its own.
   *
   * A copy commits as ONE node: the server takes the whole subtree from the copyfrom source, so a
   * file inside it has no commit of its own to be kept out of. Its checkbox therefore follows the
   * directory's instead of offering a choice SVN would ignore. A file MODIFIED after the copy is
   * not one of these - it reaches the pane with its own status and stays its own target.
   */
  static carrier(entry: FileChangeEntry, entries: readonly FileChangeEntry[]): FileChangeEntry | null {
    if (entry.status !== 'copied') return null
    const path = entry.path.replace(/\\/g, '/')
    return entries.filter((candidate) => candidate.nodeKind === 'directory' && candidate.status === 'added'
      && path.startsWith(`${candidate.path.replace(/\\/g, '/').replace(/\/$/, '')}/`))
      .sort((left, right) => right.path.length - left.path.length)[0] ?? null
  }

  static requiredParent(entry: FileChangeEntry, entries: readonly FileChangeEntry[], checked: ReadonlySet<string>): boolean {
    const prefix = `${entry.path.replace(/\\/g, '/').replace(/\/$/, '')}/`
    return entry.nodeKind === 'directory' && (entry.status === 'added' || entry.status === 'untracked')
      && entries.some((child) => checked.has(child.fileId) && child.path.replace(/\\/g, '/').startsWith(prefix))
  }

  static selected(entries: readonly FileChangeEntry[], checked: ReadonlySet<string>): readonly FileChangeEntry[] {
    return entries.filter((entry) => checked.has(entry.fileId) || CommitTargets.requiredParent(entry, entries, checked))
  }
}

export function CommitTargetsList(props: {
  snapshot: FileChangesWorkingTreeSnapshot
  checked: ReadonlySet<string>
  disabled: boolean
  onChange(ids: ReadonlySet<string>): void
  onOpen(entry: FileChangeEntry): void
  onMenuOpen(): void
  onOpenExternal: ((entry: FileChangeEntry) => void) | null
  onRevert(entry: FileChangeEntry): void
  onOpenSeparately(scopeRoot: string): void
}): React.JSX.Element {
  const element = useRef<HTMLDivElement>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ path: string; position: ContextMenuPosition } | null>(null)
  const externalOf = new Map<string, FileChangesWorkingTreeSnapshot['externalRoots'][number]>()
  for (const root of [...props.snapshot.externalRoots].sort((left, right) => left.path.length - right.path.length))
    for (const id of root.fileIds) externalOf.set(id, root)
  const entries = [...props.snapshot.entries].sort((left, right) =>
    Number(right.nodeKind === 'directory') - Number(left.nodeKind === 'directory') || left.displayPath.localeCompare(right.displayPath))
  const mainEntries = entries.filter((entry) => !externalOf.has(entry.fileId))
  const menuEntry = entries.find((entry) => entry.path === menu?.path)
  const activePath = entries.some((entry) => entry.path === selectedPath) ? selectedPath : mainEntries[0]?.path ?? entries[0]?.path
  const change = (entry: FileChangeEntry, checked: boolean): void => {
    const next = new Set(props.checked)
    if (checked) next.add(entry.fileId)
    else next.delete(entry.fileId)
    props.onChange(next)
  }
  const open = (entry: FileChangeEntry): void => {
    if (!props.disabled && entry.nodeKind === 'file') props.onOpen(entry)
  }
  const row = (entry: FileChangeEntry): React.JSX.Element => {
    const requiredParent = CommitTargets.requiredParent(entry, entries, props.checked)
    const carrier = CommitTargets.carrier(entry, entries)
    const removedBy = CommitTargets.removedBy(entry, entries)
    const hint = requiredParent ? 'Required parent directory'
      : carrier !== null ? `Commits with ${carrier.displayPath}/, which was copied whole`
      : removedBy !== null ? `Stays on disk unversioned: this commit deletes ${removedBy.displayPath}/`
      : entry.status === 'untracked' && entry.nodeKind === 'directory' ? 'Adds this directory only; select its files individually'
      : entry.status === 'modified' && entry.nodeKind === 'directory' ? 'Commits directory properties only; select its files individually' : null
    return <div key={entry.path} role="row" aria-selected={entry.path === selectedPath}
      className="commit-target" tabIndex={entry.path === activePath ? 0 : -1}
      title={entry.path} onFocus={() => setSelectedPath(entry.path)}
      onClick={(event) => { setSelectedPath(entry.path); if (!(event.target instanceof HTMLInputElement)) event.currentTarget.focus() }}
      onDoubleClick={(event) => { if (!(event.target instanceof HTMLInputElement)) open(entry) }}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        event.currentTarget.focus()
        setSelectedPath(entry.path)
        props.onMenuOpen()
        setMenu({ path: entry.path, position: { x: event.clientX, y: event.clientY } })
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
          event.preventDefault()
          event.stopPropagation()
          const rows = [...(element.current?.querySelectorAll<HTMLElement>('.commit-target') ?? [])]
          const index = rows.indexOf(event.currentTarget)
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
            : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
          rows[next]?.focus()
        }
        else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault()
          event.stopPropagation()
          const box = event.currentTarget.getBoundingClientRect()
          props.onMenuOpen()
          setMenu({ path: entry.path, position: { x: box.left, y: box.bottom } })
        }
      }}>
      <span role="gridcell"><input type="checkbox" aria-label={`Include ${entry.displayPath}`}
        checked={requiredParent || props.checked.has(carrier?.fileId ?? entry.fileId)}
        disabled={props.disabled || CommitTargets.blocked(entry) || requiredParent || carrier !== null || removedBy !== null}
        onChange={(event) => change(entry, event.target.checked)} /></span>
      <span role="gridcell" className={`file-tools-status file-tools-status--${entry.status}`} title={entry.status} aria-label={entry.status}>{FileChangesStatusMark.of(entry.status)}</span>
      <span role="gridcell" className={`commit-target-path commit-target-path--${entry.status}`}>{entry.displayPath}{entry.nodeKind === 'directory' ? '/' : ''}
        {entry.previousDisplayPath !== null && <span className="commit-target-previous"> (from {entry.previousDisplayPath})</span>}
        {hint !== null && <span className="commit-target-hint" title={hint} aria-label={hint}>ⓘ</span>}
      </span>
    </div>
  }
  return <div className="commit-targets">
    <div className="commit-selection">
      <button type="button" disabled={props.disabled} onClick={() => props.onChange(new Set(CommitTargets.eligible(props.snapshot).map((entry) => entry.fileId)))}>Select all</button>
      <button type="button" disabled={props.disabled} onClick={() => props.onChange(new Set())}>Select none</button>
      <span>{CommitTargets.selected(entries, props.checked).length} selected</span>
    </div>
    {entries.some((entry) => externalOf.has(entry.fileId)) && <div className="commit-groups-note">One message for all selected groups. Each group is committed separately.</div>}
    <div className="commit-files" ref={element} role="grid" aria-label="Commit files">
      <div role="row" className="commit-files-heading"><span role="columnheader" aria-label="Include" /><span role="columnheader" aria-label="Status" /><span role="columnheader">Path</span></div>
      <div role="rowgroup">{mainEntries.map((entry) => row(entry))}</div>
      {props.snapshot.externalRoots.map((root) => {
        const changes = entries.filter((entry) => externalOf.get(entry.fileId) === root)
        if (changes.length === 0) return null
        return <div key={root.path} role="rowgroup" className="commit-external">
          <div role="row"><div role="gridcell" aria-colspan={3} className="commit-external-heading">
            <strong>External: {root.displayPath}</strong>
            <button type="button" disabled={props.disabled} title="Move this group to a separate tab for a different commit message"
              onClick={() => {
                props.onChange(new Set([...props.checked].filter((id) => !root.fileIds.includes(id))))
                props.onOpenSeparately(root.path)
              }}>Commit separately</button>
          </div></div>
          {changes.map((entry) => row(entry))}
        </div>
      })}
    </div>
    {menu !== null && menuEntry !== undefined && <ContextMenu position={menu.position} ariaLabel={`Actions for ${menuEntry.displayPath}`}
      items={[
        { key: 'diff', label: 'Show diff', disabled: props.disabled || menuEntry.nodeKind !== 'file', onSelect: () => open(menuEntry) },
        ...(props.onOpenExternal === null ? [] : [{ key: 'external-diff', label: 'Show external diff',
          disabled: props.disabled || menuEntry.nodeKind !== 'file', onSelect: () => props.onOpenExternal?.(menuEntry) }]),
        { kind: 'separator', key: 'changes' },
        { key: 'revert', label: 'Revert…', disabled: props.disabled || externalOf.has(menuEntry.fileId) || !VersioningRevert.allows(menuEntry), onSelect: () => props.onRevert(menuEntry) },
      ]}
      onClose={() => setMenu(null)} />}
  </div>
}
