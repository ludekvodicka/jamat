import { describe, expect, it } from 'vitest'

import type { FeatureRequestState } from './featureRequestFlow'
import { FeatureRequestFlow } from './featureRequestFlow'

describe('app-client-ui/renderer/overlays/launcher/flows/featureRequest/featureRequestFlow', () => {
  const spec = FeatureRequestFlow.spec

  function filled(overrides: Partial<FeatureRequestState> = {}): FeatureRequestState {
    return {
      summary: 'Merge a worktree session back into the main copy',
      description: 'A session that ran in a worktree currently has no way home.',
      acceptance: '- A clean merge leaves no worktree behind',
      ...overrides,
    }
  }

  function composed(state: FeatureRequestState) {
    const result = spec.composeOf(state)
    if ('problem' in result) throw new Error(`expected a composition, got ${result.problem}`)
    return result
  }

  it('starts empty', () => {
    expect(spec.initial()).toEqual({ summary: '', description: '', acceptance: '' })
  })

  it('changes one field at a time and leaves the others alone', () => {
    const state = spec.transition(spec.initial(), { field: 'summary', value: 'Add merge' })

    expect(state).toEqual({ summary: 'Add merge', description: '', acceptance: '' })
    expect(spec.transition(state, { field: 'acceptance', value: '- done' }).summary)
      .toBe('Add merge')
  })

  it('throws on a field it does not know', () => {
    expect(() => spec.transition(spec.initial(), { field: 'nope' } as never))
      .toThrow(/Unknown feature request field/)
  })

  /** The summary is what the session is asked; without one there is nothing to ask. */
  it('refuses to compose without a summary, and says what a summary is for', () => {
    const empty = spec.composeOf(filled({ summary: '   ' }))

    expect(empty).toEqual({
      problem: 'a summary is what the session gets as its first instruction',
    })
  })

  it('composes the three fields into one instruction, under headings', () => {
    const result = composed(filled())

    expect(result.initialPrompt).toBe(
      '# Merge a worktree session back into the main copy\n\n'
      + '## What and why\n\nA session that ran in a worktree currently has no way home.\n\n'
      + '## Done when\n\n- A clean merge leaves no worktree behind',
    )
    expect(result.title).toBe('Merge a worktree session back into the main copy')
    expect(result.worktreeSuggested).toBe(true)
  })

  /** A heading with nothing under it reads as a question somebody forgot, not one they declined. */
  it('leaves out a section that was left empty rather than heading an empty one', () => {
    const only = composed(filled({ description: '', acceptance: '  ' }))

    expect(only.initialPrompt).toBe('# Merge a worktree session back into the main copy')
    expect(composed(filled({ acceptance: '' })).initialPrompt).not.toContain('Done when')
  })

  it('is registered under the id that travels onto the session', () => {
    expect(spec.id).toBe('feature-request')
    expect(spec.title).toBe('Feature request')
  })
})
