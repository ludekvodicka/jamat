/**
 * Pure tree helpers for the `customMenus` editor (CustomMenusEditor in SettingsPanel) — immutable
 * edits of a `CustomMenuNode[]` addressed by an index-path, plus client-side validation. No React,
 * no electron → unit-testable in isolation (scripts/smoke-menu-tree.ts). The server re-sanitizes
 * everything via `parseCustomMenus`, so these helpers only need to keep the tree well-formed enough
 * to edit and to warn before a save would drop a row.
 */
import type { CustomMenuNode } from '../../../../../core/types/config'

export type MenuPath = number[]

/** Apply `mut` to the sibling-array that directly contains the node at `path` (path length ≥ 1). */
export function withParentList(
  nodes: CustomMenuNode[],
  path: MenuPath,
  mut: (list: CustomMenuNode[], index: number) => CustomMenuNode[],
): CustomMenuNode[] {
  if (path.length === 1) return mut(nodes, path[0])
  const [i, ...rest] = path
  return nodes.map((n, idx) => (idx === i ? { ...n, items: withParentList(n.items ?? [], rest, mut) } : n))
}

export const mutateNode = (nodes: CustomMenuNode[], path: MenuPath, fn: (n: CustomMenuNode) => CustomMenuNode): CustomMenuNode[] =>
  withParentList(nodes, path, (list, i) => list.map((n, k) => (k === i ? fn(n) : n)))

export const deleteNode = (nodes: CustomMenuNode[], path: MenuPath): CustomMenuNode[] =>
  withParentList(nodes, path, (list, i) => list.filter((_, k) => k !== i))

export const moveNode = (nodes: CustomMenuNode[], path: MenuPath, dir: -1 | 1): CustomMenuNode[] =>
  withParentList(nodes, path, (list, i) => {
    const j = i + dir
    if (j < 0 || j >= list.length) return list
    const next = [...list]
    ;[next[i], next[j]] = [next[j], next[i]]
    return next
  })

export const newLeaf = (): CustomMenuNode => ({ label: '', run: { command: '' } })
export const newBranch = (): CustomMenuNode => ({ label: '', items: [] })

/** First validation error in the tree (empty label, or a leaf with no command), or null. */
export function firstMenuError(nodes: CustomMenuNode[], trail = ''): string | null {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    const where = `${trail}#${i + 1}${n.label ? ` "${n.label}"` : ''}`
    if (!n.label.trim()) return `${where}: needs a label`
    if (n.items) {
      const inner = firstMenuError(n.items, `${where} › `)
      if (inner) return inner
    } else if (!n.run?.command.trim()) {
      return `${where}: command is empty`
    }
  }
  return null
}
