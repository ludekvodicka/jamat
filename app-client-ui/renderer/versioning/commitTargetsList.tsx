import { useRef, useState } from 'react'

import type { FileChangeEntry, FileChangesWorkingTreeSnapshot } from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import { VersioningRevert } from '../../shared/versioningCommit'
import { FileChangesStatusMark } from '../fileViewer/fileChangesStatusMark'
import { ContextMenu, type ContextMenuPosition } from '../widgets/contextMenu'

export class CommitTargets {
  static visible(entry: FileChangeEntry): boolean {
    return entry.nodeKind !== 'directory' || entry.status !== 'modified'
  }

  static blocked(entry: FileChangeEntry): boolean {
    return entry.status === 'conflicted' || entry.status === 'obstructed'
  }

  static eligible(snapshot: FileChangesWorkingTreeSnapshot): readonly FileChangeEntry[] {
    const externalIds = new Set(snapshot.externalRoots.flatMap((root) => root.fileIds))
    return snapshot.entries.filter((entry) => CommitTargets.visible(entry) && !externalIds.has(entry.fileId) && !CommitTargets.blocked(entry))
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
  const externalIds = new Set(props.snapshot.externalRoots.flatMap((root) => root.fileIds))
  const entries = props.snapshot.entries.filter(CommitTargets.visible).sort((left, right) => left.displayPath.localeCompare(right.displayPath))
  const mainEntries = entries.filter((entry) => !externalIds.has(entry.fileId))
  const menuEntry = entries.find((entry) => entry.path === menu?.path)
  const activePath = entries.some((entry) => entry.path === selectedPath) ? selectedPath : mainEntries[0]?.path ?? entries[0]?.path
  const change = (entry: FileChangeEntry, checked: boolean): void => {
    const next = new Set(props.checked)
    if (checked) next.add(entry.fileId)
    else next.delete(entry.fileId)
    props.onChange(next)
  }
  const open = (entry: FileChangeEntry): void => {
    if (!props.disabled && entry.nodeKind === 'file' && !externalIds.has(entry.fileId)) props.onOpen(entry)
  }
  const row = (entry: FileChangeEntry, external: boolean): React.JSX.Element => {
    const requiredParent = !external && CommitTargets.requiredParent(entry, mainEntries, props.checked)
    const hint = requiredParent ? 'Required parent directory'
      : entry.status === 'untracked' && entry.nodeKind === 'directory' ? 'Adds this directory only; select its files individually' : null
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
        checked={!external && (requiredParent || props.checked.has(entry.fileId))}
        disabled={props.disabled || external || CommitTargets.blocked(entry) || requiredParent}
        onChange={(event) => change(entry, event.target.checked)} /></span>
      <span role="gridcell" className={`file-tools-status file-tools-status--${entry.status}`} title={entry.status} aria-label={entry.status}>{FileChangesStatusMark.of(entry.status)}</span>
      <span role="gridcell" className="commit-target-path">{entry.displayPath}{entry.nodeKind === 'directory' ? '/' : ''}
        {entry.previousDisplayPath !== null && <span className="commit-target-previous"> (from {entry.previousDisplayPath})</span>}
        {hint !== null && <span className="commit-target-hint" title={hint} aria-label={hint}>ⓘ</span>}
      </span>
    </div>
  }
  return <div className="commit-targets">
    <div className="commit-selection">
      <button type="button" disabled={props.disabled} onClick={() => props.onChange(new Set(CommitTargets.eligible(props.snapshot).map((entry) => entry.fileId)))}>Select all</button>
      <button type="button" disabled={props.disabled} onClick={() => props.onChange(new Set())}>Select none</button>
      <span>{CommitTargets.selected(mainEntries, props.checked).length} selected</span>
    </div>
    <div className="commit-files" ref={element} role="grid" aria-label="Commit files">
      <div role="row" className="commit-files-heading"><span role="columnheader" aria-label="Include" /><span role="columnheader" aria-label="Status" /><span role="columnheader">Path</span></div>
      <div role="rowgroup">{mainEntries.map((entry) => row(entry, false))}</div>
      {props.snapshot.externalRoots.map((root) => {
        const changes = entries.filter((entry) => root.fileIds.includes(entry.fileId))
        if (changes.length === 0) return null
        return <div key={root.path} role="rowgroup" className="commit-external">
          <div role="row"><div role="gridcell" aria-colspan={3} className="commit-external-heading">
            <strong>External: {root.displayPath}</strong>
            <button type="button" disabled={props.disabled} onClick={() => props.onOpenSeparately(root.path)}>Commit separately</button>
          </div></div>
          {changes.map((entry) => row(entry, true))}
        </div>
      })}
    </div>
    {menu !== null && menuEntry !== undefined && <ContextMenu position={menu.position} ariaLabel={`Actions for ${menuEntry.displayPath}`}
      items={[
        { key: 'diff', label: 'Show diff', disabled: props.disabled || menuEntry.nodeKind !== 'file' || externalIds.has(menuEntry.fileId), onSelect: () => open(menuEntry) },
        ...(props.onOpenExternal === null ? [] : [{ key: 'external-diff', label: 'Show external diff',
          disabled: props.disabled || menuEntry.nodeKind !== 'file' || externalIds.has(menuEntry.fileId), onSelect: () => props.onOpenExternal?.(menuEntry) }]),
        { kind: 'separator', key: 'changes' },
        { key: 'revert', label: 'Revert…', disabled: props.disabled || externalIds.has(menuEntry.fileId) || !VersioningRevert.allows(menuEntry), onSelect: () => props.onRevert(menuEntry) },
      ]}
      onClose={() => setMenu(null)} />}
  </div>
}
