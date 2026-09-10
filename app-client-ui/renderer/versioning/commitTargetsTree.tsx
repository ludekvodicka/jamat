import { useMemo } from 'react'

import type { FileChangeEntry, FileChangesWorkingTreeSnapshot } from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import { FileChangesTree, type FileChangesTreeNode } from '../fileViewer/fileChangesTree'
import { FileChangesStatusMark } from '../fileViewer/fileChangesStatusMark'

export class CommitTargets {
  static blocked(entry: FileChangeEntry): boolean {
    return entry.status === 'conflicted' || entry.status === 'obstructed'
  }

  static eligible(snapshot: FileChangesWorkingTreeSnapshot): readonly FileChangeEntry[] {
    const externalIds = new Set(snapshot.externalRoots.flatMap((root) => root.fileIds))
    return snapshot.entries.filter((entry) => !externalIds.has(entry.fileId) && !CommitTargets.blocked(entry))
  }

  static descendants(node: FileChangesTreeNode): readonly FileChangeEntry[] {
    return [...(node.entry === null ? [] : [node.entry]), ...node.children.flatMap(CommitTargets.descendants)]
  }
}

export function CommitTargetsTree(props: {
  snapshot: FileChangesWorkingTreeSnapshot
  checked: ReadonlySet<string>
  disabled: boolean
  onChange(ids: ReadonlySet<string>): void
  onOpen(entry: FileChangeEntry): void
  onOpenSeparately(scopeRoot: string): void
}): React.JSX.Element {
  const externalIds = new Set(props.snapshot.externalRoots.flatMap((root) => root.fileIds))
  const entries = props.snapshot.entries.filter((entry) => !externalIds.has(entry.fileId))
  const tree = useMemo(() => FileChangesTree.of(entries, false), [props.snapshot])
  const change = (entries: readonly FileChangeEntry[], checked: boolean): void => {
    const next = new Set(props.checked)
    for (const entry of entries) {
      if (CommitTargets.blocked(entry)) continue
      if (checked) next.add(entry.fileId)
      else next.delete(entry.fileId)
    }
    props.onChange(next)
  }
  const row = (node: FileChangesTreeNode): React.JSX.Element => {
    const entry = node.entry
    const descendants = CommitTargets.descendants(node)
    const eligible = descendants.filter((entry) => !CommitTargets.blocked(entry))
    const childChecked = node.children.flatMap(CommitTargets.descendants).some((entry) => props.checked.has(entry.fileId))
    const requiredParent = entry?.nodeKind === 'directory' && entry.status === 'added' && childChecked
    const checked = requiredParent || (eligible.length > 0 && eligible.every((entry) => props.checked.has(entry.fileId)))
    return <li key={node.key}>
      <div className="commit-target" onDoubleClick={() => { if (entry?.nodeKind === 'file') props.onOpen(entry) }} title={entry?.path}>
        <input type="checkbox" aria-label={`Include ${node.label}`} checked={checked}
          disabled={props.disabled || eligible.length === 0 || requiredParent}
          onChange={(event) => change(descendants, event.target.checked)} />
        {entry !== null && <span className={`file-tools-status file-tools-status--${entry.status}`} title={entry.status}>{FileChangesStatusMark.of(entry.status)}</span>}
        <span>{node.label}</span>
        {requiredParent && <small>Required added parent</small>}
        {entry?.status === 'untracked' && entry.nodeKind === 'directory' && <small>Git ignore rules when available; otherwise added recursively</small>}
      </div>
      {node.children.length > 0 && <ul>{node.children.map(row)}</ul>}
    </li>
  }
  return <div className="commit-targets">
    <div className="commit-selection">
      <button type="button" disabled={props.disabled} onClick={() => props.onChange(new Set(CommitTargets.eligible(props.snapshot).map((entry) => entry.fileId)))}>Select all</button>
      <button type="button" disabled={props.disabled} onClick={() => props.onChange(new Set())}>Select none</button>
      <span>{props.checked.size} selected</span>
    </div>
    <ul aria-label="Commit files">{tree.nodes.map(row)}</ul>
    {props.snapshot.externalRoots.map((root) => <section key={root.path} className="commit-external">
      <strong>External: {root.displayPath}</strong>
      <button type="button" disabled={props.disabled} onClick={() => props.onOpenSeparately(root.path)}>Commit separately</button>
      <ul>{props.snapshot.entries.filter((entry) => root.fileIds.includes(entry.fileId)).map((entry) => <li key={entry.fileId}>
        <label><input type="checkbox" checked={false} disabled />{FileChangesStatusMark.of(entry.status)} {entry.displayPath}</label>
      </li>)}</ul>
    </section>)}
  </div>
}
