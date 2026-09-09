import { describe, expect, it } from 'vitest'

import { FlowCatalog, type SessionFlowSpec } from './flowCatalog'

/**
 * The catalog's own two refusals, which it had neither of. `order` decided nothing while there was
 * one flow, and that is exactly when a rule like this is cheap to add - and when nothing is there to
 * catch its absence.
 */
describe('app-client-ui/renderer/overlays/launcher/flows/flowCatalog', () => {
  function flow(id: string, order: number): SessionFlowSpec {
    return {
      id,
      title: id,
      description: id,
      order,
      initial: () => ({}),
      transition: (state) => state,
      composeOf: () => ({ initialPrompt: id, worktreeSuggested: false }),
      Form: () => {
        throw new Error(`The catalog test drew the form of ${id}`)
      },
    }
  }

  it('lists the flows it holds in order', () => {
    expect(FlowCatalog.flows([flow('second', 2), flow('first', 1)]).map((one) => one.id))
      .toEqual(['first', 'second'])
  })

  // A stored `flowId` names one flow, and two claiming it would make `byId` a coin toss.
  it('refuses two flows claiming the same id', () => {
    expect(() => FlowCatalog.flows([flow('same', 1), flow('same', 2)]))
      .toThrow(/Two flows claim the same id/)
  })

  // Two orders equal leaves the drawn sequence to the sort's stability rather than to the catalog.
  it('refuses two flows claiming the same order', () => {
    expect(() => FlowCatalog.flows([flow('one', 1), flow('two', 1)]))
      .toThrow(/Two flows claim the same order/)
  })

  it('holds the feature request flow, and answers it by id', () => {
    const ids = FlowCatalog.flows().map((one) => one.id)
    expect(ids).toContain('feature-request')
    expect(FlowCatalog.byId('feature-request').id).toBe('feature-request')
  })

  it('refuses an id it does not hold rather than drawing an empty screen', () => {
    expect(() => FlowCatalog.byId('nothing-like-this')).toThrow(/Unknown flow/)
  })
})
