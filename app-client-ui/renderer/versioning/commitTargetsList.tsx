import { useRef, useState } from 'react'

import type { FileChangeEntry, FileChangesWorkingTreeSnapshot } from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import { VersioningRevert } from '../../shared/versioningCommit'
import { FileChangesStatusMark } from '../fileViewer/fileChangesStatusMark'
import { FilePropertyChanges } from '../fileViewer/filePropertyChanges'
import { ContextMenu, type ContextMenuPosition } from '../widgets/contextMenu'

import { CommitTargets } from '../../shared/commitTargets'

export interface CommitRepositoryMessageItem {
  root: string
  displayPath: string
  repositoryName: string
  source: string
  expectedPrefix: string
  value: string
  findings: readonly { id: string; text: string }[]
  disabled: boolean
  open: boolean
  onToggle(open: boolean): void
  onChange(message: string): void
}

const normalizePath = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
const firstLineOf = (value: string): string => value.split(/\r?\n/).find((line) => line.trim() !== '')?.trim() ?? ''

export function CommitTargetsList(props: {
  snapshot: FileChangesWorkingTreeSnapshot
  checked: ReadonlySet<string>
  disabled: boolean
  scopeRoot?: string
  scopeTooltip?: string
  onChange(ids: ReadonlySet<string>): void
  onOpen(entry: FileChangeEntry): void
  onMenuOpen(): void
  onOpenExternal: ((entry: FileChangeEntry) => void) | null
  onRevert(entry: FileChangeEntry): void
  onOpenSeparately(scopeRoot: string): void
  separateMessages?: boolean
  repositoryMessages?: readonly CommitRepositoryMessageItem[]
}): React.JSX.Element {
  const element = useRef<HTMLDivElement>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ path: string; position: ContextMenuPosition } | null>(null)
  const [propertiesPath, setPropertiesPath] = useState<string | null>(null)
  const [collapsedFiles, setCollapsedFiles] = useState<Record<string, boolean>>({})
  const externalOf = new Map<string, FileChangesWorkingTreeSnapshot['externalRoots'][number]>()
  for (const root of [...props.snapshot.externalRoots].sort((left, right) => left.path.length - right.path.length))
    for (const id of root.fileIds) externalOf.set(id, root)
  const entries = [...props.snapshot.entries].sort(CommitTargets.byPath)
  const conventions = FileChangesStatusMark.ofSource(props.snapshot.source.selected)
  const mainEntries = entries.filter((entry) => !externalOf.has(entry.fileId))
  const menuEntry = entries.find((entry) => entry.path === menu?.path)
  const propertiesEntry = entries.find((entry) => entry.path === propertiesPath && entry.properties !== undefined)
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
  // The scope directory's own row, a property change of the folder under review, has no relative path.
  const nameOf = (entry: FileChangeEntry): string => entry.displayPath === '' ? '.' : `${entry.displayPath}${entry.nodeKind === 'directory' ? '/' : ''}`
  const row = (entry: FileChangeEntry): React.JSX.Element => {
    const name = nameOf(entry)
    const requiredParent = CommitTargets.requiredParent(entry, entries, props.checked)
    const carrier = CommitTargets.carrier(entry, entries)
    const removedBy = CommitTargets.removedBy(entry, entries)
    const hint = entry.carriedItems !== undefined ? `Copied whole: its ${entry.carriedItems} items commit with this directory and are not listed`
      : requiredParent ? 'Required parent directory'
      : carrier !== null ? `Commits with ${carrier.displayPath}/, which was copied whole`
      : removedBy !== null ? `Stays on disk unversioned: this commit deletes ${removedBy.displayPath}/`
      : entry.status === 'untracked' && entry.nodeKind === 'directory' ? 'Adds this directory only; select its files individually'
      : entry.status === 'modified' && entry.nodeKind === 'directory' ? 'Commits directory properties only; select its files individually' : null
    return <div key={entry.path} role="row" aria-selected={entry.path === selectedPath}
      className="commit-target" tabIndex={entry.path === activePath ? 0 : -1}
      title={entry.path} onFocus={() => setSelectedPath(entry.path)}
      onClick={(event) => { setSelectedPath(entry.path); if (!(event.target instanceof HTMLInputElement)) event.currentTarget.focus() }}
      onDoubleClick={(event) => {
        if (event.target instanceof HTMLInputElement) return
        // A directory has no content diff, so its properties are what there is to show.
        if (entry.nodeKind !== 'file' && entry.properties !== undefined) setPropertiesPath(entry.path)
        else open(entry)
      }}
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
      <span role="gridcell"><input type="checkbox" aria-label={`Include ${entry.displayPath || '.'}`}
        checked={requiredParent || props.checked.has(carrier?.fileId ?? entry.fileId)}
        disabled={props.disabled || CommitTargets.blocked(entry) || requiredParent || carrier !== null || removedBy !== null}
        onChange={(event) => change(entry, event.target.checked)} /></span>
      <span role="gridcell" className={`file-tools-status file-tools-status--${entry.status}`} title={entry.status} aria-label={entry.status}>{FileChangesStatusMark.of(entry.status, conventions)}</span>
      <span role="gridcell" className={`commit-target-path commit-target-path--${entry.status}`}>{name}
        {entry.origin === 'setup' && <span className="commit-target-previous"> (setup)</span>}
        {entry.carriedItems !== undefined && <span className="commit-target-previous"> ({entry.carriedItems} items)</span>}
        {entry.previousDisplayPath !== null && <span className="commit-target-previous"> ({entry.status === 'renamed' ? 'from' : 'moved from'} {entry.previousDisplayPath})</span>}
        {entry.properties !== undefined && <span className="commit-target-previous" title="Properties changed" aria-label="Properties changed"> (properties)</span>}
        {hint !== null && <span className="commit-target-hint" title={hint} aria-label={hint}>ⓘ</span>}
      </span>
    </div>
  }
  const eligible = CommitTargets.eligible(props.snapshot)
  const eligibleIds = new Set(eligible.map((entry) => entry.fileId))
  const allChecked = eligible.length > 0 && eligible.every((entry) => props.checked.has(entry.fileId))
  const someChecked = eligible.some((entry) => props.checked.has(entry.fileId))
  const selectAll = (): void => props.onChange(new Set(eligible.map((entry) => entry.fileId)))
  const selectNone = (): void => props.onChange(new Set())

  const remainingMessages = [...(props.repositoryMessages ?? [])]
  const takeMessage = (rootPath: string | undefined, displayPath: string): CommitRepositoryMessageItem | undefined => {
    const normalizedRoot = rootPath === undefined ? null : normalizePath(rootPath)
    const normalizedDisplay = normalizePath(displayPath)
    const index = remainingMessages.findIndex((item) =>
      (normalizedRoot !== null && normalizePath(item.root) === normalizedRoot)
      || normalizePath(item.displayPath) === normalizedDisplay)
    return index === -1 ? undefined : remainingMessages.splice(index, 1)[0]
  }

  interface RenderGroup {
    key: string
    displayPath: string
    rootPath?: string
    isExternal: boolean
    externalFileIds?: readonly string[]
    entries: FileChangeEntry[]
    repoMessage?: CommitRepositoryMessageItem
  }

  const groups: RenderGroup[] = []
  const mainMessage = takeMessage(props.scopeRoot, '')
  if (mainEntries.length > 0 || mainMessage !== undefined || props.snapshot.externalRoots.length === 0) {
    groups.push({
      key: 'main',
      displayPath: '',
      rootPath: props.scopeRoot,
      isExternal: false,
      entries: mainEntries,
      repoMessage: mainMessage,
    })
  }
  for (const root of [...props.snapshot.externalRoots].sort(CommitTargets.byPath)) {
    const changes = entries.filter((entry) => externalOf.get(entry.fileId) === root)
    const repoMessage = takeMessage(root.path, root.displayPath)
    if (changes.length === 0 && repoMessage === undefined) continue
    groups.push({
      key: `ext:${root.path}`,
      displayPath: root.displayPath,
      rootPath: root.path,
      isExternal: true,
      externalFileIds: root.fileIds,
      entries: changes,
      repoMessage,
    })
  }
  for (const extra of [...remainingMessages].sort(CommitTargets.byPath)) {
    groups.push({
      key: `repo:${extra.root}`,
      displayPath: extra.displayPath,
      rootPath: extra.root,
      isExternal: extra.displayPath !== '',
      entries: [],
      repoMessage: extra,
    })
  }
  groups.sort(CommitTargets.byPath)

  const groupedView = groups.length > 1 || groups.some((group) => group.isExternal || group.repoMessage !== undefined)
  const hasExternals = entries.some((entry) => externalOf.has(entry.fileId)) || (props.repositoryMessages?.length ?? 0) > 1
  const groupCount = props.repositoryMessages?.length ?? groups.length
  const groupNote = `${props.separateMessages ? 'Each repository has its own message.' : 'One message for all selected groups.'} Each group is committed separately.`

  const toggleGroupSelection = (group: RenderGroup, check: boolean): void => {
    const groupEligible = group.entries.filter((entry) => eligibleIds.has(entry.fileId))
    const next = new Set(props.checked)
    for (const entry of groupEligible) {
      if (check) next.add(entry.fileId)
      else next.delete(entry.fileId)
    }
    props.onChange(next)
  }

  return <div className="commit-targets">
    <div className="commit-selection">
      {groupedView && <input type="checkbox" aria-label="Include all" checked={allChecked}
        ref={(input) => { if (input) input.indeterminate = someChecked && !allChecked }}
        disabled={props.disabled || eligible.length === 0}
        onChange={() => allChecked ? selectNone() : selectAll()} />}
      <button type="button" disabled={props.disabled} onClick={selectAll}>Select all</button>
      <button type="button" disabled={props.disabled} onClick={selectNone}>Select none</button>
      <span className="commit-selection-count">{CommitTargets.selected(entries, props.checked).length} selected</span>
      {props.scopeRoot !== undefined && <span className="commit-scope" title={props.scopeTooltip ?? props.scopeRoot}>{props.scopeRoot}</span>}
      {hasExternals && <span className="commit-groups-note" title={groupNote}>
        {props.separateMessages ? `${groupCount} ${groupCount === 1 ? 'repository' : 'repositories'} · separate commits` : 'One message · separate commits'}
      </span>}
    </div>
    {groupedView ? <div className="commit-groups" ref={element} role="grid" aria-label="Commit files">
      {groups.map((group) => {
        const groupEligible = group.entries.filter((entry) => eligibleIds.has(entry.fileId))
        const groupAllChecked = groupEligible.length > 0 && groupEligible.every((entry) => props.checked.has(entry.fileId))
        const groupSomeChecked = groupEligible.some((entry) => props.checked.has(entry.fileId))
        const groupSelected = CommitTargets.selected(group.entries, props.checked).length
        const filesCollapsed = collapsedFiles[group.key] === true
        const repo = group.repoMessage
        const mount = group.displayPath || '.'
        const mountLabel = group.displayPath === '' ? 'Project files (.)' : `External: ${group.displayPath}`
        const preview = repo === undefined ? '' : firstLineOf(repo.value)
        return <div key={group.key} role="rowgroup" className={`commit-group${group.isExternal ? ' commit-external' : ''}${repo !== undefined ? ' session-actions__repository' : ''}`}>
          <div className="commit-group-header">
            {group.entries.length > 0 && <input type="checkbox" aria-label={`Include all in ${repo?.repositoryName ?? mountLabel}`}
              checked={groupAllChecked}
              ref={(input) => { if (input) input.indeterminate = groupSomeChecked && !groupAllChecked }}
              disabled={props.disabled || groupEligible.length === 0}
              onChange={() => toggleGroupSelection(group, !groupAllChecked)} />}
            {repo !== undefined ? <>
              <strong className="commit-group-name">{repo.repositoryName}</strong>
              <span className="commit-group-mount" title={repo.root}>{mountLabel}</span>
            </> : <strong className="commit-group-name">{mountLabel}</strong>}
            {group.entries.length > 0 && <span className="commit-group-count">{groupSelected} / {group.entries.length} selected</span>}
            {group.isExternal && !props.separateMessages && group.rootPath !== undefined && group.externalFileIds !== undefined && <button type="button"
              disabled={props.disabled} title="Move this group to a separate tab for a different commit message"
              onClick={() => {
                props.onChange(new Set([...props.checked].filter((id) => !group.externalFileIds!.includes(id))))
                props.onOpenSeparately(group.rootPath!)
              }}>Commit separately</button>}
            {group.entries.length > 0 && <button type="button" className="commit-group-files-toggle" aria-expanded={!filesCollapsed}
              onClick={() => setCollapsedFiles((held) => ({ ...held, [group.key]: !filesCollapsed }))}>
              {filesCollapsed ? `▸ Files (${group.entries.length})` : '▾ Files'}
            </button>}
          </div>
          {repo !== undefined && <>
            <details className="commit-group-message" open={repo.open}
              onToggle={(event) => {
                const next = event.currentTarget.open
                repo.onToggle(next)
              }}>
              <summary className="commit-group-message-summary">
                {repo.open ? <span className="commit-group-message-title">Commit message</span>
                  : <span className="commit-group-message-preview" title={repo.value}>{preview || `${repo.expectedPrefix} (empty)`}</span>}
                <span className="commit-group-message-source">Source: {repo.source}</span>
                <span className="commit-group-message-action">{repo.open ? 'Hide' : 'Edit'}</span>
              </summary>
              <div className="commit-group-message-body">
                <textarea aria-label={`Commit message ${repo.repositoryName} (${mount})`} disabled={repo.disabled}
                  value={repo.value} placeholder={`${repo.expectedPrefix} Describe the change`}
                  onChange={(event) => repo.onChange(event.target.value)} />
              </div>
            </details>
            {repo.findings.map((finding) => <p key={finding.id} className="commit-warning commit-group-finding" role="status">{finding.text}</p>)}
          </>}
          {!filesCollapsed && group.entries.length > 0 && <div className="commit-group-files">
            {group.entries.map((entry) => row(entry))}
          </div>}
        </div>
      })}
    </div> : <div className="commit-files" ref={element} role="grid" aria-label="Commit files">
      <div role="row" className="commit-files-heading"><span role="columnheader" aria-label="Include">
        <input type="checkbox" aria-label="Include all" checked={allChecked}
          ref={(input) => { if (input) input.indeterminate = someChecked && !allChecked }}
          disabled={props.disabled || eligible.length === 0}
          onChange={() => allChecked ? selectNone() : selectAll()} /></span><span role="columnheader" aria-label="Status" /><span role="columnheader">Path</span></div>
      <div role="rowgroup">{mainEntries.map((entry) => row(entry))}</div>
    </div>}
    {propertiesEntry?.properties !== undefined && <FilePropertyChanges properties={propertiesEntry.properties}
      label={`Property changes of ${nameOf(propertiesEntry)}`} onClose={() => setPropertiesPath(null)} />}
    {menu !== null && menuEntry !== undefined && <ContextMenu position={menu.position} ariaLabel={`Actions for ${menuEntry.displayPath}`}
      items={[
        { key: 'diff', label: 'Show diff', disabled: props.disabled || menuEntry.nodeKind !== 'file', onSelect: () => open(menuEntry) },
        ...(props.onOpenExternal === null ? [] : [{ key: 'external-diff', label: 'Show external diff',
          disabled: props.disabled || menuEntry.nodeKind !== 'file', onSelect: () => props.onOpenExternal?.(menuEntry) }]),
        { key: 'properties', label: 'Show property changes', disabled: menuEntry.properties === undefined, onSelect: () => setPropertiesPath(menuEntry.path) },
        { kind: 'separator', key: 'changes' },
        { key: 'revert', label: 'Revert…', disabled: props.disabled || externalOf.has(menuEntry.fileId) || !VersioningRevert.allows(menuEntry), onSelect: () => props.onRevert(menuEntry) },
      ]}
      onClose={() => setMenu(null)} />}
  </div>
}
