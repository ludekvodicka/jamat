import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { SvnConflictApply, SvnConflictFact, SvnConflictRead, SvnItemRow, SvnResult } from '../../svn/svn.types'
import type { SessionRecord, SessionRecordSvnAction, SvnActionConflictSet } from '../../sessionManager/worktreeSessionRecords'
import { SvnConflictFlow, type SvnConflictFlowDeps } from './svnConflictFlow'
import { SvnConflictWords } from './svnConflictWords'
import { SvnTextResolution } from '../../svn/svnTextResolution'

const text = (path: string): SvnConflictFact => ({
  path, kind: 'text', takesArgument: true, tree: null, sidecars: [`${path}.mine`], properties: [],
  content: { binary: false, unreadable: false, equal: 'differs' },
})
const incident: SvnConflictFact = {
  path: '.aidocs/engines', kind: 'tree', takesArgument: true, sidecars: [], properties: [],
  tree: { reason: 'unversioned', action: 'added', localKind: 'dir', incomingKind: 'dir', incomingRevision: 421, localHistory: false },
  content: { binary: false, unreadable: false, equal: null, files: { local: 2, incoming: 3, same: 0, differing: 0 } },
}
const property: SvnConflictFact = {
  path: '.', kind: 'property', takesArgument: true, tree: null, sidecars: ['dir_conflicts.prej'], content: null,
  properties: [{ name: 'svn:ignore', older: 'a\n', mine: 'a\nb\n', theirs: 'a\nc\n' }],
}
const action = { root: 'Q:/work/.worktrees/006', baseRevision: 420, actionId: 'a1', kind: 'finish' } as SessionRecordSvnAction
const noJournal = async (): Promise<void> => undefined

interface FlowHarness {
  flow: SvnConflictFlow
  asked: string[]
  /** Every option the executor ran, as `path option`. */
  applied: string[]
  /** The facts the next read answers. */
  facts: SvnConflictFact[]
  /** The files that still hold a marker line. */
  markers: string[]
  /** The detail of a failing option, or null. */
  failure: string | null
  /** The same-name files the option's first step leaves diverged. */
  diverged: string[]
  /** The status rows every read answers. */
  rows: SvnItemRow[]
  lockedPaths?: string[]
  /** The merger briefs written, by `<parentId>/<actionId>`. */
  briefs: Map<string, string>
  /** Why no merger runs here, or null. */
  unavailable: string | null
  /** The changed paths `svn status` lists, and the content of each as its hash (`same` when not named). */
  changed: string[]
  contents: Map<string, string>
  /** The highest BASE past the update, or null. */
  baseAbove: number | null
  /** The hashes each merger started on, by action. */
  handovers: Map<string, Map<string, string>>
}

function flowOver(facts: SvnConflictFact[], deps: Partial<SvnConflictFlowDeps> = {}): FlowHarness {
  const it_: FlowHarness = { flow: null as unknown as SvnConflictFlow, asked: [], applied: [], facts, markers: [], failure: null, diverged: [], rows: [], briefs: new Map(), unavailable: null,
    changed: [], contents: new Map(), baseAbove: null, handovers: new Map() }
  it_.flow = new SvnConflictFlow({
    svn: {
      conflictSet: async (root, base): Promise<SvnResult<SvnConflictRead>> => {
        it_.asked.push(`${root} r${base}`)
        return { ok: true, value: { revision: 422, facts: it_.facts, rows: it_.rows, lockedPaths: it_.lockedPaths } }
      },
      logOf: async () => ({ ok: true, value: [{ revision: 422, author: 'ana', message: 'Přidej stopu enginů' }] }),
      changes: async () => ({ ok: true, value: it_.changed.map((path) => ({ kind: 'item' as const, conflict: false, path })) }),
      hashes: async (_root, paths) => ({ ok: true, value: Object.fromEntries(paths.map((path) => [path, it_.contents.get(path) ?? 'same'])) }),
      baseAbove: async () => ({ ok: true, value: it_.baseAbove }),
    },
    handover: {
      writeHandover: async (actionId, hashes) => {
        it_.handovers.set(actionId, new Map(Object.entries(hashes)))
        return true
      },
      readHandover: async (actionId) => it_.handovers.get(actionId) ?? null,
    },
    briefs: {
      mergeBriefPathOf: (parentId, actionId) => `L:/logs/${parentId}/${actionId}-merge.md`,
      writeMergeBrief: async (parentId, actionId, text) => {
        it_.briefs.set(`${parentId}/${actionId}`, text)
        return { ok: true, bytes: text.length }
      },
    },
    resolutions: { recoveredChoice: SvnTextResolution.recoveredChoice, recoverLocked: async () => ({ ok: true, value: undefined }), apply: async (input: SvnConflictApply) => {
      it_.applied.push(`${input.path} ${input.option} from ${input.journal?.done ?? 0} into ${input.savedDir}`)
      await input.onStep({ option: input.option, done: (input.journal?.done ?? 0) + 1 }, it_.diverged)
      return it_.failure === null ? { ok: true, value: undefined } : { ok: false, code: 'svn-failed', detail: it_.failure }
    } },
    savedDirectoryOf: (actionId) => `R:/results/${actionId}/saved`,
    withMarkers: async (_root, paths) => paths.filter((path) => it_.markers.includes(path)),
    unavailable: () => it_.unavailable,
    cli: () => ({ ok: true, command: 'node "C:/Jamat/skills/claude/appjamat-v3/scripts/jamat-v3.mjs"' }),
    now: () => 7_000,
    ...deps,
  })
  return it_
}

async function setOf(facts: SvnConflictFact[]): Promise<SvnActionConflictSet> {
  const read = await flowOver(facts).flow.read(action)
  if (!read.ok) throw new Error(read.detail)
  return SvnConflictFlow.toPerson(read.value)
}

