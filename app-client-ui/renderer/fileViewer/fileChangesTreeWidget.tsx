import { useEffect, useMemo, useRef, useState } from 'react'

import type {
  FileChangeEntry,
  FileChangesWorkingTreeSource,
} from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import { IpcFailure } from '../ipc/ipcFailure'
import { FileChangesStatusMark } from './fileChangesStatusMark'
import { FileChangesTree, type FileChangesTreeNode } from './fileChangesTree'
import type {
  FileChangesWorkingTreeViewModel,
  FileViewerChangedOpen,
} from './fileViewerPanel.types'

export function FileChangesTreeWidget(props: {
  model: FileChangesWorkingTreeViewModel
  onOpen(value: FileViewerChangedOpen): void
}): React.JSX.Element {
  const snapshot = props.model.snapshot
  const tree = useMemo(() => FileChangesTree.of(snapshot?.entries ?? []), [snapshot?.entries])
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [opening, setOpening] = useState<string | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  const openings = useRef(0)

  useEffect(() => {
    openings.current += 1
    setOpening(null)
    setOpenError(null)
    return () => { openings.current += 1 }
  }, [snapshot?.snapshotId])

  useEffect(() => {
    setCollapsed((current) => new Set(
      [...current].filter((key) => tree.directoryKeys.has(key)),
    ))
  }, [tree.directoryKeys])

  const toggle = (key: string): void => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const open = async (entry: FileChangeEntry): Promise<void> => {
    if (snapshot === null || entry.nodeKind !== 'file') return
    const current = ++openings.current
    const snapshotId = snapshot.snapshotId
    setOpening(entry.fileId)
    setOpenError(null)
    const answer = await window.appClient.fileChanges.openFile(snapshotId, entry.fileId)
    if (current !== openings.current) {
      if (answer.ok && answer.value.ok)
        await window.appClient.fileViewer.release(answer.value.value.documentId)
      return
    }
    setOpening(null)
    const refusal = IpcFailure.of(answer)
    if (refusal !== null) {
      setOpenError(refusal)
      return
    }
    if (!answer.ok || !answer.value.ok) return
    const baseline = snapshot.defaultBaseline
    const source = snapshot.source.selected
    props.onOpen({
      document: answer.value.value,
      snapshot,
      fileId: entry.fileId,
      baselineHint: baseline === null || source === null
        ? null
        : {
          kind: baseline.kind,
          revision: baseline.revision,
          workingTreeSource: source,
        },
    })
  }

  const selected = snapshot?.source.selected ?? props.model.selectedSource
  const available = snapshot?.source.available ?? []
  return (
    <div className="file-tools-working-tree">
      <div className="file-tools-controls">
        <select
          aria-label="Change source"
          value={selected ?? ''}
          disabled={available.length === 0}
          onChange={(event) => props.model.select(FileChangesTreeSources.read(event.target.value))}
        >
          {available.length === 0 && <option value="">No source</option>}
          {available.map((source) => (
            <option value={source} key={source}>{FileChangesTreeSources.labelOf(source)}</option>
          ))}
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
      {snapshot?.source.fallbackReason && (
        <p className="file-tools-warning">{snapshot.source.fallbackReason}</p>
      )}
      {snapshot?.warnings.map((warning) => (
        <p className="file-tools-warning" key={warning}>{warning}</p>
      ))}
      {snapshot && (
        <>
          <div className="file-tools-summary">
            <span>{selected === null ? 'No source' : FileChangesTreeSources.labelOf(selected)}</span>
            <span>{tree.leafCount} changed</span>
          </div>
          {tree.nodes.length === 0
            ? (
              <p className="file-tools-note">
                {snapshot.warnings.length > 0
                  ? 'Changes could not be measured.'
                  : available.length === 0
                    ? 'No change source is available.'
                    : 'No changed files.'}
              </p>
            )
            : (
              <ul className="file-tools-tree" role="tree" aria-label="Changed files">
                {tree.nodes.map((node) => (
                  <FileChangesTreeItem
                    key={node.key}
                    node={node}
                    depth={0}
                    collapsed={collapsed}
                    opening={opening}
                    onToggle={toggle}
                    onOpen={open}
                  />
                ))}
              </ul>
            )}
        </>
      )}
    </div>
  )
}

function FileChangesTreeItem(props: {
  node: FileChangesTreeNode
  depth: number
  collapsed: ReadonlySet<string>
  opening: string | null
  onToggle(key: string): void
  onOpen(entry: FileChangeEntry): Promise<void>
}): React.JSX.Element {
  const directory = props.node.kind === 'directory'
  const hasChildren = props.node.children.length > 0
  const expanded = directory && hasChildren && !props.collapsed.has(props.node.key)
  const entry = props.node.entry
  const title = entry?.previousDisplayPath
    ? `${entry.previousDisplayPath} → ${entry.displayPath}`
    : entry?.path ?? props.node.label
  const accessibleLabel = entry?.previousDisplayPath
    ? `${props.node.label}, renamed from ${entry.previousDisplayPath}, ${entry.status}`
    : entry === null ? props.node.label : `${props.node.label}, ${entry.status}`
  return (
    <li
      role="treeitem"
      aria-label={accessibleLabel}
      {...(directory && hasChildren ? { 'aria-expanded': expanded } : {})}
    >
      <button
        type="button"
        className="file-tools-tree-row"
        style={{ paddingLeft: `calc(var(--space-2) + ${props.depth * 14}px)` }}
        title={title}
        aria-label={accessibleLabel}
        disabled={!directory && entry?.fileId === props.opening}
        onClick={() => {
          if (directory) {
            if (hasChildren) props.onToggle(props.node.key)
          }
          else if (entry !== null) void props.onOpen(entry)
        }}
      >
        <span className="file-tools-tree-chevron" aria-hidden="true">
          {directory ? hasChildren ? expanded ? '⌄' : '›' : '·' : ''}
        </span>
        <span className="file-tools-tree-label">{props.node.label}</span>
        {entry !== null && (!directory || !hasChildren) && (
          <span
            className={`file-tools-status file-tools-status--${entry.status}`}
            title={entry.status}
          >
            {FileChangesStatusMark.of(entry.status)}
          </span>
        )}
      </button>
      {expanded && (
        <ul role="group">
          {props.node.children.map((child) => (
            <FileChangesTreeItem
              key={child.key}
              node={child}
              depth={props.depth + 1}
              collapsed={props.collapsed}
              opening={props.opening}
              onToggle={props.onToggle}
              onOpen={props.onOpen}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

class FileChangesTreeSources {
  static read(value: string): FileChangesWorkingTreeSource {
    if (value === 'checkpoint' || value === 'svn' || value === 'worktree-base') return value
    else throw new Error(`Unknown working tree source: ${JSON.stringify(value)}`)
  }

  static labelOf(source: FileChangesWorkingTreeSource): string {
    if (source === 'checkpoint') return 'Checkpoint'
    else if (source === 'svn') return 'SVN BASE'
    else if (source === 'worktree-base') return 'Worktree base'
    else throw new Error(`Unknown working tree source: ${JSON.stringify(source)}`)
  }
}
