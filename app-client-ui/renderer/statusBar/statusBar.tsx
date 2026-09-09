import './statusBar.css'

export interface StatusBarItem {
  key: string
  node: React.ReactNode
}

/**
 * Layout, and nothing else. Where an item's data comes from is its own module's business: the bar
 * only knows the order of the two groups, the separators between items and the gap that pushes the
 * right group to the edge. It reads no projection and calls no API on purpose - a status bar that
 * fetches is a status bar every new reading has to be added to.
 */
export function StatusBar(props: {
  left: readonly StatusBarItem[]
  right: readonly StatusBarItem[]
}): React.JSX.Element {
  return (
    <footer className="jamat-status" aria-label="Status">
      {StatusBarGroup.render(props.left, false)}
      <span className="jamat-status__spacer" />
      {StatusBarGroup.render(props.right, true)}
    </footer>
  )
}

class StatusBarGroup {
  /** A separator before every item except the very first one on the bar. */
  static render(items: readonly StatusBarItem[], leading: boolean): React.ReactNode[] {
    return items.map((item, index) => (
      <span className="jamat-status__item" key={item.key}>
        {(leading || index > 0) && <span className="jamat-status__separator" aria-hidden="true" />}
        {item.node}
      </span>
    ))
  }
}
