import { useEffect, useState } from 'react'

import './debugWindow.css'
import type { DebugSectionDescriptor } from './debugSection.types'
import { DebugSections } from './debugSections'
import { type DebugWindowInput, DebugWindowModel, type DebugWindowState } from './debugWindowModel'

/**
 * The Debug window's frame: the tree of subsystems on the left, the chosen node's own screen on the
 * right.
 *
 * It owns the choice and nothing inside a node. A node reads its own channels and draws its own
 * subsystem, so the frame never learns what a Host is - which is what makes the next subsystem, or
 * one more cut through an existing one, a change to the catalog rather than a change here.
 *
 * Read-only by construction: no dirty tracking, no question before leaving a node, no backdrop and
 * no focus trap. This is a window, and the way out of it is its own close button.
 */
export function DebugWindow(): React.JSX.Element {
  const [sections] = useState<readonly DebugSectionDescriptor[]>(() => DebugSections.ordered())
  const [state, setState] = useState<DebugWindowState>(() => DebugWindowModel.initial(sections))
  const [dispatch] = useState(() => (input: DebugWindowInput): void =>
    setState((current) => DebugWindowModel.transition(current, input)))

  // Half of the ping gate: the main process knows whether the window can be seen, and only this
  // renderer knows which node is on it.
  useEffect(() => {
    void window.appClient.debug.sectionActive(state.activeSection)
  }, [state.activeSection])

  const active = DebugSections.nodeOf(state.activeSection, sections)
  const ActiveSection = active.Component
  return (
    <div className="jamat-debug">
      <nav className="jamat-debug__sections" role="tree" aria-label="Debug sections">
        {sections.map((section) => (
          <DebugTreeNode
            key={section.id}
            node={section}
            state={state}
            dispatch={dispatch}
            level={1}
          />
        ))}
      </nav>
      <section className="jamat-debug__pane" aria-label={active.title}>
        <ActiveSection />
      </section>
    </div>
  )
}

/**
 * One row and whatever hangs under it. The tree has no collapsing: two levels of a handful of nodes
 * each are all there is, and an expanded flag would be one more thing the window has to remember
 * across a restart to be worth having.
 */
function DebugTreeNode(props: {
  node: DebugSectionDescriptor
  state: DebugWindowState
  dispatch: (input: DebugWindowInput) => void
  level: number
}): React.JSX.Element {
  const { node, state, dispatch, level } = props
  const selected = node.id === state.activeSection
  return (
    <>
      <button
        className={selected
          ? 'jamat-debug__section jamat-debug__section--active'
          : 'jamat-debug__section'}
        style={{ paddingLeft: `calc(var(--space-3) * ${level})` }}
        type="button"
        role="treeitem"
        aria-level={level}
        aria-selected={selected}
        {...(node.children === undefined ? {} : { 'aria-expanded': true })}
        onClick={() => dispatch({ input: 'select', section: node.id })}
      >
        {node.title}
      </button>
      {node.children !== undefined && (
        <div className="jamat-debug__group" role="group">
          {node.children.map((child) => (
            <DebugTreeNode
              key={child.id}
              node={child}
              state={state}
              dispatch={dispatch}
              level={level + 1}
            />
          ))}
        </div>
      )}
    </>
  )
}