describe('lib-orchestrator/sessionManager/lifecycle/svnConflictFlow', () => {
  it('saves conflict working files and sidecars, then detects markers and a reverted session side', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jamat-conflict-memory-'))
    try {
      const fact = { ...text('a.ts'), sidecars: ['a.ts.mine', 'a.ts.r4', 'a.ts.r5'] }
      const markers = '<<<<<<< .mine\nours\n=======\ntheirs\n>>>>>>> .r5'
      for (const [path, content] of [['a.ts', markers], ['a.ts.mine', 'ours'], ['a.ts.r4', 'base'], ['a.ts.r5', 'theirs']])
        await writeFile(join(root, path), content)
      const it_ = flowOver([fact], { savedDirectoryOf: (id) => join(root, 'results', id, 'saved') })
      const next = { ...action, root }
      const remembered = await it_.flow.remember(next)
      expect(remembered.ok).toBe(true)
      if (!remembered.ok) throw new Error(remembered.detail)
      const memory = remembered.value.memory
      const same = await it_.flow.remember(next, memory)
      expect(same.ok && same.value.memory.paths[0]).toEqual(memory.paths[0])
      expect(await readFile(join(memory.paths[0].saved, 'working'), 'utf8')).toBe(markers)
      expect(await readFile(join(memory.paths[0].saved, 'sidecars', '0'), 'utf8')).toBe('ours')
      it_.facts = []
      expect(await it_.flow.remembered(next, memory)).toMatchObject({ ok: true, value: { reasons: ['a.ts still contains conflict markers'] } })
      await writeFile(join(root, 'a.ts'), 'theirs')
      expect(await it_.flow.remembered(next, memory)).toMatchObject({ ok: true, value: {
        reasons: [`a.ts drops the session's side; saved copy: ${memory.paths[0].saved}`],
      } })
      await writeFile(join(root, 'a.ts.r5'), 'new incoming')
      it_.facts = [fact]
      const reread = await it_.flow.remember(next, memory)
      if (!reread.ok) throw new Error(reread.detail)
      expect(reread.value.memory.paths[0].saved).not.toBe(memory.paths[0].saved)
      expect(await readFile(join(reread.value.memory.paths[0].saved, 'sidecars', '2'), 'utf8')).toBe('new incoming')
      expect(await readFile(join(memory.paths[0].saved, 'sidecars', '2'), 'utf8')).toBe('theirs')
      it_.facts = []
      await writeFile(join(root, 'a.ts'), 'ours and theirs')
      expect(await it_.flow.remembered(next, memory)).toMatchObject({ ok: true, value: { memory: { paths: [] }, reasons: [] } })
    }
    finally { await rm(root, { recursive: true, force: true }) }
  })

  it('records the incident with its facts, classified once: the folder is Jamat\'s rule, the text files an agent\'s', async () => {
    const { flow, asked } = flowOver([incident, text('src/catalog.ts'), text('src/wallets.ts')])
    const read = await flow.read(action)
    expect(asked).toEqual(['Q:/work/.worktrees/006 r420'])
    expect(read).toMatchObject({ ok: true, value: {
      readAt: 7_000, baseRevision: 420, revision: 422, more: 0,
      entries: [
        { path: '.aidocs/engines', kind: 'tree', shape: 'obstructed-dir', state: 'rule', options: ['keep-both', 'take-incoming', 'keep-mine'],
          rule: 'keep-both', facts: { reason: 'unversioned', action: 'added', localKind: 'dir', incomingKind: 'dir', incomingRevision: 421,
            files: { local: 2, incoming: 3, same: 0, differing: 0 } } },
        { path: 'src/catalog.ts', kind: 'text', shape: 'text-overlap', state: 'agent', options: ['merged', 'take-incoming', 'keep-mine'],
          facts: { incomingRevision: 422 } },
        { path: 'src/wallets.ts', kind: 'text', shape: 'text-overlap', state: 'agent', options: ['merged', 'take-incoming', 'keep-mine'],
          facts: { incomingRevision: 422 } },
      ],
    } })
    // An UPDATE of a main copy runs no rule: a tree conflict makes the whole set the person's.
    const update = await flow.read({ ...action, kind: 'update-main' })
    expect(update.ok && update.value.entries.map((entry) => [entry.state, entry.rule])).toEqual([['person', 'keep-both'], ['person', undefined], ['person', undefined]])
  })

  describe('guards after a merger', () => {
    const ended = async (): Promise<SessionRecordSvnAction> => {
      const set = await setOf([text('src/catalog.ts')])
      return {
        ...action,
        stage: 'fixing',
        merger: { runId: 'm1', setAt: set.readAt, startedAt: 1, endedAt: 2 },
        conflictSet: { ...set, waited: true, entries: set.entries.map((entry) => ({ ...entry, state: 'settled' as const, by: 'merger' as const })) },
      }
    }

    it('names a file changed outside the conflicts while the merger ran, once; Check again accepts it', async () => {
      const it_ = flowOver([])
      it_.handovers.set('a1', new Map([['src/wallets.ts', 'w1'], ['src/catalog.ts', 'c1']]))
      it_.changed = ['src/wallets.ts', 'src/catalog.ts']
      it_.contents = new Map([['src/wallets.ts', 'w2'], ['src/catalog.ts', 'c2']])
      const first = await it_.flow.fix(await ended(), () => undefined, noJournal)
      expect(first.kind).toBe('needs')
      expect(first.kind === 'needs' && first.reason)
        .toBe('changed outside the conflicts while the merger ran: src/wallets.ts; 1 conflict: merger fixed 1; press Check again')
      expect(first.action.merger).toMatchObject({ endedAt: 2, checkedAt: 7_000 })

      const again = await it_.flow.fix({ ...first.action, needs: undefined }, () => undefined, noJournal)
      expect(again.kind).toBe('settled')
    })

    it('names a commit made from the worktree while the merger ran', async () => {
      const it_ = flowOver([])
      it_.handovers.set('a1', new Map())
      it_.baseAbove = 423
      const step = await it_.flow.fix(await ended(), () => undefined, noJournal)
      expect(step.kind === 'needs' && step.reason).toMatch(/^a commit was made from the worktree while the merger ran \(r423\); /)
    })

    it('writes the hashes of every changed path when a merger starts', async () => {
      const it_ = flowOver([])
      it_.changed = ['src/wallets.ts']
      it_.contents = new Map([['src/wallets.ts', 'w1']])
      expect(await it_.flow.handOver(action)).toEqual({ ok: true, value: undefined })
      expect(it_.handovers.get('a1')).toEqual(new Map([['src/wallets.ts', 'w1']]))
    })
  })

  describe('merger brief', () => {
    const parent = { sessionId: 'p1', title: '006 - trail' } as SessionRecord

    it('writes the brief of a set with a path an agent may settle and names it on the action, the log messages intact', async () => {
      const it_ = flowOver([])
      const briefed = await it_.flow.brief(parent, { ...action, conflictSet: await setOf([incident, text('src/catalog.ts')]) })
      expect(briefed.ok && briefed.value.mergeBrief).toBe('L:/logs/p1/a1-merge.md')
      const text_ = it_.briefs.get('p1/a1') ?? ''
      expect(text_).toContain('# Merge the conflicts of 006 - trail')
      expect(text_).toContain('--path src/catalog.ts --option merged')
      expect(text_).toContain('  > Přidej stopu enginů')
    })

    // The person's ~/.claude skill reached another Jamat instance from a lab merger (UA1-J14-9).
    it("names this client's own CLI line, never the person's home skill", async () => {
      const it_ = flowOver([])
      await it_.flow.brief(parent, { ...action, conflictSet: await setOf([text('src/catalog.ts')]) })
      const text_ = it_.briefs.get('p1/a1') ?? ''
      expect(text_).toContain('node "C:/Jamat/skills/claude/appjamat-v3/scripts/jamat-v3.mjs" sessions resolve-conflict --self')
      expect(text_).not.toContain('.claude/skills')
    })

    it('answers a brief that cannot name the CLI', async () => {
      const it_ = flowOver([], { cli: () => ({ ok: false, detail: 'The Jamat CLI wrapper is missing: X' }) })
      expect(await it_.flow.brief(parent, { ...action, conflictSet: await setOf([text('a.txt')]) }))
        .toEqual({ ok: false, code: 'svn-failed', detail: "the merger's brief could not name the Jamat CLI (The Jamat CLI wrapper is missing: X)" })
      expect(it_.briefs.size).toBe(0)
    })

    it('writes none for an UPDATE, or for a set with no path an agent may settle', async () => {
      const it_ = flowOver([])
      const unsafe: SvnConflictFact = { ...text('docs/přehled.md'), takesArgument: false }
      for (const next of [
        { ...action, kind: 'update-main' as const, conflictSet: await setOf([text('a.txt')]) },
        { ...action, conflictSet: await setOf([unsafe]) },
        { ...action },
      ]) expect(await it_.flow.brief(parent, next)).toEqual({ ok: true, value: next })
      expect(it_.briefs.size).toBe(0)
    })

    it('answers a brief it could not write', async () => {
      const it_ = flowOver([], { briefs: { mergeBriefPathOf: () => 'x', writeMergeBrief: async () => ({ ok: false, detail: 'EACCES' }) } })
      expect(await it_.flow.brief(parent, { ...action, conflictSet: await setOf([text('a.txt')]) }))
        .toEqual({ ok: false, code: 'svn-failed', detail: "the merger's brief could not be written (EACCES)" })
    })
  })

  describe('rules', () => {
    async function fresh(facts: SvnConflictFact[]): Promise<SvnActionConflictSet> {
      const read = await flowOver(facts).flow.read(action)
      if (!read.ok) throw new Error(read.detail)
      return read.value
    }

    it('settles the incident folder by Jamat with keep-both, one entry per call, then gives the two text files to the merger', async () => {
      const set = await fresh([incident, text('src/catalog.ts'), text('src/wallets.ts')])
      const it_ = flowOver([text('src/catalog.ts'), text('src/wallets.ts')])
      const fixes: string[] = []
      const journals: string[] = []
      const note = async (path: string, journal: { option: string; done: number }): Promise<void> => { journals.push(`${path} ${journal.option} ${journal.done}`) }

      const first = await it_.flow.fix({ ...action, conflictSet: set }, (fix) => fixes.push(`${fix.path} ${fix.option} ${fix.index}/${fix.count}`), note)

      expect(first.kind).toBe('applied')
      expect(fixes).toEqual(['.aidocs/engines keep-both 1/1'])
      expect(it_.applied).toEqual([`.aidocs/engines keep-both from 0 into ${join('R:/results/a1/saved', 'resolutions', set.entries[0].occurrenceId!)}`])
      expect(journals).toEqual(['.aidocs/engines keep-both 1'])
      expect(first.action.fixed).toEqual([{ path: '.aidocs/engines', option: 'keep-both' }])
      const folder = first.action.conflictSet?.entries[0]
      expect(folder).toMatchObject({ state: 'settled', by: 'jamat', settledWith: 'keep-both', journal: { option: 'keep-both', done: 1 } })
      expect(folder?.saved).toBe(join('R:/results/a1/saved', 'resolutions', set.entries[0].occurrenceId!, '.aidocs/engines'))
      expect(SvnConflictWords.summaryOf(first.action.conflictSet!)).toBe('3 conflicts: Jamat fixed 1, merger on 2')

      const second = await it_.flow.fix(first.action, () => undefined, note)
      expect(second.kind).toBe('merge')
      expect(second.action.conflictSet?.entries.map((entry) => entry.state)).toEqual(['settled', 'agent', 'agent'])
      expect(it_.applied).toHaveLength(1)
      // One merger per set: a merger already started on it hands the rest to the person.
      const again = await it_.flow.fix({ ...first.action, merger: { runId: 'm1', setAt: set.readAt, startedAt: 1 } }, () => undefined, note)
      expect(again.kind).toBe('needs')
      expect(again.action.conflictSet?.entries.map((entry) => entry.state)).toEqual(['settled', 'person', 'person'])
    })

    it('resumes a journaled rule at its first undone step after a restart', async () => {
      const set = await fresh([incident])
      const journaled = { ...set, entries: [{ ...set.entries[0], journal: { option: 'keep-both' as const, done: 3 } }] }
      const it_ = flowOver([])
      const step = await it_.flow.fix({ ...action, conflictSet: journaled }, () => undefined, noJournal)
      expect(it_.applied).toEqual([`.aidocs/engines keep-both from 3 into ${join('R:/results/a1/saved', 'resolutions', set.entries[0].occurrenceId!)}`])
      expect(step.action.conflictSet?.entries[0]).toMatchObject({ state: 'settled', by: 'jamat', journal: { option: 'keep-both', done: 4 } })
      expect((await it_.flow.fix(step.action, () => undefined, noJournal)).kind).toBe('settled')
    })

    it('reopens the entry for the person when a guard finds the rule dropped incoming files, and stops the rules', async () => {
      const set = await fresh([incident])
      const it_ = flowOver([])
      it_.rows = ['.aidocs/engines/t2', '.aidocs/engines/t2/brief.md'].map((path): SvnItemRow => ({ path, item: 'deleted', conflict: false, base: 422 }))
      const step = await it_.flow.fix({ ...action, conflictSet: set }, () => undefined, noJournal)
      expect(step.kind).toBe('needs')
      expect(step.action.conflictSet?.waited).toBe(true)
      expect(step.action.conflictSet?.entries[0]).toMatchObject({ shape: 'drops-incoming', state: 'person', options: ['keep-both', 'keep-mine'] })
      expect(step.action.fixed).toBeUndefined()
      expect(step.kind === 'needs' && step.reason).toMatch(/^the commit would drop what r421 brought in below .aidocs\/engines; 1 conflict needs you/)
    })

    it('hands the set to the person with svn\'s words when a rule fails', async () => {
      const set = await fresh([incident, text('src/catalog.ts')])
      const it_ = flowOver([])
      it_.failure = 'svn: E155010: the node was not found'
      const step = await it_.flow.fix({ ...action, conflictSet: set }, () => undefined, noJournal)
      expect(step).toMatchObject({ kind: 'needs', need: 'conflict' })
      expect(step.kind === 'needs' && step.reason).toMatch(/^Jamat could not apply keep both to .aidocs\/engines: svn: E155010.*; 2 conflicts need you/)
      expect(step.action.conflictSet?.entries.map((entry) => entry.state)).toEqual(['person', 'person'])
    })

    it('never touches a local add with history, gives it to the merger with the rest, and to the person when no merger runs here', async () => {
      const history: SvnConflictFact = { ...incident, path: 'docs', tree: { ...incident.tree!, reason: 'added', localHistory: true } }
      const set = await fresh([history, text('src/catalog.ts')])
      expect(set.entries.map((entry) => [entry.shape, entry.state, entry.rule])).toEqual([['added-both', 'agent', undefined], ['text-overlap', 'agent', undefined]])
      const it_ = flowOver([history, text('src/catalog.ts')])
      expect((await it_.flow.fix({ ...action, conflictSet: set }, () => undefined, noJournal)).kind).toBe('merge')
      expect(it_.applied).toEqual([])

      it_.unavailable = 'claude was not found on PATH'
      const step = await it_.flow.fix({ ...action, conflictSet: set }, () => undefined, noJournal)
      expect(step.kind).toBe('needs')
      expect(step.kind === 'needs' && step.reason)
        .toBe('2 conflicts need you: docs (tree), src/catalog.ts; settle them, then press Check again (no merger runs here: claude was not found on PATH)')
    })

    it('gives a person-only path to the person and the rest to the merger', async () => {
      const mismatch: SvnConflictFact = { ...incident, path: 'lib', tree: { ...incident.tree!, reason: 'unversioned', localKind: 'file', incomingKind: 'dir' },
        content: { binary: false, unreadable: false, equal: null } }
      const set = await fresh([mismatch, text('src/catalog.ts')])
      const step = await flowOver([mismatch, text('src/catalog.ts')]).flow.fix({ ...action, conflictSet: set }, () => undefined, noJournal)
      expect(step.kind).toBe('merge')
      expect(step.action.conflictSet?.entries.map((entry) => `${entry.shape} ${entry.state}`)).toEqual(['kind-mismatch person', 'text-overlap agent'])
    })
  })

  it('names the incoming revision of each conflict\'s own working copy, so one in an external does not take the root\'s (UA1-J06-3)', async () => {
    const { flow } = flowOver([{ ...text('lib/ea/a.txt'), rootRevision: 2 }, { ...text('src/k.txt'), rootRevision: 422 }, incident])
    const read = await flow.read(action)
    expect(read.ok && read.value.entries.map((entry) => [entry.path, entry.facts.incomingRevision]))
      .toEqual([['lib/ea/a.txt', 2], ['src/k.txt', 422], ['.aidocs/engines', 421]])
    expect(read.ok && SvnConflictWords.descriptionOf(read.value.entries[0])).toBe('Your session and r2 changed the same lines of this file.')
  })

  it('gives each path of a Finish an agent may settle to the merger, keeps the property names and an unsafe name as facts', async () => {
    const texts = await flowOver([text('a.txt'), { ...text('ř.txt'), takesArgument: false }]).flow.read(action)
    expect(texts.ok && texts.value.entries.map((entry) => [entry.shape, entry.state, entry.facts.unsafe])).toEqual([
      ['text-overlap', 'agent', undefined], ['name-unsafe', 'person', true],
    ])

    const custom: SvnConflictFact = { ...property, properties: [{ name: 'jamat:owner', older: 'a', mine: 'b', theirs: 'c' }] }
    const mixed = await flowOver([text('a.txt'), custom]).flow.read(action)
    expect(mixed.ok && mixed.value.entries.map((entry) => entry.state)).toEqual(['agent', 'agent'])
    expect(mixed.ok && mixed.value.entries[1]?.facts.properties).toEqual(['jamat:owner'])
    // An UPDATE's resolver takes text conflicts only: any other kind makes the set the person's.
    const update = await flowOver([text('a.txt'), custom]).flow.read({ ...action, kind: 'update-main' })
    expect(update.ok && update.value.entries.map((entry) => entry.state)).toEqual(['person', 'person'])
    expect(update.ok && SvnConflictFlow.forAgent(update.value)).toBe(false)
    // A line list has a rule, so it is Jamat's and leaves the text file to an agent.
    const ruled = await flowOver([text('a.txt'), property]).flow.read(action)
    expect(ruled.ok && ruled.value.entries.map((entry) => [entry.state, entry.rule])).toEqual([['agent', undefined], ['rule', 'union']])
  })

  it('keeps at most 200 entries and counts the rest, which makes the whole set the person\'s', async () => {
    const read = await flowOver(Array.from({ length: 250 }, (_, index) => text(`f${index}.txt`))).flow.read(action)
    expect(read.ok && read.value.entries).toHaveLength(200)
    expect(read.ok && read.value.more).toBe(50)
    expect(read.ok && read.value.entries.every((entry) => entry.state === 'person')).toBe(true)
    expect(read.ok && SvnConflictFlow.totalOf(read.value)).toBe(250)
  })

  it('hands a waiting set to the person and marks a settled one by its actor; an empty set is not open', async () => {
    const read = await flowOver([text('a.txt'), text('b.txt')]).flow.read(action)
    if (!read.ok) throw new Error(read.detail)
    const settled = SvnConflictFlow.settledBy({ ...read.value, entries: [read.value.entries[0]] }, 'agent')
    expect(settled.entries).toMatchObject([{ state: 'settled', by: 'agent' }])
    expect(SvnConflictFlow.toPerson({ ...read.value, entries: [...settled.entries, read.value.entries[1]] }).entries.map((entry) => entry.state))
      .toEqual(['settled', 'person'])
    expect(SvnConflictFlow.open({ ...read.value, entries: [], more: 0 })).toBe(false)
    expect(SvnConflictFlow.open(undefined)).toBe(false)
  })

  it('answers a failed read as it came', async () => {
    const { flow } = flowOver([], { svn: {
      conflictSet: async () => ({ ok: false, code: 'locked', detail: 'E155004' }), logOf: async () => ({ ok: true, value: [] }),
      changes: async () => ({ ok: true, value: [] }), hashes: async () => ({ ok: true, value: {} }), baseAbove: async () => ({ ok: true, value: null }),
    } })
    expect(await flow.read(action)).toEqual({ ok: false, code: 'locked', detail: 'E155004' })
    expect(await flow.fix({ ...action, conflictSet: await setOf([text('a.txt')]) }, () => undefined, noJournal))
      .toMatchObject({ kind: 'needs', need: 'svn-failed', reason: 'svn cannot report the conflicts of Q:/work/.worktrees/006: E155004' })
  })

  it('waits at Check again on a working copy its recovery could not unlock with the recovery\'s own words, never svn\'s raw read (UA1-J06-1)', async () => {
    const detail = 'lib/ea/a.txt.r2 is open in another program, so Jamat could not finish its own interrupted SVN step and the working copy W:/wc/lib/ea stays locked. '
      + 'Close that program, then choose the option again or press Check again. Your working files were left as they are.'
    const { flow } = flowOver([text('a.txt')], { resolutions: { recoverLocked: async () => ({ ok: false, code: 'locked', detail }),
      apply: async () => ({ ok: true, value: undefined }) } })
    const waiting = { ...action, conflictSet: { ...await setOf([text('a.txt')]), waited: true as const } }
    expect(await flow.fix(waiting, () => undefined, noJournal)).toMatchObject({ kind: 'needs', need: 'svn-failed', reason: detail })
    expect(await flow.recheck(waiting, () => undefined)).toEqual({ ok: false, code: 'locked', detail })
  })

  it('refreshes a recovered external while a nested external stays locked, without resolving more paths (K809)', async () => {
    const detail = 'EA/EC/limit.txt.mine remains open; EA/EC stays locked'
    const it_ = flowOver([text('EB/pending.txt')], { resolutions: {
      recoverLocked: async () => ({ ok: false, code: 'locked', detail }),
      apply: async () => { throw new Error('Recovery failure must not apply another option') },
    } })
    it_.lockedPaths = ['EA/EC']
    const waiting = { ...action, conflictSet: { ...await setOf([
      text('EA/limit.txt'), text('EA/EC/limit.txt'), text('EA/EC-sibling/limit.txt'), text('EB/pending.txt'),
    ]), waited: true as const } }

    const step = await it_.flow.fix(waiting, () => undefined, noJournal)

    expect(step).toMatchObject({ kind: 'needs', need: 'svn-failed', reason: detail })
    expect(step.action.conflictSet?.entries.map(({ path, state }) => ({ path, state }))).toEqual([
      { path: 'EA/limit.txt', state: 'settled' },
      { path: 'EA/EC/limit.txt', state: 'person' },
      { path: 'EA/EC-sibling/limit.txt', state: 'settled' },
      { path: 'EB/pending.txt', state: 'person' },
    ])
    expect(await it_.flow.recheck(waiting, () => undefined)).toMatchObject({ ok: false, code: 'locked', detail,
      set: { entries: [expect.objectContaining({ path: 'EA/limit.txt', state: 'settled' }),
        expect.objectContaining({ path: 'EA/EC/limit.txt', state: 'person' }),
        expect.objectContaining({ path: 'EA/EC-sibling/limit.txt', state: 'settled' }),
        expect.objectContaining({ path: 'EB/pending.txt', state: 'person' })] } })
  })

  it('settles at Check again what svn no longer marks by the person, and a text file without markers through merged', async () => {
    const set = await setOf([incident, text('src/catalog.ts'), text('src/wallets.ts')])
    const it_ = flowOver([text('src/catalog.ts'), text('src/wallets.ts')])
    it_.markers = ['src/wallets.ts']
    const fixes: string[] = []

    const step = await it_.flow.fix({ ...action, conflictSet: set }, (fix) => fixes.push(`${fix.path} ${fix.option} ${fix.index}/${fix.count}`), noJournal)

    // Read again after the option, so the guards see the status it left.
    expect(it_.asked).toEqual(['Q:/work/.worktrees/006 r420', 'Q:/work/.worktrees/006 r420'])
    expect(it_.applied).toEqual([`src/catalog.ts merged from 0 into ${join('R:/results/a1/saved', 'resolutions', set.entries.find((entry) => entry.path === 'src/catalog.ts')!.occurrenceId!)}`])
    expect(fixes).toEqual(['src/catalog.ts merged 1/1'])
    expect(step.kind).toBe('needs')
    expect(step.action.conflictSet?.entries.map(({ path, state, by, settledWith, journal }) => ({ path, state, by, settledWith, journal }))).toEqual([
      { path: '.aidocs/engines', state: 'settled', by: 'person', settledWith: undefined, journal: undefined },
      { path: 'src/catalog.ts', state: 'settled', by: 'person', settledWith: 'merged', journal: { option: 'merged', done: 1 } },
      { path: 'src/wallets.ts', state: 'person', by: undefined, settledWith: undefined, journal: undefined },
    ])
    // One with markers keeps the wait with the same kind of summary.
    expect(step.kind === 'needs' && step.reason).toBe('3 conflicts: you fixed 2, 1 needs you: src/wallets.ts; settle them, then press Check again')

    it_.markers = []
    it_.facts = []
    const done = await it_.flow.fix(step.action, () => undefined, noJournal)
    expect(done.kind).toBe('settled')
    expect(done.action.conflictSet?.entries.every((entry) => entry.state === 'settled')).toBe(true)
  })

  it('keeps a verified interrupted text choice after cleanup so conflict memory accepts its selected side', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jamat-recovered-choice-'))
    try {
      const fact = { ...text('a.txt'), sidecars: ['a.txt.mine', 'a.txt.r4', 'a.txt.r5'] }
      for (const [path, value] of [['a.txt', 'conflict'], ['a.txt.mine', '20'], ['a.txt.r4', '10'], ['a.txt.r5', '30']])
        await writeFile(join(root, path), value)
      const it_ = flowOver([fact], { savedDirectoryOf: (id) => join(root, 'results', id, 'saved') })
      const next = { ...action, root }
      const remembered = await it_.flow.remember(next)
      if (!remembered.ok) throw new Error(remembered.detail)
      const waiting = { ...next, conflictSet: { ...remembered.value.set, waited: true as const,
        entries: remembered.value.set.entries.map((entry) => ({ ...entry, state: 'person' as const, journal: { option: 'take-incoming' as const, done: 1 } })) } }
      const savedDir = join(root, 'results', next.actionId, 'saved', 'resolutions', waiting.conflictSet.entries[0].occurrenceId!)
      await mkdir(savedDir, { recursive: true })
      await writeFile(join(savedDir, `text-sides-${createHash('sha256').update('a.txt').digest('hex')}.json`),
        JSON.stringify({ path: 'a.txt', mine: 'a.txt.mine', theirs: 'a.txt.r5' }))
      await writeFile(join(savedDir, 'a.txt.mine'), '20')
      await writeFile(join(savedDir, 'a.txt.r5'), '30')
      await writeFile(join(root, 'a.txt'), '30')
      it_.facts = []

      const fixed = await it_.flow.fix(waiting, () => undefined, noJournal)
      expect(fixed.kind).toBe('settled')
      expect(fixed.action.conflictSet?.entries[0]).toMatchObject({ state: 'settled', settledWith: 'take-incoming' })
      expect(await it_.flow.remembered(fixed.action, remembered.value.memory)).toMatchObject({ ok: true, value: { reasons: [], memory: { paths: [] } } })
      await writeFile(join(root, 'a.txt'), '25')
      const manual = await it_.flow.fix(waiting, () => undefined, noJournal)
      expect(manual.kind).toBe('settled')
      expect(manual.action.conflictSet?.entries[0].settledWith).toBeUndefined()
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('25')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('adds a conflict found at Check again to the set, and keeps a failed option open with its journal', async () => {
    const set = await setOf([text('src/catalog.ts')])
    const it_ = flowOver([text('src/catalog.ts'), incident])
    it_.failure = 'E155027: tree conflict'

    const step = await it_.flow.fix({ ...action, conflictSet: set }, () => undefined, noJournal)

    expect(step.kind).toBe('needs')
    expect(step.action.conflictSet?.entries.map(({ path, state, shape, journal }) => ({ path, state, shape, journal }))).toEqual([
      { path: 'src/catalog.ts', state: 'person', shape: 'text-overlap', journal: { option: 'merged', done: 1 } },
      { path: '.aidocs/engines', state: 'person', shape: 'obstructed-dir', journal: undefined },
    ])
    expect(step.kind === 'needs' && step.reason).toMatch(/^2 conflicts need you: src\/catalog.ts, .aidocs\/engines \(tree\)/)
  })

  describe('resolve', () => {
    async function waiting(): Promise<SessionRecordSvnAction> {
      const set = await setOf([incident, text('src/catalog.ts'), text('src/wallets.ts')])
      return { ...action, stage: 'updating', needs: { kind: 'conflict', reason: '3 conflicts need you', at: 5 }, conflictSet: set }
    }
    const journals: string[] = []
    const note = async (path: string, journal: { option: string; done: number }): Promise<void> => { journals.push(`${path} ${journal.option} ${journal.done}`) }

    it('settles the incident with keep-both by the person, saved, with no diverged entry where the names differ', async () => {
      const it_ = flowOver([])
      const resolved = await it_.flow.resolve(await waiting(), { path: '.aidocs/engines', option: 'keep-both', confirm: false, requestedBy: 'cli', by: 'person' }, note)

      expect(it_.applied).toEqual([expect.stringMatching(/^\.aidocs\/engines keep-both from 0 into R:[\\/]results[\\/]a1[\\/]saved[\\/]resolutions[\\/][0-9a-f-]{36}$/)])
      expect(resolved).toMatchObject({ ok: true, value: { state: 'settled', left: 2 } })
      if (!resolved.ok) throw new Error(resolved.detail)
      expect(resolved.value.action.conflictSet?.entries[0]).toMatchObject({ path: '.aidocs/engines', state: 'settled', by: 'person',
        settledWith: 'keep-both', journal: { option: 'keep-both', done: 1 } })
      expect(resolved.value.action.conflictSet?.entries[0]?.saved).toBe(join('R:/results/a1/saved', 'resolutions', resolved.value.action.conflictSet!.entries[0].occurrenceId!, '.aidocs/engines'))
      expect(resolved.value.action.conflictSet?.entries).toHaveLength(3)
      expect(resolved.value.action.needs).toMatchObject({ kind: 'conflict', at: 5,
        reason: '3 conflicts: you fixed 1, 2 need you: src/catalog.ts, src/wallets.ts; settle them, then press Check again' })
      expect(journals.at(-1)).toBe('.aidocs/engines keep-both 1')
    })

    it('adds a differing same-name file that keep-both left as a diverged entry for the person', async () => {
      const it_ = flowOver([])
      it_.diverged = ['.aidocs/engines/t2/brief.md']
      const resolved = await it_.flow.resolve(await waiting(), { path: '.aidocs/engines', option: 'keep-both', confirm: false, requestedBy: 'window', by: 'person' }, note)
      if (!resolved.ok) throw new Error(resolved.detail)
      expect(resolved.value.left).toBe(3)
      expect(resolved.value.action.conflictSet?.entries.at(-1)).toMatchObject({
        path: '.aidocs/engines/t2/brief.md', kind: 'diverged', shape: 'diverged', state: 'person',
        options: ['merged', 'take-incoming', 'keep-mine'], facts: { incomingRevision: 421 },
      })
    })

    it('answers person-only for keep-mine from the CLI and settles it from the window with a confirmation, marking the loss', async () => {
      const it_ = flowOver([])
      expect(await it_.flow.resolve(await waiting(), { path: 'src/catalog.ts', option: 'keep-mine', confirm: false, requestedBy: 'cli', by: 'person' }, note))
        .toMatchObject({ ok: false, code: 'person-only' })
      expect(await it_.flow.resolve(await waiting(), { path: 'src/catalog.ts', option: 'keep-mine', confirm: false, requestedBy: 'window', by: 'person' }, note))
        .toMatchObject({ ok: false, code: 'person-only' })
      expect(it_.applied).toEqual([])
      const confirmed = await it_.flow.resolve(await waiting(), { path: 'src/catalog.ts', option: 'keep-mine', confirm: true, requestedBy: 'window', by: 'person' }, note)
      if (!confirmed.ok) throw new Error(confirmed.detail)
      expect(confirmed.value.action.conflictSet?.entries[1]).toMatchObject({ state: 'settled', settledWith: 'keep-mine', confirmedLoss: true })
    })

    it('answers invalid-spec for a path or an option the set does not hold, and merge-pending while the action runs or waits on anything else', async () => {
      const it_ = flowOver([])
      const current = await waiting()
      expect(await it_.flow.resolve(current, { path: 'src/other.ts', option: 'merged', confirm: false, requestedBy: 'cli', by: 'person' }, note))
        .toMatchObject({ ok: false, code: 'invalid-spec' })
      expect(await it_.flow.resolve(current, { path: 'src/catalog.ts', option: 'keep-both', confirm: false, requestedBy: 'cli', by: 'person' }, note))
        .toMatchObject({ ok: false, code: 'invalid-spec', detail: 'src/catalog.ts admits merged, take-incoming, keep-mine, not keep-both' })
      const fixing = { ...current, stage: 'fixing' as const, needs: undefined }
      expect(await it_.flow.resolve(fixing, { path: 'src/catalog.ts', option: 'merged', confirm: false, requestedBy: 'cli', by: 'person' }, note))
        .toMatchObject({ ok: false, code: 'merge-pending' })
      const checks = { ...current, needs: { kind: 'check-failed' as const, reason: 'lint', at: 1 } }
      expect(await it_.flow.resolve(checks, { path: 'src/catalog.ts', option: 'merged', confirm: false, requestedBy: 'cli', by: 'person' }, note))
        .toMatchObject({ ok: false, code: 'merge-pending' })
      expect(it_.applied).toEqual([])
    })

    it('settles a binary and an unreadable text entry without reading their NUL bytes as conflict markers', async () => {
      const binary = { ...text('img.png'), content: { binary: true, unreadable: false, equal: 'differs' as const } }
      const unreadable = { ...text('utf16.txt'), content: { binary: false, unreadable: true, equal: 'differs' as const } }
      const current = { ...action, stage: 'updating' as const, needs: { kind: 'conflict' as const, reason: '2 conflicts need you', at: 5 },
        conflictSet: await setOf([binary, unreadable]) }
      const it_ = flowOver([])
      it_.markers = ['img.png', 'utf16.txt']
      const first = await it_.flow.resolve(current, { path: 'img.png', option: 'take-incoming', confirm: false, requestedBy: 'window', by: 'person' }, note)
      if (!first.ok) throw new Error(first.detail)
      expect(first.value).toMatchObject({ state: 'settled', left: 1 })
      const second = await it_.flow.resolve(first.value.action, { path: 'utf16.txt', option: 'take-incoming', confirm: false, requestedBy: 'window', by: 'person' }, note)
      if (!second.ok) throw new Error(second.detail)
      expect(second.value).toMatchObject({ state: 'settled', left: 0 })
      // Nothing is left: the reason says so instead of the stale count, and names the press the action shows.
      expect(second.value.action.needs?.reason).toBe('2 conflicts: you fixed 2; all are settled, press Check again to go on')
    })

    it('answers locked for a working copy SVN keeps locked, without promising that the next call goes on', async () => {
      const it_ = flowOver([], { resolutions: { recoverLocked: async () => ({ ok: true, value: undefined }),
        apply: async () => ({ ok: false, code: 'locked', detail: 'SVN is locked at W:/wc by an operation Jamat cannot prove it started.' }) } })
      expect(await it_.flow.resolve(await waiting(), { path: 'src/catalog.ts', option: 'take-incoming', confirm: false, requestedBy: 'window', by: 'person' }, note))
        .toEqual({ ok: false, code: 'locked', detail: 'take-incoming on src/catalog.ts stopped: SVN is locked at W:/wc by an operation Jamat cannot prove it started.' })
    })

    it('keeps the entry open after a failing step with its journal, and the next call resumes at that step', async () => {
      const it_ = flowOver([])
      it_.failure = 'svn: E155010: the node was not found'
      journals.length = 0
      const current = await waiting()
      const failed = await it_.flow.resolve(current, { path: '.aidocs/engines', option: 'keep-both', confirm: false, requestedBy: 'cli', by: 'person' }, note)
      expect(failed).toMatchObject({ ok: false, code: 'svn-failed' })
      expect(!failed.ok && failed.detail).toContain('E155010')
      expect(journals).toEqual(['.aidocs/engines keep-both 1'])

      it_.failure = null
      const journaled = { ...current, conflictSet: { ...current.conflictSet!, entries: current.conflictSet!.entries.map((entry, index) =>
        index === 0 ? { ...entry, journal: { option: 'keep-both' as const, done: 1 } } : entry) } }
      expect(await it_.flow.resolve(journaled, { path: '.aidocs/engines', option: 'keep-both', confirm: false, requestedBy: 'cli', by: 'person' }, note))
        .toMatchObject({ ok: true, value: { state: 'settled' } })
      expect(it_.applied.at(-1)).toBe(it_.applied[0].replace('from 0', 'from 1'))
    })

    it('settles a conflict of a waiting main-copy UPDATE by the person, saved beside the UPDATE, never cleaning the main copy, and names the Update press (UA1-J08-2)', async () => {
      const inputs: SvnConflictApply[] = []
      const it_ = flowOver([])
      const flow = flowOver([], { resolutions: { recoverLocked: async () => ({ ok: true, value: undefined }), apply: async (input: SvnConflictApply) => {
        inputs.push(input)
        await input.onStep({ option: input.option, done: 1 }, [])
        return { ok: true, value: undefined }
      } } }).flow
      const update = { ...await waiting(), kind: 'update-main' as const, root: 'Q:/apps/J08-App' }
      const first = await flow.resolve(update, { path: 'src/catalog.ts', option: 'take-incoming', confirm: false, requestedBy: 'window', by: 'person' }, note)
      if (!first.ok) throw new Error(first.detail)
      expect(inputs[0]).toMatchObject({ root: 'Q:/apps/J08-App', path: 'src/catalog.ts', option: 'take-incoming', mainCopy: true })
      expect(inputs[0].savedDir).toMatch(/^R:[\\/]results[\\/]a1[\\/]saved[\\/]resolutions[\\/]/)
      expect(first.value.action.conflictSet?.entries[1]).toMatchObject({ state: 'settled', by: 'person', settledWith: 'take-incoming' })
      expect(first.value.action.needs?.reason).toBe('3 conflicts: you fixed 1, 2 need you: .aidocs/engines (tree), src/wallets.ts; settle them, then press Update again')
      const kept = await flow.resolve(first.value.action, { path: '.aidocs/engines', option: 'keep-mine', confirm: true, requestedBy: 'window', by: 'person' }, note)
      if (!kept.ok) throw new Error(kept.detail)
      const last = await flow.resolve(kept.value.action, { path: 'src/wallets.ts', option: 'merged', confirm: false, requestedBy: 'window', by: 'person' }, note)
      if (!last.ok) throw new Error(last.detail)
      expect(last.value).toMatchObject({ state: 'settled', left: 0 })
      expect(last.value.action.needs?.reason).toBe('3 conflicts: you fixed 3; all are settled, press Update to go on')
      expect(it_.applied).toEqual([])
    })

    it('refuses an UPDATE that runs, and a Discard, which waits on no conflict of its own', async () => {
      const it_ = flowOver([])
      const running = { ...await waiting(), kind: 'update-main' as const, needs: undefined }
      expect(await it_.flow.resolve(running, { path: 'src/catalog.ts', option: 'merged', confirm: false, requestedBy: 'window', by: 'person' }, note))
        .toMatchObject({ ok: false, code: 'merge-pending' })
      expect(await it_.flow.resolve({ ...await waiting(), kind: 'discard' }, { path: 'src/catalog.ts', option: 'merged', confirm: false, requestedBy: 'window', by: 'person' }, note))
        .toMatchObject({ ok: false, code: 'merge-pending' })
      expect(it_.applied).toEqual([])
    })
  })

  describe('guards', () => {
    const deleted = (path: string): SvnItemRow => ({ path, item: 'deleted', conflict: false, base: 422 })
    const acceptedWorking = ['.aidocs/engines', '.aidocs/engines/t2', '.aidocs/engines/t2/brief.md', '.aidocs/engines/t2/report.md',
      '.aidocs/engines/t2/trail.md'].map(deleted)

    it('reopens the incident at Check again after a --accept working outside Jamat, as drops-incoming with keep-both and keep-mine', async () => {
      const set = await setOf([incident, text('src/catalog.ts')])
      const it_ = flowOver([text('src/catalog.ts')])
      it_.rows = acceptedWorking
      it_.markers = ['src/catalog.ts']

      const step = await it_.flow.fix({ ...action, conflictSet: set }, () => undefined, noJournal)

      expect(step.kind).toBe('needs')
      const reopened = step.action.conflictSet?.entries[0]
      expect(reopened).toMatchObject({ path: '.aidocs/engines', shape: 'drops-incoming', state: 'person', options: ['keep-both', 'keep-mine'],
        facts: { dropped: 3, action: 'added' } })
      expect(reopened?.by).toBeUndefined()
      expect(SvnConflictWords.infoOf(reopened!)).toMatchObject({ description: 'The commit would delete 3 files r421 added.',
        options: [{ id: 'keep-both' }, { id: 'keep-mine', loses: 'incoming' }] })
      expect(step.kind === 'needs' && step.reason)
        .toMatch(/^the commit would drop what r421 brought in below .aidocs\/engines; 2 conflicts need you: .aidocs\/engines \(tree\), src\/catalog.ts/)

      // Keep mine of the dropped files, confirmed in the window, passes the guard: the commit deletes them.
      const kept = await it_.flow.resolve({ ...step.action, stage: 'fixing', needs: { kind: 'conflict', reason: 'x', at: 9 } },
        { path: '.aidocs/engines', option: 'keep-mine', confirm: true, requestedBy: 'window', by: 'person' }, async () => undefined)
      expect(kept).toMatchObject({ ok: true, value: { state: 'settled', left: 1 } })
      expect(kept.ok && kept.value.action.conflictSet?.entries[0]).toMatchObject({ state: 'settled', confirmedLoss: true })
    })

    it('reopens a settled text file that still holds markers, with its journal gone', async () => {
      const set = await setOf([text('src/catalog.ts')])
      const settled = { ...set, entries: [{ ...set.entries[0], state: 'settled' as const, by: 'person' as const, settledWith: 'merged' as const,
        journal: { option: 'merged' as const, done: 3 } }] }
      const it_ = flowOver([])
      it_.markers = ['src/catalog.ts']
      const step = await it_.flow.fix({ ...action, conflictSet: settled }, () => undefined, noJournal)
      expect(step.kind).toBe('needs')
      expect(step.action.conflictSet?.entries[0]).toEqual({ ...set.entries[0], state: 'person' })
      expect(step.kind === 'needs' && step.reason).toMatch(/^src\/catalog.ts still holds conflict markers; /)
    })

    it('names a leftover marker and a leftover svn conflict file at one Check again, and lists only the open path (UA1-J05-4)', async () => {
      const set = await setOf([text('src/marker.txt'), text('src/take.txt')])
      const settled = { ...set, entries: set.entries.map((entry) => ({ ...entry, state: 'settled' as const, by: 'person' as const, settledWith: 'merged' as const })) }
      const it_ = flowOver([])
      it_.markers = ['src/marker.txt']
      it_.rows = [{ path: 'src/take.txt.r3', item: 'unversioned', conflict: false, base: 422 }]
      const step = await it_.flow.fix({ ...action, conflictSet: settled }, () => undefined, noJournal)
      expect(step.kind).toBe('needs')
      expect(step.kind === 'needs' && step.reason).toBe('src/marker.txt still holds conflict markers; src/take.txt.r3 is a leftover svn conflict file, '
        + 'delete it; 2 conflicts: you fixed 1, 1 needs you: src/marker.txt; settle them, then press Check again')
    })

    it('waits on a leftover svn conflict file of a Finish though every path is settled, and lets an UPDATE go on', async () => {
      const set = await setOf([text('src/take.txt')])
      const settled = { ...set, entries: [{ ...set.entries[0], state: 'settled' as const, by: 'person' as const, settledWith: 'merged' as const }] }
      const it_ = flowOver([])
      it_.rows = [{ path: 'src/take.txt.r3', item: 'unversioned', conflict: false, base: 422 }, { path: 'src/old.txt.mine', item: 'unversioned', conflict: false, base: 422 }]
      const step = await it_.flow.fix({ ...action, conflictSet: settled }, () => undefined, noJournal)
      expect(step.kind).toBe('needs')
      expect(step.kind === 'needs' && step.reason)
        .toBe('src/old.txt.mine, src/take.txt.r3 are leftover svn conflict files, delete them; 1 conflict: you fixed 1; press Check again')
      expect((await it_.flow.fix({ ...action, kind: 'update-main', conflictSet: settled }, () => undefined, noJournal)).kind).toBe('settled')
    })
  })

  describe('a text and a property conflict on one file (UA1-J05-1)', () => {
    const both = (): SvnConflictFact[] => [
      { ...text('src/both.txt'), sidecars: ['src/both.txt.mine', 'src/both.txt.r2', 'src/both.txt.r3'] },
      { path: 'src/both.txt', kind: 'property', takesArgument: true, tree: null, sidecars: ['src/both.txt.prej'], content: null,
        properties: [{ name: 'jamat:test', older: 'base', mine: 'both-w1', theirs: 'both-t' }] },
    ]
    const marked: SvnItemRow[] = [{ path: 'src/both.txt', item: 'conflicted', conflict: true, base: 422 }]
    async function waiting(): Promise<SessionRecordSvnAction> {
      return { ...action, stage: 'updating', needs: { kind: 'conflict', reason: '2 conflicts need you', at: 5 }, conflictSet: await setOf(both()) }
    }
    function harness(): FlowHarness & { held: string[] } {
      const held: string[] = []
      const it_ = flowOver(both(), { resolutions: { recoverLocked: async () => ({ ok: true, value: undefined }), apply: async (input: SvnConflictApply) => {
        held.push(`${input.kind} ${input.option} held=${input.held === true}`)
        await input.onStep({ option: input.option, done: 1 }, [])
        return { ok: true, value: undefined }
      } } })
      it_.rows = marked
      return Object.assign(it_, { held })
    }

    it('lists both as open items, each with its own options', async () => {
      const set = await setOf(both())
      expect(set.entries.map((entry) => [entry.path, entry.kind, entry.state, entry.options])).toEqual([
        ['src/both.txt', 'text', 'person', ['merged', 'take-incoming', 'keep-mine']],
        ['src/both.txt', 'property', 'person', ['merged', 'take-incoming', 'keep-mine']],
      ])
      expect(new Set(set.entries.map((entry) => entry.occurrenceId)).size).toBe(2)
    })

    it('settles the text only, holding the property open and the set unsettled; the property then resolves both', async () => {
      const it_ = harness()
      const journaled: string[] = []
      const note = async (path: string, journal: { option: string; done: number }, kind?: string): Promise<void> => { journaled.push(`${path} ${kind} ${journal.option}`) }
      expect(await it_.flow.resolve(await waiting(), { path: 'src/both.txt', option: 'merged', confirm: false, requestedBy: 'window', by: 'person' }, note))
        .toMatchObject({ ok: false, code: 'invalid-spec', detail: expect.stringContaining('text and a property conflict') })
      const first = await it_.flow.resolve(await waiting(), { path: 'src/both.txt', kind: 'text', option: 'merged', confirm: false, requestedBy: 'window', by: 'person' }, note)
      if (!first.ok) throw new Error(first.detail)
      expect(it_.held).toEqual(['text merged held=true'])
      expect(journaled).toEqual(['src/both.txt text merged'])
      expect(first.value.left).toBe(1)
      expect(first.value.action.conflictSet?.entries.map((entry) => [entry.kind, entry.state, entry.settledWith, entry.journal?.option]))
        .toEqual([['text', 'settled', 'merged', 'merged'], ['property', 'person', undefined, undefined]])
      expect(SvnConflictFlow.unsettled(first.value.action.conflictSet)).toBe(true)

      // Check again while svn still marks the path for the open property: the text stays settled.
      const again = await it_.flow.fix({ ...first.value.action, needs: undefined }, () => undefined, noJournal)
      expect(again.kind).toBe('needs')
      expect(again.action.conflictSet?.entries.map((entry) => [entry.kind, entry.state])).toEqual([['text', 'settled'], ['property', 'person']])

      // The property's resolve clears svn's mark of both kinds.
      it_.rows = []
      it_.facts = []
      const second = await it_.flow.resolve(first.value.action, { path: 'src/both.txt', option: 'take-incoming', confirm: false, requestedBy: 'window', by: 'person' }, note)
      if (!second.ok) throw new Error(second.detail)
      expect(it_.held).toEqual(['text merged held=true', 'property take-incoming held=false'])
      expect(second.value.left).toBe(0)
    })

    it('names a binary refusal as a binary file conflict and a refused option without svn words (UA1-J05-7)', async () => {
      const binary: SvnConflictFact = { ...text('assets/pic2.bin'), content: { binary: true, unreadable: false, equal: 'differs' } }
      const it_ = flowOver([binary], { resolutions: { recoverLocked: async () => ({ ok: true, value: undefined }),
        apply: async () => ({ ok: false, code: 'refused', detail: 'src/multi.txt still holds conflict markers; merge it, then settle it again' }) } })
      const set = await setOf([binary, text('src/multi.txt')])
      const current = { ...action, stage: 'updating' as const, needs: { kind: 'conflict' as const, reason: '2 conflicts need you', at: 5 }, conflictSet: set }
      expect(await it_.flow.resolve(current, { path: 'assets/pic2.bin', option: 'take-incoming', confirm: false, requestedBy: 'cli', by: 'agent' }, noJournal))
        .toEqual({ ok: false, code: 'person-only', detail: 'take-incoming on assets/pic2.bin requires the person to inspect and resolve this binary file conflict' })
      expect(await it_.flow.resolve(current, { path: 'src/multi.txt', option: 'merged', confirm: false, requestedBy: 'window', by: 'person' }, noJournal))
        .toEqual({ ok: false, code: 'invalid-spec', detail: 'src/multi.txt was not settled: src/multi.txt still holds conflict markers; merge it, then settle it again' })
    })

    it('in the other order holds the text open after the property is settled', async () => {
      const it_ = harness()
      const first = await it_.flow.resolve(await waiting(), { path: 'src/both.txt', kind: 'property', option: 'take-incoming', confirm: false, requestedBy: 'window', by: 'person' }, noJournal)
      if (!first.ok) throw new Error(first.detail)
      expect(it_.held).toEqual(['property take-incoming held=true'])
      expect(first.value.action.conflictSet?.entries.map((entry) => [entry.kind, entry.state])).toEqual([['text', 'person'], ['property', 'settled']])
      expect(first.value.action.needs?.reason).toContain('src/both.txt; settle them')
    })
  })

  it('keeps a diverged file open until an option settles it, though svn never marks it', async () => {
    const set = await setOf([text('src/catalog.ts')])
    const diverged = { ...set.entries[0], path: '.aidocs/engines/t2/brief.md', kind: 'diverged' as const, shape: 'diverged' as const }
    const it_ = flowOver([])
    const step = await it_.flow.fix({ ...action, conflictSet: { ...set, entries: [set.entries[0], diverged] } }, () => undefined, noJournal)
    expect(step.kind).toBe('needs')
    expect(step.action.conflictSet?.entries.map((entry) => entry.state)).toEqual(['settled', 'person'])
  })
})
