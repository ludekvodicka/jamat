import { describe, expect, it } from 'vitest'

import type { SvnConflictFact, SvnConflictOption, SvnConflictShape, SvnContentFacts, SvnPropertyFacts, SvnTreeFacts } from './svn.types'
import { SvnConflictShapes } from './svnConflictShapes'
import { SvnConflictFlow } from '../worktrees/conflicts/svnConflictFlow'
import { SvnMergerLauncher } from '../worktrees/conflicts/svnMergerLauncher'

const tree = (reason: SvnTreeFacts['reason'], action: SvnTreeFacts['action'], localKind: SvnTreeFacts['localKind'],
  incomingKind: SvnTreeFacts['incomingKind'], localHistory = false): SvnTreeFacts =>
  ({ reason, action, localKind, incomingKind, incomingRevision: 421, localHistory })
const content = (equal: SvnContentFacts['equal'], more: Partial<SvnContentFacts> = {}): SvnContentFacts =>
  ({ binary: false, unreadable: false, equal, ...more })
const property = (name: string): SvnPropertyFacts => ({ name, older: 'a', mine: 'b', theirs: 'c' })

function fact(kind: SvnConflictFact['kind'], more: Partial<SvnConflictFact> = {}): SvnConflictFact {
  return { path: 'src/a.ts', kind, takesArgument: true, tree: null, sidecars: [], properties: [], content: null, ...more }
}

const files = { local: 2, incoming: 3, same: 0, differing: 0 }

it.each([true, false])('routes unknown property values to the person through the production set and launcher (%s)', (rules) => {
  const set = SvnConflictFlow.setOf({ revision: 5, facts: [fact('property')], rows: [] }, 4, 1, rules)
  const entry = set.entries[0]
  expect(entry.state).toBe('person')
  expect(SvnMergerLauncher.forAgent(entry)).toBe(false)
  expect(SvnConflictShapes.agentOption(entry.shape, entry.kind, 'take-incoming', entry.facts.properties)).toBe(false)
})

it('runs the text and property rules of an UPDATE, never a tree rule, and leaves the rest to its resolver (Finish 072)', () => {
  const clean = fact('text', { path: 'clean.ts', content: content('differs', { merge: 'clean' }) })
  const overlap = fact('text', { path: 'overlap.ts', content: content('differs', { merge: 'conflict' }) })
  const dir = fact('tree', { path: 'dir', tree: tree('obstructed', 'added', 'none', 'dir'), content: content(null, { files }) })
  const update = SvnConflictFlow.setOf({ revision: 5, facts: [clean, overlap], rows: [] }, 4, 1, false)
  expect(update.entries.map((entry) => [entry.path, entry.state, entry.rule])).toEqual([['clean.ts', 'rule', 'merged'], ['overlap.ts', 'agent', undefined]])
  const tree_ = SvnConflictFlow.setOf({ revision: 5, facts: [dir, clean], rows: [] }, 4, 1, false)
  expect(tree_.entries.map((entry) => [entry.path, entry.state])).toEqual([['dir', 'person'], ['clean.ts', 'rule']])
  expect(SvnConflictFlow.setOf({ revision: 5, facts: [dir], rows: [] }, 4, 1, true).entries[0]).toMatchObject({ state: 'rule', rule: 'keep-both' })
})

it('limits agent merged to text without a concurrent property conflict', () => {
  expect(SvnConflictShapes.agentOption('text-overlap', 'text', 'merged')).toBe(true)
  expect(SvnConflictShapes.agentOption('text-overlap', 'text', 'merged', ['svn:externals'])).toBe(false)
  expect(SvnConflictShapes.agentOption('property-value', 'property', 'merged', ['owner'])).toBe(false)
  expect(SvnConflictShapes.agentOption('externals', 'property', 'merged', ['svn:externals'])).toBe(false)
  expect(SvnConflictShapes.agentOption('added-both', 'tree', 'merged')).toBe(false)
})

