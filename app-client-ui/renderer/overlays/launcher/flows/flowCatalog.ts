import { CatalogEntries } from '../../../../shared/catalogEntries'
import { FeatureRequestFlow } from './featureRequest/featureRequestFlow'

/**
 * What a flow is, and every flow there is.
 *
 * The catalog IS the plug-point, the way `configurationTabs` and `debugSections` are: the set is
 * known at compile time, so a new flow is one entry here plus a directory beside this file, and
 * nothing in the create screen, the overlay or the library learns its name. A registry filled at run
 * time would buy an ordering problem between whoever registers and whoever draws.
 *
 * The suffix is `*Spec` rather than `I*`: a flow is registered as an object literal describing a
 * form, not as a class with state and a lifecycle behind it.
 */
export interface SessionFlowCompose {
  /** The agent's first turn, composed from whatever the form collected. */
  initialPrompt: string
  /** What to call the session when the person typed no name of their own. */
  title?: string
  /** Work that wants its own branch says so; the person's own choice still wins over it. */
  worktreeSuggested: boolean
}

/**
 * TRIGGER (2026-08-28, plán finalize dialogu): první task flow s kroky po skončení přidá
 *  1. sem volitelné `completion?: {
 *       questionsOf(session: SessionInfo): readonly SessionFinalizeQuestion[]
 *       perform(choiceId: string, ports: SessionFinalizePorts): Promise<...>
 *     }`,
 *  2. `flowId?: string` na SessionInfo (kopie z recordu v composeInfo; knihovna na něj dál
 *     nikdy nevětví, jen ho hlásí),
 *  3. spec `flow-completion` do FinalizeCatalog, jehož questionOf čte
 *     FlowCatalog.byId(session.flowId).completion.
 * Do té doby completion neexistuje schválně: jediný flow poctivý completion krok nemá
 * a spící kód bez konzumenta sem nepatří.
 */
export interface SessionFlowSpec<TState = unknown, TInput = unknown> {
  /** Travels into `SessionCreateSpec.flowId` and into the record, opaque to everything below. */
  id: string
  /** The row in the create screen's Type list. */
  title: string
  description: string
  order: number
  initial(): TState
  /** Pure, so a flow's form is testable without a DOM. */
  transition(state: TState, input: TInput): TState
  /** A problem is a form that is not finished; the reason is drawn at the field it belongs to. */
  composeOf(state: TState): SessionFlowCompose | { problem: string }
  /**
   * The `problem` is handed to the form rather than drawn by the frame around it, because only the
   * flow knows which of its fields the sentence is about.
   */
  Form: React.ComponentType<{
    state: TState
    problem: string | null
    dispatch(input: TInput): void
  }>
}

export class FlowCatalog {
  private static readonly catalogConst: readonly SessionFlowSpec[] =
    [FeatureRequestFlow.spec as SessionFlowSpec]

  /**
   * In `order`, which is the order the create screen lists them between Raw and Shell.
   *
   * The two refusals its sibling catalogs make, which this one had neither of: two flows sharing an
   * id make `byId` - and therefore a stored `flowId` - ambiguous, and two sharing an order leave the
   * list's sequence to the sort's stability. `order` decided nothing at all while there was one
   * entry, which is exactly when a rule like this is cheap to add and easy to forget.
   *
   * The parameter defaults to the catalog and exists so those two refusals are checkable against a
   * list that is allowed to be wrong, exactly as `ConfigurationTabs.ordered` does; nothing in the
   * app passes it.
   */
  static flows(
    catalog: readonly SessionFlowSpec[] = FlowCatalog.catalogConst,
  ): readonly SessionFlowSpec[] {
    CatalogEntries.assertDistinct('flows', catalog)
    return [...catalog].sort((left, right) => left.order - right.order)
  }

  /** An id the catalog does not hold is a defect, not an empty screen. */
  static byId(id: string): SessionFlowSpec {
    const found = FlowCatalog.flows().find((flow) => flow.id === id)
    if (!found) throw new Error(`Unknown flow: ${JSON.stringify(id)}`)
    return found
  }
}
