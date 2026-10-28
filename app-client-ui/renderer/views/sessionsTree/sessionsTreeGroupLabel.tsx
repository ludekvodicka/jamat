import type { TreeNode } from './sessionsTreeModel'

export function SessionsTreeGroupLabel(props: {
  node: Extract<TreeNode, { kind: 'category' | 'project' }>
}): React.JSX.Element {
  return <span className="jamat-sessions__label">{props.node.label}</span>
}