/** One fact per shape the classifier reaches, with the rule its facts prove. */
const cases: [string, SvnConflictFact, SvnConflictShape, SvnConflictOption | null][] = [
  ['overlapping text', fact('text', { content: content('differs') }), 'text-overlap', null],
  ['overlapping text whose sides conflict when merged', fact('text', { content: content('differs', { merge: 'conflict' }) }), 'text-overlap', null],
  ['text that merges cleanly once line ends are ignored', fact('text', { content: content('differs', { merge: 'clean' }) }), 'text-overlap', 'merged'],
  ['text that merges cleanly, with a property conflict too', fact('text', { content: content('differs', { merge: 'clean' }), properties: [property('p')] }), 'text-overlap', null],
  ['EOL-only text', fact('text', { content: content('eol') }), 'text-same', 'take-incoming'],
  ['equal text', fact('text', { content: content('bytes') }), 'text-same', 'take-incoming'],
  ['EOL-only text with a property conflict too', fact('text', { content: content('eol'), properties: [property('p')] }), 'text-same', null],
  ['equal binary', fact('text', { content: content('bytes', { binary: true }) }), 'binary', 'take-incoming'],
  ['differing binary', fact('text', { content: content('differs', { binary: true }) }), 'binary', null],
  ['UTF-16', fact('text', { content: content('differs', { binary: true, unreadable: true }) }), 'text-unreadable', null],
  ['svn:mergeinfo', fact('property', { properties: [property('svn:mergeinfo')] }), 'mergeinfo', null],
  ['svn:ignore', fact('property', { properties: [property('svn:ignore'), property('svn:global-ignores')] }), 'line-list-property', 'union'],
  ['a custom property', fact('property', { properties: [property('jamat:owner'), property('svn:ignore')] }), 'property-value', null],
  ['unknown property values', fact('property'), 'property-unknown', null],
  ['svn:externals', fact('property', { properties: [property('svn:ignore'), property('svn:externals')] }), 'externals', null],
  ['the incident directory', fact('tree', { tree: tree('unversioned', 'added', 'dir', 'dir'), content: content(null, { files }) }), 'obstructed-dir', 'keep-both'],
  ['a directory obstruction not read', fact('tree', { tree: tree('obstructed', 'added', 'dir', 'dir') }), 'obstructed-dir', null],
  ['an equal file obstruction', fact('tree', { tree: tree('unversioned', 'added', 'file', 'file'), content: content('bytes') }), 'obstructed-file', 'take-incoming'],
  ['a differing file obstruction', fact('tree', { tree: tree('unversioned', 'added', 'file', 'file'), content: content('differs') }), 'obstructed-file', null],
  ['a local add of an equal file', fact('tree', { tree: tree('added', 'added', 'file', 'file'), content: content('bytes') }), 'added-both', 'take-incoming'],
  ['a local add with history', fact('tree', { tree: tree('added', 'added', 'file', 'file', true), content: content('bytes') }), 'added-both', null],
  ['a local add of a directory', fact('tree', { tree: tree('added', 'added', 'dir', 'dir'), content: content(null, { files }) }), 'added-both', 'keep-both'],
  ['a kind mismatch', fact('tree', { tree: tree('unversioned', 'added', 'file', 'dir') }), 'kind-mismatch', null],
  ['edit against delete', fact('tree', { tree: tree('edited', 'deleted', 'file', 'none') }), 'edit-vs-delete', null],
  ['edit against replace', fact('tree', { tree: tree('edited', 'replaced', 'file', 'file') }), 'edit-vs-replace', null],
  ['delete against edit', fact('tree', { tree: tree('deleted', 'edited', 'file', 'file') }), 'delete-vs-edit', null],
  ['a local move against edit', fact('tree', { tree: tree('moved-away', 'edited', 'file', 'file') }), 'delete-vs-edit', null],
  ['both deleted', fact('tree', { tree: tree('deleted', 'deleted', 'file', 'none') }), 'delete-vs-delete', 'merged'],
  ['missing against delete', fact('tree', { tree: tree('missing', 'deleted', 'file', 'none') }), 'delete-vs-delete', 'merged'],
  ['a local replace', fact('tree', { tree: tree('replaced', 'edited', 'file', 'file') }), 'replace-or-case', null],
]

const caseOf = (title: string): SvnConflictFact => {
  const found = cases.find(([name]) => name === title)
  if (found === undefined) throw new Error(`No case ${title}`)
  return found[1]
}

