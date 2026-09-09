import { useEffect, useRef, useState } from 'react'

import './configuration.css'
import type {
  ConfigurationOpenRequest,
  ConfigurationTabDescriptor,
} from './configurationTab.types'
import {
  type ConfigurationInput,
  ConfigurationModel,
  type ConfigurationState,
} from './configurationModel'
import { ConfigurationTabs } from './configurationTabs'
import type { WorktreeSetupIntentStore } from './worktreeSetupIntentStore'

/**
 * The settings surface: the groups on the left, the chosen group's own screen on the right.
 *
 * The second overlay of this shell, and the same shape as the first: no registry key, nothing
 * serialized into a saved layout, gone after a restart. Settings are work you come to do and then
 * leave, which is why they are not a panel the layout would reopen.
 *
 * It owns the frame and nothing inside a tab. A tab writes its own file; this window only refuses to
 * walk away from one that says it has unsaved work.
 */
export function ConfigurationOverlay(props: {
  request: ConfigurationOpenRequest
  worktreeSetupIntents: WorktreeSetupIntentStore
  onClose(): void
}): React.JSX.Element {
  const card = useRef<HTMLDivElement | null>(null)
  const [start] = useState(() => ConfigurationModel.initial(props.request.tab))
  const [state, setState] = useState<ConfigurationState>(start)
  // Read through a ref rather than through the rendered state: two dispatches in one tick have to
  // see what the first decided, not what React has drawn.
  const stateRef = useRef<ConfigurationState>(start)
  const closeRef = useRef(props.onClose)
  closeRef.current = props.onClose

  const [dispatch] = useState(() => (input: ConfigurationInput): void => {
    const step = ConfigurationModel.transition(stateRef.current, input)
    stateRef.current = step.state
    setState(step.state)
    for (const effect of step.effects) {
      if (effect.effect === 'close')
        closeRef.current()
      else
        throw new Error(`Unknown configuration effect: ${JSON.stringify(effect)}`)
    }
  })

  useEffect(() => {
    if (props.request.tab !== null)
      dispatch({ input: 'select', tab: props.request.tab })
  }, [props.request.requestId, props.request.tab, dispatch])

  // Whoever had focus gets it back: an overlay opened from a keystroke that returns focus nowhere
  // leaves a keyboard user at the top of the document.
  useEffect(() => {
    const restore = document.activeElement
    card.current?.focus()
    return () => {
      if (restore instanceof HTMLElement)
        restore.focus()
    }
  }, [])

  const tabs = ConfigurationTabs.ordered()
  const active = ConfigurationCard.tabOf(tabs, state)
  const ActiveTab = active.Component
  return (
    <div
      className="jamat-configuration"
      // The backdrop asks to leave rather than leaving: a click outside a tab holding unsaved work
      // must reach the same question Escape reaches. mousedown, so a selection dragged out of the
      // card is not read as a request to close.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget)
          dispatch({ input: 'escape' })
      }}
    >
      <div
        className="jamat-configuration__card"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
        ref={card}
        onKeyDown={(event) => ConfigurationKeys.handle(event, card.current, dispatch)}
      >
        <header className="jamat-configuration__head">
          <span className="jamat-configuration__title">Settings</span>
          <button
            className="jamat-configuration__close"
            type="button"
            aria-label="Close Settings"
            onClick={() => dispatch({ input: 'escape' })}
          >
            ×
          </button>
        </header>
        <div className="jamat-configuration__body">
          <nav className="jamat-configuration__groups" role="tree" aria-label="Settings groups">
            {tabs.map((tab) => (
              <ConfigurationTreeNode
                key={tab.id}
                node={tab}
                state={state}
                dispatch={dispatch}
                level={1}
              />
            ))}
          </nav>
          <section className="jamat-configuration__pane" aria-label={active.title}>
            <ActiveTab
              onDirtyChange={(dirty) => dispatch({ input: 'dirty', tab: active.id, dirty })}
              worktreeSetupIntents={props.worktreeSetupIntents}
            />
          </section>
        </div>
        {state.leaving !== null && (
          <div className="jamat-configuration__ask" role="alertdialog" aria-label="Unsaved changes">
            <p className="jamat-configuration__ask-text">
              {ConfigurationCard.askOf(tabs, state)}
            </p>
            <div className="jamat-configuration__ask-buttons">
              <button
                className="jamat-configuration__button"
                type="button"
                onClick={() => dispatch({ input: 'leave-answered', leave: false })}
              >
                Stay
              </button>
              <button
                className="jamat-configuration__button jamat-configuration__button--danger"
                type="button"
                onClick={() => dispatch({ input: 'leave-answered', leave: true })}
              >
                Leave and discard
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * One row and whatever hangs under it. The tree has no collapsing: two levels of a handful of
 * nodes each are all there is, and an expanded flag would be one more thing the window has to
 * remember across a restart to be worth having.
 *
 * A group carries the dirty mark of anything under it, because that is what leaving it would
 * discard, and it is the one row the user can see while a child is out of sight.
 */
function ConfigurationTreeNode(props: {
  node: ConfigurationTabDescriptor
  state: ConfigurationState
  dispatch: (input: ConfigurationInput) => void
  level: number
}): React.JSX.Element {
  const { node, state, dispatch, level } = props
  const selected = node.id === state.activeTab
  const dirty = ConfigurationCard.dirtyUnder(node, state)
  return (
    <>
      <button
        className={selected
          ? 'jamat-configuration__group jamat-configuration__group--active'
          : 'jamat-configuration__group'}
        style={{ paddingLeft: `calc(var(--space-3) * ${level})` }}
        type="button"
        role="treeitem"
        aria-level={level}
        aria-selected={selected}
        {...(node.children === undefined ? {} : { 'aria-expanded': true })}
        onClick={() => dispatch({ input: 'select', tab: node.id })}
      >
        {node.title}
        {dirty && <span className="jamat-configuration__dirty" aria-label="Unsaved changes">●</span>}
      </button>
      {node.children !== undefined && (
        <div className="jamat-configuration__branch" role="group">
          {node.children.map((child) => (
            <ConfigurationTreeNode
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

/** What the frame reads out of the catalog for the state it is in. */
class ConfigurationCard {
  static tabOf(
    tabs: readonly ConfigurationTabDescriptor[],
    state: ConfigurationState,
  ): Extract<ConfigurationTabDescriptor, { Component: unknown }> {
    const found = ConfigurationTabs.screenOf(state.activeTab, tabs)
    if (found === null)
      throw new Error(`The configuration catalog holds no tab ${JSON.stringify(state.activeTab)}`)
    return found
  }

  /** True when this node, or any screen under it, says it holds unsaved work. */
  static dirtyUnder(node: ConfigurationTabDescriptor, state: ConfigurationState): boolean {
    return ConfigurationTabs.flatten([node]).some((child) => state.dirty.has(child.id))
  }

  /** Names the group being left, because the answer discards what is in it. */
  static askOf(tabs: readonly ConfigurationTabDescriptor[], state: ConfigurationState): string {
    const leaving = state.leaving
    if (leaving === null)
      throw new Error('The question was drawn with nothing being left')
    const from = ConfigurationTabs.flatten(tabs).find((tab) => tab.id === leaving.from)
    return `${from?.title ?? leaving.from} has unsaved changes. Leaving discards them.`
  }
}

class ConfigurationKeys {
  /**
   * `:not([disabled])` is load-bearing here: a tab's Save button is disabled until there is
   * something to save, and a disabled control cannot take focus. Counted as the last stop, it makes
   * the wrap compare focus against an element that can never hold it, and the next Tab leaves the
   * card for the workspace behind it.
   */
  private static readonly focusableConst = 'button:not([disabled]), [href], '
    + 'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), '
    + '[tabindex]:not([tabindex="-1"])'

  static handle(
    event: React.KeyboardEvent,
    card: HTMLElement | null,
    dispatch: (input: ConfigurationInput) => void,
  ): void {
    if (event.key === 'Tab') {
      if (card)
        ConfigurationKeys.trap(event, card)
      return
    }
    if (event.ctrlKey || event.altKey || event.metaKey)
      return
    // Escape belongs to the surface wherever focus sits, including inside a text field: it leaves
    // the layer rather than typing into it.
    if (event.key === 'Escape') {
      event.preventDefault()
      dispatch({ input: 'escape' })
    }
  }

  /**
   * Tab stays inside the card. Without this the next Tab from the last control lands on the
   * workspace behind an overlay the user cannot see they have left.
   */
  private static trap(event: React.KeyboardEvent, card: HTMLElement): void {
    const focusable = [...card.querySelectorAll<HTMLElement>(ConfigurationKeys.focusableConst)]
    if (focusable.length === 0)
      return event.preventDefault()
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const active = document.activeElement
    if (event.shiftKey && (active === first || active === card)) {
      event.preventDefault()
      last.focus()
    }
    else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }
}
