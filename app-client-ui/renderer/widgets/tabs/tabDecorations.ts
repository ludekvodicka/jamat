import type { SessionColorName } from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'

/** A tone is a meaning, not a colour: the colour is in tabs.css. */
export type TabTone = 'ok' | 'attention' | 'danger' | 'accent' | 'idle' | 'muted'

export interface TabSignal {
  glyph: string
  tone: TabTone
  title: string
}

export interface TabBadge {
  key: string
  text: string
  tone: TabTone
  title: string
}

/**
 * What a tab shows besides its title: two fixed slots before the title and the badges after it. The
 * slots are two fields and not a list, because an empty one still holds its width - a title that
 * moves sideways the moment a signal appears makes the whole strip jump on every status tick.
 *
 * What a slot MEANS is the content's business. A session fills the first with its work state and the
 * second with a worktree marker; a viewer fills the first with the kind of file it shows and leaves
 * the second empty. The tab never learns which of those it is drawing.
 */
export interface TabDecorations {
  primary: TabSignal | null
  secondary: TabSignal | null
  badges: readonly TabBadge[]
  /**
   * The name of the colour this tab's session was given, or absent for none. A NAME and not a
   * colour, the same way a tone is: the tab puts it on an attribute and `tabs.css` is the one place
   * that turns it into something to look at.
   */
  color?: SessionColorName
}

export class TabDecorationsConst {
  /**
   * One shared instance for every tab that publishes nothing. useSyncExternalStore compares
   * snapshots by reference and re-renders forever on a getSnapshot that builds a new object.
   */
  static readonly empty: TabDecorations = { primary: null, secondary: null, badges: [] }
  /** Two is a tab. More is a rail row that happens to have a cross on it. */
  static readonly badgeLimit = 2
}

/**
 * The live decorations of every open tab, keyed by panel id.
 *
 * They live here and not in the panel's parameters on purpose: dockview serializes parameters into
 * the saved layout, so a work-state dot written there would rewrite the layout file on every tick
 * and come back stale after a restart. These readings are live, so they stay out of persistence.
 */
export class TabDecorationsStore {
  private readonly byPanel = new Map<string, TabDecorations>()
  private readonly listeners = new Map<string, Set<() => void>>()

  set(panelId: string, decorations: TabDecorations): void {
    TabDecorationsStore.assertBadges(decorations.badges)
    this.byPanel.set(panelId, decorations)
    this.notify(panelId)
  }

  /** A closed tab keeps nothing here; the next panel to take its id starts from empty. */
  clear(panelId: string): void {
    if (this.byPanel.delete(panelId))
      this.notify(panelId)
  }

  get(panelId: string): TabDecorations {
    return this.byPanel.get(panelId) ?? TabDecorationsConst.empty
  }

  /** Per panel, so one tab's tick re-renders one tab rather than the whole strip. */
  subscribe(panelId: string, listener: () => void): () => void {
    const listeners = this.listeners.get(panelId) ?? new Set<() => void>()
    this.listeners.set(panelId, listeners)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0)
        this.listeners.delete(panelId)
    }
  }

  private notify(panelId: string): void {
    for (const listener of [...this.listeners.get(panelId) ?? []])
      listener()
  }

  private static assertBadges(badges: readonly TabBadge[]): void {
    if (badges.length > TabDecorationsConst.badgeLimit)
      throw new Error(
        `A tab carries at most ${TabDecorationsConst.badgeLimit} badges, got ${badges.length}`,
      )
    const keys = new Set(badges.map((badge) => badge.key))
    if (keys.size !== badges.length)
      throw new Error(
        `Tab badge keys must be unique: ${JSON.stringify(badges.map((badge) => badge.key))}`,
      )
  }
}
