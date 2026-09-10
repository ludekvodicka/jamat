import type { FileChangeEntry } from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'

export interface FileChangesTreeNode {
  key: string
  label: string
  kind: FileChangeEntry['nodeKind']
  entry: FileChangeEntry | null
  children: readonly FileChangesTreeNode[]
}

export interface FileChangesTreeModel {
  nodes: readonly FileChangesTreeNode[]
  directoryKeys: ReadonlySet<string>
  leafCount: number
}

interface MutableTreeNode {
  key: string
  label: string
  kind: FileChangeEntry['nodeKind']
  entry: FileChangeEntry | null
  children: Map<string, MutableTreeNode>
}

export class FileChangesTree {
  static of(entries: readonly FileChangeEntry[], compressDirectories = true): FileChangesTreeModel {
    const root = new Map<string, MutableTreeNode>()
    for (const entry of entries) FileChangesTree.add(root, entry)
    const nodes = FileChangesTree.finish([...root.values()], compressDirectories)
    const directoryKeys = new Set<string>()
    FileChangesTree.collectDirectories(nodes, directoryKeys)
    return {
      nodes,
      directoryKeys,
      leafCount: FileChangesTree.leafCountOf(nodes),
    }
  }

  private static add(root: Map<string, MutableTreeNode>, entry: FileChangeEntry): void {
    const parts = entry.displayPath.replace(/\\/g, '/').split('/').filter(Boolean)
    if (parts.length === 0) return
    let children = root
    let path = ''
    for (let index = 0; index < parts.length; index += 1) {
      const label = parts[index]
      path = path ? `${path}/${label}` : label
      const last = index === parts.length - 1
      const kind = last ? entry.nodeKind : 'directory'
      const mapKey = `${kind}:${label}`
      let node = children.get(mapKey)
      if (node === undefined) {
        node = { key: path, label, kind, entry: null, children: new Map() }
        children.set(mapKey, node)
      }
      if (last) node.entry = entry
      children = node.children
    }
  }

  private static finish(nodes: readonly MutableTreeNode[], compressDirectories: boolean): FileChangesTreeNode[] {
    return [...nodes]
      .sort(FileChangesTree.compare)
      .map((node) => {
        const finished = {
        key: node.key,
        label: node.label,
        kind: node.kind,
        entry: node.entry,
        children: FileChangesTree.finish([...node.children.values()], compressDirectories),
        }
        return compressDirectories ? FileChangesTree.compress(finished) : finished
      })
  }

  private static compress(node: FileChangesTreeNode): FileChangesTreeNode {
    if (node.kind !== 'directory') return node
    let label = node.label
    let entry = node.entry
    let children = node.children
    while (children.length === 1 && children[0].kind === 'directory') {
      const child = children[0]
      label = `${label}/${child.label}`
      entry = child.entry
      children = child.children
    }
    return { ...node, label, entry, children }
  }

  private static compare(left: MutableTreeNode, right: MutableTreeNode): number {
    if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1
    return left.label.localeCompare(right.label)
  }

  private static collectDirectories(
    nodes: readonly FileChangesTreeNode[],
    found: Set<string>,
  ): void {
    for (const node of nodes) {
      if (node.kind === 'directory') found.add(node.key)
      FileChangesTree.collectDirectories(node.children, found)
    }
  }

  private static leafCountOf(nodes: readonly FileChangesTreeNode[]): number {
    let count = 0
    for (const node of nodes) {
      if (node.kind === 'file' || node.children.length === 0) count += 1
      else count += FileChangesTree.leafCountOf(node.children)
    }
    return count
  }
}