describe('lib-orchestrator/svn/svnConflictShapes', () => {
  it.each(cases)('classifies %s', (_title, input, shape, rule) => {
    const plan = SvnConflictShapes.planOf(input)
    expect(plan.shape).toBe(shape)
    expect(plan.rule).toBe(rule)
    expect(plan.options.length).toBeGreaterThan(0)
    if (rule !== null) {
      expect(plan.options).toContain(rule)
      // take-incoming loses nothing where the two sides are equal, or differ only in line ends.
      expect(SvnConflictShapes.lossOf(rule) === 'nothing' || input.content?.equal === 'bytes' || input.content?.equal === 'eol').toBe(true)
    }
  })

  it('sets a rule only under its proof: equal bytes, EOL only, a clean merge, a line list, equal property values, a read directory or both deleted', () => {
    const ruled = cases.filter(([, , , rule]) => rule !== null).map(([title]) => title)
    expect(ruled).toEqual(['text that merges cleanly once line ends are ignored', 'EOL-only text', 'equal text', 'equal binary', 'svn:ignore', 'the incident directory',
      'an equal file obstruction', 'a local add of an equal file', 'a local add of a directory', 'both deleted', 'missing against delete'])
    // A differing binary, svn:mergeinfo (svn merges it itself), another property's value and svn:externals get none.
    expect(['differing binary', 'svn:mergeinfo', 'a custom property', 'svn:externals']
      .map((title) => SvnConflictShapes.planOf(caseOf(title)).rule)).toEqual([null, null, null, null])
  })

  it('admits keep-both for a directory add and merged for a file add, never both', () => {
    expect(SvnConflictShapes.planOf(caseOf('a local add of a directory')).options).toEqual(['keep-both', 'take-incoming', 'keep-mine'])
    expect(SvnConflictShapes.planOf(caseOf('a local add of an equal file')).options).toEqual(['merged', 'take-incoming', 'keep-mine'])
  })

  it('offers keep-both on a move: the incoming edit onto the session\'s move target, the session\'s edit onto a file the other commit moved', () => {
    expect(SvnConflictShapes.planOf(fact('tree', { tree: { ...tree('moved-away', 'edited', 'file', 'file'), movedTo: 'src/b.ts' } })))
      .toEqual({ shape: 'delete-vs-edit', options: ['keep-both', 'keep-mine'], rule: null, agent: false })
    expect(SvnConflictShapes.planOf(fact('tree', { tree: { ...tree('edited', 'deleted', 'file', 'none'), movedTo: 'src/b.ts' } })))
      .toEqual({ shape: 'edit-vs-delete', options: ['keep-both', 'merged', 'take-incoming', 'keep-mine'], rule: null, agent: true })
    // svn drops the session's unversioned files below a folder it carries to the new place (spike `edit-vs-move-dir`).
    expect(SvnConflictShapes.planOf(fact('tree', { tree: { ...tree('edited', 'deleted', 'dir', 'none'), movedTo: 'lib' } })).options)
      .toEqual(['merged', 'take-incoming', 'keep-mine'])
    expect(SvnConflictShapes.planOf(caseOf('edit against delete')).options).toEqual(['merged', 'take-incoming', 'keep-mine'])
    expect(SvnConflictShapes.agentOption('edit-vs-delete', 'tree', 'keep-both')).toBe(true)
  })

  it('classifies an unknown reason or action, and a conflict without facts, as unrecognized with person options only', () => {
    for (const input of [
      fact('tree', { tree: tree('unrecognized', 'added', 'dir', 'dir') }),
      fact('tree', { tree: tree('edited', 'unrecognized', 'file', 'file') }),
      fact('tree', { tree: tree('edited', 'edited', 'dir', 'dir') }),
      fact('tree'),
      fact('text'),
    ])
      expect(SvnConflictShapes.planOf(input)).toEqual({ shape: 'unrecognized', options: ['take-incoming', 'keep-mine'], rule: null, agent: false })
  })

  it('classifies a name svn cannot take as name-unsafe with no option, whatever its facts', () => {
    expect(SvnConflictShapes.planOf(fact('tree', { path: 'složka/ř.txt', takesArgument: false, tree: tree('unversioned', 'added', 'dir', 'dir'), content: content(null, { files }) })))
      .toEqual({ shape: 'name-unsafe', options: [], rule: null, agent: false })
  })

  it('gives the same plan to the same facts under .aidocs/engines and under src/feature', () => {
    const incident = caseOf('the incident directory')
    expect(SvnConflictShapes.planOf({ ...incident, path: '.aidocs/engines' })).toEqual(SvnConflictShapes.planOf({ ...incident, path: 'src/feature' }))
  })

  it('lets an agent settle text, tree and property shapes but leaves externals, binary and kind mismatches to the person', () => {
    const agentOf = (title: string): boolean => SvnConflictShapes.planOf(cases.find(([name]) => name === title)?.[1] ?? fact('text')).agent
    expect(['overlapping text', 'the incident directory', 'a custom property', 'edit against delete'].map(agentOf)).toEqual([true, true, true, true])
    expect(['svn:externals', 'differing binary', 'UTF-16', 'a kind mismatch', 'delete against edit'].map(agentOf)).toEqual([false, false, false, false, false])
  })

  it('names what each option loses: merged, keep-both and union nothing, take-incoming mine, keep-mine incoming', () => {
    expect((['merged', 'keep-both', 'union', 'take-incoming', 'keep-mine'] as const).map((option) => SvnConflictShapes.lossOf(option)))
      .toEqual(['nothing', 'nothing', 'nothing', 'mine', 'incoming'])
    expect(() => SvnConflictShapes.lossOf('discard' as SvnConflictOption)).toThrow(/Unknown conflict option/)
  })

  it('throws on an unknown conflict kind', () => {
    expect(() => SvnConflictShapes.planOf(fact('diverged' as SvnConflictFact['kind']))).toThrow(/Unknown conflict kind/)
  })
})
