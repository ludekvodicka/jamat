import { useEffect, useState } from 'react'
import type { DockviewPanelApi } from 'dockview'

import './debugPanel.css'
import type { DebugSectionDescriptor } from './debugSection.types'
import { DebugSections } from './debugSections'
import { type DebugPanelInput, DebugPanelModel, type DebugPanelState } from './debugPanelModel'

export type DebugPanelVisibility = Pick<DockviewPanelApi, 'isVisible' | 'onDidVisibilityChange'>

/**
 * The Debug tab's frame: the tree of subsystems on the left, the chosen node's own screen on the
 * right.
 *
 * It owns the choice and nothing inside a node. A node reads its own channels and draws its own
 * subsystem, so the frame never learns what a Host is - which is what makes the next subsystem, or
 * one more cut through an existing one, a change to the catalog rather than a change here.
 *
 * Read-only by construction: no dirty tracking, no question before leaving a node, no backdrop and
 * no focus trap. The way out of it is its tab's close button.
 */
export function DebugPanel({ api }: { api: DebugPanelVisibility }): React.JSX.Element {
  const [sections] = useState<readonly DebugSectionDescriptor[]>(() => DebugSections.ordered())
  const [state, setState] = useState<DebugPanelState>(() => DebugPanelModel.initial(sections))
  const [dispatch] = useState(() => (input: DebugPanelInput): void =>
    setState((current) => DebugPanelModel.transition(current, input)))

  // Half of the ping gate: the main process knows whether any workspace window can be seen, and
  // only this renderer knows whether this tab is in front and which node is on it.
  const onScreen = useOnScreen(api)
  useEffect(() => {
    void window.appClient.debug.sectionActive(onScreen ? state.activeSection : null)
  }, [onScreen, state.activeSection])
  useEffect(() => () => { void window.appClient.debug.sectionActive(null) }, [])

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
  state: DebugPanelState
  dispatch: (input: DebugPanelInput) => void
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

/** In front in its group, and its document is not hidden (minimized window). */
function useOnScreen(api: DebugPanelVisibility): boolean {
  const [panelVisible, setPanelVisible] = useState(api.isVisible)
  const [documentVisible, setDocumentVisible] = useState(document.visibilityState === 'visible')
  useEffect(() => {
    const subscription = api.onDidVisibilityChange((event) => setPanelVisible(event.isVisible))
    return () => subscription.dispose()
  }, [api])
  useEffect(() => {
    const changed = (): void => setDocumentVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', changed)
    return () => document.removeEventListener('visibilitychange', changed)
  }, [])
  return panelVisible && documentVisible
}
