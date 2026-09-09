import type { IDockviewPanelHeaderProps } from 'dockview'
import { useCallback, useState, useSyncExternalStore } from 'react'

import { AppClientUiReport } from '../../../shared/appClientUiReport'
import { ErrorText } from '../../../shared/errorText'
import type { CommandRegistry } from '../../commands/commandRegistry'
import type { PanelFocusRegistry } from '../../shell/panelFocusRegistry'
import { SignalGlyph } from '../signalGlyph'
import {
  TabContextMenu,
  type TabContextMenuPosition,
  type TabSessionFacts,
} from './tabContextMenu'
import type { TabBadge, TabSignal } from './tabDecorations'
import { useTabDecorations } from './tabDecorationsContext'
import type { TabsController } from './tabsController'
import './tabs.css'

export type CustomTabProps = IDockviewPanelHeaderProps & {
  controller: TabsController
  commands: CommandRegistry
  sessionFacts(sessionId: string): TabSessionFacts | null
  /** Where the panel behind this tab said its caret is, for the click below to hand it back. */
  panelFocus: PanelFocusRegistry
}

/** The menu's whole world, captured when it opens: a short-lived menu does not follow the snapshot. */
interface TabMenuState {
  position: TabContextMenuPosition
  facts: TabSessionFacts | null
}

/**
 * Two signal slots, a title, the badges, a cross and the menu behind the right button. What any of
 * the slots MEANS is published by the content of the panel; the tab only knows where they sit. What
 * closing means lives in the controller, which is also why the cross goes through it rather than
 * through the container api: one closing path, one neighbour to activate.
 */
export function CustomTab(props: CustomTabProps): React.JSX.Element {
  const api = props.api
  const [menu, setMenu] = useState<TabMenuState | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const decorations = useTabDecorations(api.id)
  // Subscribed rather than read while rendering: dockview hands the same api object to every render,
  // so a tab that lost the activity would never re-draw and would keep the mark.
  const active = useSyncExternalStore(
    useCallback((onStoreChange) => {
      const subscription = api.onDidActiveChange(onStoreChange)
      return () => subscription.dispose()
    }, [api]),
    () => api.isActive,
  )
  // The title for the same reason: `applySessionTitles` renames panels in place, and a tab that
  // read `api.title` at render would keep the name it opened under.
  const title = useSyncExternalStore(
    useCallback((onStoreChange) => {
      const subscription = api.onDidTitleChange(onStoreChange)
      return () => subscription.dispose()
    }, [api]),
    () => api.title,
  )
  // Held by the controller rather than by the panel: it is a fact about this WINDOW, only one tab
  // in it is ever provisional, and a flag in the panel params would make the same session two panels.
  const controller = props.controller
  const preview = useSyncExternalStore(
    useCallback((onStoreChange) => controller.subscribePreview(onStoreChange), [controller]),
    () => controller.isPreview(api.id),
  )

  return (
    <div
      className={`jamat-tab${active ? ' is-active' : ''}${preview ? ' is-preview' : ''}`}
      data-session-color={decorations.color}
      onDoubleClick={() => controller.keepOpen(api.id)}
      /*
       * A tab is clicked to go back to typing. dockview made the panel active on the press, or the
       * panel was in front already and nothing happened at all; either way the press left the focus
       * on the tab element itself, which is a `tabIndex` 0 div that swallows every keystroke. The
       * click runs after both, so this is the last word on where the caret sits. The cross beside
       * it stops its own click, and a right click is a menu rather than a click at all.
       *
       * The containment test is about the menu below: it is a portal, so its items are no part of
       * this element in the DOM while React still bubbles their clicks through here. An item that
       * opens another panel would otherwise leave the caret in a terminal nobody is looking at.
       */
      onClick={(event) => {
        if (event.currentTarget.contains(event.target as Node))
          props.panelFocus.focus(api.id)
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        // Activated BEFORE the menu opens: every command in the menu acts on the active panel, so a
        // menu opened on an inactive tab would otherwise close or split a different tab.
        api.setActive()
        const sessionId = props.params.sessionId
        setMenu({
          position: { x: event.clientX, y: event.clientY },
          facts: typeof sessionId === 'string' && sessionId.length > 0
            ? props.sessionFacts(sessionId)
            : null,
        })
      }}
    >
      <span className="jamat-tab__signals">
        {TabSignalSlot.render(decorations.primary)}
        {TabSignalSlot.render(decorations.secondary)}
      </span>
      <span className="jamat-tab__title">{title}</span>
      {decorations.badges.map((badge: TabBadge) => (
        <span className="jamat-tab__badge" key={badge.key} data-tone={badge.tone} title={badge.title}>
          {badge.text}
        </span>
      ))}
      <button
        className="jamat-tab__close"
        type="button"
        title="Close panel"
        onClick={(event) => {
          event.stopPropagation()
          // Reported rather than dropped: a close that rejects left the tab standing and said
          // nothing at all.
          void props.controller.hidePanel(api.id).catch((error: unknown) =>
            AppClientUiReport.error(`the tab could not be closed: ${ErrorText.of(error)}`))
        }}
      >
        ×
      </button>
      {menu && (
        <TabContextMenu
          position={menu.position}
          commands={props.commands}
          panelKey={props.controller.keyOf(api.id)}
          params={props.params}
          facts={menu.facts}
          preview={preview}
          onClose={closeMenu}
        />
      )}
    </div>
  )
}

class TabSignalSlot {
  /** An empty slot is still in the DOM and collapsed by CSS: the markup says a slot exists, and
   * `tabs.css` decides what an empty one costs. */
  static render(signal: TabSignal | null): React.JSX.Element {
    if (!signal)
      return <span className="jamat-tab__signal is-empty" aria-hidden="true" />
    return (
      <span className="jamat-tab__signal" data-tone={signal.tone} title={signal.title}>
        <SignalGlyph glyph={signal.glyph} />
      </span>
    )
  }
}
