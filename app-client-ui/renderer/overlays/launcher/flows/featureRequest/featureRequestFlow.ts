import type { SessionFlowCompose, SessionFlowSpec } from '../flowCatalog'
import { FeatureRequestForm } from './featureRequestForm'

export interface FeatureRequestState {
  summary: string
  description: string
  acceptance: string
}

export type FeatureRequestInput =
  | { field: 'summary' | 'description' | 'acceptance'; value: string }

/**
 * The first flow: describe the work in a form, and the session starts already holding it.
 *
 * The three fields are the three questions a person answers anyway before they start typing at an
 * agent, in the order they answer them. What makes this worth a screen rather than a bigger prompt
 * box is that the shape is remembered: the next feature request asks the same three things.
 */
export class FeatureRequestFlow {
  static readonly spec: SessionFlowSpec<FeatureRequestState, FeatureRequestInput> = {
    id: 'feature-request',
    title: 'Feature request',
    description: 'describe the work in a form, then the agent runs it',
    order: 0,
    initial: () => ({ summary: '', description: '', acceptance: '' }),
    transition: (state, input) => FeatureRequestFlow.changed(state, input),
    composeOf: (state) => FeatureRequestFlow.composeOf(state),
    Form: FeatureRequestForm,
  }

  private static changed(
    state: FeatureRequestState,
    input: FeatureRequestInput,
  ): FeatureRequestState {
    if (input.field === 'summary') return { ...state, summary: input.value }
    else if (input.field === 'description') return { ...state, description: input.value }
    else if (input.field === 'acceptance') return { ...state, acceptance: input.value }
    else
      throw new Error(`Unknown feature request field: ${JSON.stringify(input)}`)
  }

  /**
   * The summary is the only required field, because it is the only one that has to exist for the
   * session to have anything to do. The other two are sections that are simply left out when empty:
   * a heading with nothing under it reads as a question the person forgot rather than declined.
   */
  private static composeOf(
    state: FeatureRequestState,
  ): SessionFlowCompose | { problem: string } {
    const summary = state.summary.trim()
    if (summary.length === 0)
      return { problem: 'a summary is what the session gets as its first instruction' }
    const sections = [`# ${summary}`]
    const description = state.description.trim()
    if (description.length > 0) sections.push(`## What and why\n\n${description}`)
    const acceptance = state.acceptance.trim()
    if (acceptance.length > 0) sections.push(`## Done when\n\n${acceptance}`)
    return {
      initialPrompt: sections.join('\n\n'),
      title: summary,
      // A feature is a piece of work with an end, which is what a branch is for. The person's own
      // choice on the create screen still wins over this.
      worktreeSuggested: true,
    }
  }
}
