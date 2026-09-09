import type { ProjectBinding } from '../../../../lib-orchestrator/projectManager/projectManagerApi.types'

/**
 * What the surface that opened the launcher wanted from it, as opposed to what the launcher itself
 * remembers. The project is present only when the caller already knows which one, which is what lets
 * the launcher skip straight past its project screen; an opener that knows nothing writes an empty
 * intent, which still says "this is a fresh open" and is why the store is not simply a project.
 *
 * It carried a kind until 2026-08-11 - "a session" or "a shell" - preselecting the create screen's
 * type row. The tree's `+ Shell` was its only writer, and the create screen asks the same question
 * one screen later, so the row is chosen where it is drawn and nowhere else.
 */
export interface LauncherIntent {
  project?: Extract<ProjectBinding, { kind: 'project' }>
  /**
   * Half of what `project` says: which category to stand in, with the project still to be picked.
   * It is what a right-click on a category row of the tree knows, and the two never travel together
   * - a project already names its category, so reading both would be two answers to one question.
   */
  category?: string
  /**
   * `tabProfile` = this card asks the short question: a type list without the flows, and no
   * isolation. It names the FORM, not the result - `New` and `Shell` from it are plain tabs, while
   * `Continue/Fork` is a session of the tree like any other. It belongs to the card and not to one
   * screen: Escape back to the projects and Enter again is still the tab card.
   */
  purpose?: 'tabProfile' | 'remote'
  /**
   * Valid only with `purpose: 'remote'`: the computer the card starts on. A right-click on a paired
   * computer in the tree already knows which one, so the launcher has no list to draw; Ctrl+N writes
   * the purpose alone and the card asks.
   */
  remote?: { remoteEndpointId: string; displayName: string }
}

/**
 * The one-shot handover between "open the launcher" and the launcher itself.
 *
 * It is a renderer-side store and deliberately not part of the overlay's props or of any saved
 * state: an intent is what ONE keystroke meant, so a launcher opened again later must not still be
 * acting on it. `consume` is what enforces that - the second reader gets null, and a launcher that
 * came back from anywhere but a fresh open starts from its own beginning.
 */
export class LauncherIntentStore {
  private intent: LauncherIntent | null = null

  /** Last write wins: two openers racing is one user pressing twice, and they meant the second. */
  set(intent: LauncherIntent): void {
    this.intent = intent
  }

  consume(): LauncherIntent | null {
    const taken = this.intent
    this.intent = null
    return taken
  }
}
