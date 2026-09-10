import type {
  SessionAgentId,
} from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { LauncherBinding } from './launcherBinding'

/**
 * What the opener already knows, so the card does not ask it again.
 *
 * `binding` alone is what a project row of the tree knows: where, and nothing else. A SESSION row
 * knows strictly more - what that session is called, which agent it runs, and, for the two commands
 * that act on the session itself, which session that is - and every one of those is a field of the
 * create card that would otherwise open empty.
 *
 * Nothing here starts anything. It is what the card OPENS holding, and every one of the fields is
 * still typed over before Enter.
 */
export interface LauncherPrefill {
  binding: LauncherBinding
  /** The name field's contents, without the number: the number is the project's to hand out. */
  name?: string
  agentId?: SessionAgentId
  /**
   * A session this card acts ON, rather than one it starts something beside. Present only from the
   * two commands that mean exactly that, and it is what the Continue/Fork list opens standing on:
   * both are composed by the library out of that session's record, so their submit names a session
   * rather than a spec.
   */
  session?: LauncherSessionPrefill
}

export interface LauncherSessionPrefill {
  /**
   * `fork` branches the conversation into a session of its own; `resume` brings THIS session back,
   * with its number, name, colour and note. A resume is offered only for a session that has ended:
   * over a running one it would be a fork, which is the other half of this pair.
   */
  mode: 'fork' | 'resume'
  sessionId: string
  /**
   * The agent holding it, or null for a shell. The row draws its mark from this, and the project's
   * own conversations are deduped against it.
   */
  agentId: SessionAgentId | null
  /**
   * The conversation that agent knows it by, or null where there is none to name - a shell, or a
   * session whose agent has not said yet. It is what makes this row and the project's listing of
   * the same conversation ONE row rather than two that do different things.
   */
  nativeSessionId: string | null
  /** The session's own number, which a fork draws the `014-015 - ` prefix from. */
  number: string | null
  /** What it is called, for the line that says which session the card is about. */
  title: string
  /**
   * What a tab holding it is called. A resume opens no new session, so nothing comes back with a
   * name for its tab - and the library is still what composed this one.
   */
  tabTitle: string
}

/**
 * What the surface that opened the launcher wanted from it, as opposed to what the launcher itself
 * remembers. The prefill is present only when the caller already knows where, which is what lets
 * the launcher skip straight past its project screen; an opener that knows nothing writes an empty
 * intent, which still says "this is a fresh open" and is why the store is not simply a prefill.
 *
 * It carried a kind until 2026-08-11 - "a session" or "a shell" - preselecting the create screen's
 * type row. The tree's `+ Shell` was its only writer, and the create screen asks the same question
 * one screen later, so the row is chosen where it is drawn and nowhere else.
 */
export interface LauncherIntent {
  prefill?: LauncherPrefill
  /**
   * Half of what a prefill says: which category to stand in, with the project still to be picked.
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
