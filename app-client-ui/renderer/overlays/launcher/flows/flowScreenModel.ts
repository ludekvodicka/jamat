import type { SessionCreateSpec, SessionSetupAgreement } from '../../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { CreateScreenState } from '../create/createScreenModel'
import { CreateScreenModel } from '../create/createScreenModel'
import { FlowCatalog } from './flowCatalog'

export interface FlowScreenState {
  flowId: string
  /**
   * The flow's own state. Opaque here: only the flow's `transition` knows what is in it.
   *
   * **`flowId` and `form` are always written together, and that is what makes the catalog sound.**
   * `FlowCatalog` erases each spec's parameters (`FeatureRequestFlow.spec as SessionFlowSpec`), and
   * `React.ComponentType<P>` is contravariant in `P`, so nothing in the type system stops one flow's
   * form reaching another flow's `transition` or `Form`. What stops it is that every place this
   * state is built - `opened`, and every step of `transition` - sets the pair in one object literal,
   * so a form never outlives the id it belongs to. Splitting the two writes is what would break it.
   */
  form: unknown
  /** What the create screen already answered - agent, name, isolation, number, where it runs. */
  options: CreateScreenState
  /** Why the form is not finished yet, drawn at the field it belongs to. */
  problem: string | null
  submitError: {
    code: string
    detail: string
    setup?: SessionSetupAgreement
  } | null
  submitting: boolean
}

export type FlowScreenInput =
  | { input: 'formInput'; value: unknown }
  | { input: 'activate' }
  | {
      input: 'submitFailed'
      code: string
      detail: string
      setup?: SessionSetupAgreement
    }
  | { input: 'acknowledgeSetup' }
  | { input: 'escape' }

export type FlowScreenEffect =
  /** As on the create screen, the number is taken in the effect and not carried in it. */
  | { effect: 'submit' }
  | { effect: 'back' }

export interface FlowScreenStep {
  state: FlowScreenState
  effects: readonly FlowScreenEffect[]
}

/**
 * The frame every flow is drawn in: the fields are the flow's, and the submit, the validation and
 * the refusals are shared.
 *
 * A flow decides what to ASK. What to do with the answer is the same for all of them - compose a
 * first instruction, merge it with what the create screen already chose, and start one session.
 */
export class FlowScreenModel {
  /**
   * `form` is what was typed into this flow before, where the card has been open once already.
   *
   * Escape on this screen goes back to the create card, and the create card's own answers are
   * carried back the same way (`showCreate` takes `options`). The flow's were not: a paragraph
   * of description and acceptance criteria went with one keystroke, and there was no way back
   * to it. Whoever holds the screens holds the last form; this only has to be able to take it.
   */
  static opened(
    flowId: string,
    options: CreateScreenState,
    form?: FlowScreenState['form'],
  ): FlowScreenStep {
    return FlowScreenModel.step({
      flowId,
      form: form ?? FlowCatalog.byId(flowId).initial(),
      options,
      problem: null,
      submitError: null,
      submitting: false,
    })
  }

  static transition(state: FlowScreenState, input: FlowScreenInput): FlowScreenStep {
    if (input.input === 'formInput')
      // Typing clears the problem it was told about: a message about an empty field that is no
      // longer empty is a message about the past.
      return FlowScreenModel.step({
        ...state,
        form: FlowCatalog.byId(state.flowId).transition(state.form, input.value),
        problem: null,
      })
    else if (input.input === 'activate') return FlowScreenModel.activated(state)
    else if (input.input === 'submitFailed')
      return FlowScreenModel.step({
        ...state,
        submitting: false,
        submitError: { code: input.code, detail: input.detail, setup: input.setup },
      })
    else if (input.input === 'acknowledgeSetup') return FlowScreenModel.acknowledged(state)
    else if (input.input === 'escape') {
      // Nothing while a submit is out. The success path calls `openTerminal` and `close` whatever
      // screen is up, so backing out of a slow create - a worktree plus an install, with nothing
      // apparently happening - opened a tab for a session the person believed they had cancelled,
      // and a second Enter in that window made it two sessions with two numbers. The footer
      // already says "Starting…", which is what a screen that cannot be left has to say.
      if (state.submitting) return FlowScreenModel.step(state)
      return FlowScreenModel.step(state, { effect: 'back' })
    }
    else
      throw new Error(`Unknown flow screen input: ${JSON.stringify(input)}`)
  }

  /**
   * The flow's answer merged with the create screen's. The flow proposes a title and an isolation;
   * a name the person typed and an isolation they chose both win, because they said it later and
   * about this session rather than about the shape of the work.
   */
  static specOf(state: FlowScreenState, token: string | null): SessionCreateSpec {
    const flow = FlowCatalog.byId(state.flowId)
    const composed = flow.composeOf(state.form)
    if ('problem' in composed)
      throw new Error(`Refusing to build a spec from an unfinished flow: ${composed.problem}`)
    const named: CreateScreenState = {
      ...state.options,
      name: state.options.name.trim().length > 0 ? state.options.name : composed.title ?? '',
      worktree: state.options.worktree || composed.worktreeSuggested,
    }
    // The isolation the flow suggested is still subject to this screen's own refusals: a suggestion
    // cannot put a worktree on a directory that has no project behind it.
    const worktree = named.worktree && CreateScreenModel.worktreeRefusal(named) === null
    const base = CreateScreenModel.specOf({ ...named, worktree }, token)
    return {
      ...base,
      kind: 'agent',
      flowId: flow.id,
      agent: { agentId: named.agentId, mode: 'new', initialPrompt: composed.initialPrompt },
    }
  }

  /** Null when the form is finished. Otherwise the reason, in the flow's own words. */
  static problemOf(state: FlowScreenState): string | null {
    const composed = FlowCatalog.byId(state.flowId).composeOf(state.form)
    return 'problem' in composed ? composed.problem : null
  }

  private static acknowledged(state: FlowScreenState): FlowScreenStep {
    const hash = state.submitError?.setup?.hash
    if (hash === undefined) return FlowScreenModel.step(state)
    return FlowScreenModel.activated({
      ...state,
      options: { ...state.options, acknowledgeSetup: hash },
      submitError: null,
    })
  }

  /**
   * Enter is never blocked by the form being unfinished - it reports the problem instead, which is
   * the same invariant the two screens beside this one keep.
   */
  private static activated(state: FlowScreenState): FlowScreenStep {
    if (state.submitting) return FlowScreenModel.step(state)
    const problem = FlowScreenModel.problemOf(state)
    if (problem !== null) return FlowScreenModel.step({ ...state, problem })
    return FlowScreenModel.step(
      { ...state, submitting: true, problem: null, submitError: null },
      { effect: 'submit' },
    )
  }

  private static step(
    state: FlowScreenState,
    ...effects: readonly FlowScreenEffect[]
  ): FlowScreenStep {
    return { state, effects }
  }
}
