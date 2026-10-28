import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { SvnConflictFlow } from '../../lib-orchestrator/worktrees/worktreeConflicts.js'
import { SvnConflictGuard } from '../../lib-orchestrator/worktrees/worktreeConflicts.js'
import { SvnResolverLauncher } from '../../lib-orchestrator/worktrees/worktreeConflicts.js'
import { SvnConflictWords } from '../../lib-orchestrator/worktrees/worktreeConflicts.js'
import { CommandInvoker } from '../../lib-orchestrator/shared/commandInvoker.js'
import type { SvnConflictApply, SvnConflictJournal, SvnConflictKind, SvnConflictOption, SvnConflictPlan, SvnConflictShape } from '../../lib-orchestrator/svn/svn.types.js'
import { type SvnConflictedRow, SvnConflictFacts, type SvnInfoConflicts } from '../../lib-orchestrator/svn/svnConflictFacts.js'
import { SvnConflictResolutions } from '../../lib-orchestrator/svn/svnConflictResolutions.js'
import { SvnConflictShapes } from '../../lib-orchestrator/svn/svnConflictShapes.js'
import type { SvnInvoker } from '../../lib-orchestrator/svn/svnInvoker.js'
import { SvnWorktreeEvidence } from '../../lib-orchestrator/svn/svnWorktreeEvidence.js'
import { SvnWorktreeManager } from '../../lib-orchestrator/svn/svnWorktreeManager.js'

/** One checkout of a spike repository, with the writes a case makes on it. */
class SpikeCheckout {
  readonly path: string
  private readonly svn: SvnInvoker

  constructor(path: string, svn: SvnInvoker) {
    this.path = path
    this.svn = svn
  }

  async write(relative: string, content: string | Buffer): Promise<void> {
    const file = join(this.path, ...relative.split('/'))
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content)
  }

  async remove(relative: string): Promise<void> {
    await rm(join(this.path, ...relative.split('/')), { recursive: true, force: true })
  }

  async read(relative: string): Promise<string | null> {
    const file = join(this.path, ...relative.split('/'))
    return existsSync(file) ? readFile(file, 'utf8') : null
  }

  /** stdout of a command that must succeed; commits carry a fixed author. */
  async run(args: string[], cwd = this.path): Promise<string> {
    const outcome = await this.attempt(args, cwd)
    if (outcome.code !== 0) throw new Error(`svn ${args.join(' ')}: ${outcome.stderr || outcome.code}`)
    return outcome.stdout
  }

  async attempt(args: string[], cwd = this.path): Promise<{ code: number; stdout: string; stderr: string }> {
    const author = args[0] === 'commit' ? ['--username', 'fixture'] : []
    const result = await this.svn.run(cwd, [args[0] ?? '', '--non-interactive', ...author, ...args.slice(1)])
    return { code: result.failure === null ? result.code ?? 1 : 1, stdout: result.stdout, stderr: result.stderr.trim() }
  }
}

/** A stop the smoke throws from `onStep`, as a client that dies between two steps of an option. */
class SpikeStopped extends Error {}

/** One conflict shape: what r1 holds, what the landed commit changes, and what the session did. */
interface SpikeCase {
  /** The fixture suffix and the printed name. */
  name: string
  /** The conflicted path, '/'-separated; '.' for the root. */
  victim: string
  /** What the classifier makes of it; null where svn leaves no conflict. */
  expected: { shape: SvnConflictShape; rule: SvnConflictOption | null } | null
  base(side: SpikeCheckout): Promise<void>
  incoming(side: SpikeCheckout): Promise<void>
  mine(side: SpikeCheckout): Promise<void>
}

interface SpikeOutcome {
  spikeCase: SpikeCase
  checkout: SpikeCheckout
  exit: number
  /** The update's own stderr, which names a failure. */
  stderr: string
  status: string
  info: string
  /** `svn status -v` letters of the nodes below the victim. */
  below: { path: string; item: string }[]
}

/** What `SvnConflictFacts` reads of one case: the victim's conflicted status row and its info entry. */
export interface SpikeFacts {
  row: SvnConflictedRow | null
  entry: SvnInfoConflicts | null
}

export interface ConflictSpikeCapture {
  name: string
  text: string
}

export interface ConflictSpikeDeps {
  /** An empty directory the spike may fill. */
  root: string
  svn: SvnInvoker
  check(description: string, condition: boolean): void
  /** Disposable paths become placeholders; nothing that names this PC may remain. */
  anonymized(text: string, placeholders: readonly [string, string][]): string
}

/**
 * The conflict shapes of an SVN Finish on this machine's svn 1.14: for each shape two checkouts of one
 * svnadmin repository, one side committed, the other updated with `--accept postpone`, and the facts
 * svn writes for it. Then the candidate sequences of the options, each on a copy of that working copy.
 * Checks assert only the facts the conflict plan relies on; everything else is printed for the docs
 * page `svn-conflict-resolution.md`.
 */
export class ConflictShapesSpike {
  static readonly incidentEolPaths = Array.from({ length: 22 }, (_, index) => `conflict-${index}.txt`)
  /**
   * CF16: the other commit moves the file and edits its first line, the session edits its third. svn
   * writes the facts of `edit-vs-delete`; only the log of the other commit names the new place.
   */
  static readonly incomingMoveConst: SpikeCase = {
    name: 'edit-vs-move',
    victim: 'src/legacy.txt',
    expected: { shape: 'edit-vs-delete', rule: null },
    base: (side) => side.write('src/legacy.txt', 'one\ntwo\nthree\n'),
    incoming: async (side) => {
      await side.run(['move', '--', 'src/legacy.txt', 'src/renamed.txt'])
      await side.write('src/renamed.txt', 'one theirs\ntwo\nthree\n')
    },
    mine: (side) => side.write('src/legacy.txt', 'one\ntwo\nthree mine\n'),
  }

  /** A 1x1 PNG in three colours: r1, the session's and the other commit's. */
  private static readonly pngConst = {
    red: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
    blue: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC',
    green: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg+M8AAAICAQB7CYF4AAAAAElFTkSuQmCC',
  }

  /** r1 makes `/Lib`, r2 is the base both checkouts start from, r3 the incoming commit. */
  private static readonly baseRevisionConst = 2
  private readonly deps: ConflictSpikeDeps

  constructor(deps: ConflictSpikeDeps) {
    this.deps = deps
  }

  static readonly casesConst: readonly SpikeCase[] = [
    {
      name: 'obstructed-dir',
      victim: '.aidocs/engines',
      expected: { shape: 'obstructed-dir', rule: 'keep-both' },
      base: (side) => side.write('.aidocs/README.md', 'readme\n'),
      incoming: async (side) => {
        for (const name of ['brief', 'report', 'trail']) await side.write(`.aidocs/engines/t2/${name}.md`, `${name} t2\n`)
      },
      mine: async (side) => {
        await side.write('.aidocs/engines/t1/brief.md', 'brief t1\n')
        await side.write('.aidocs/engines/t1/report.md', 'report t1\n')
      },
    },
    {
      name: 'obstructed-dir-same-name',
      victim: '.aidocs/engines',
      expected: { shape: 'obstructed-dir', rule: 'keep-both' },
      base: (side) => side.write('.aidocs/README.md', 'readme\n'),
      incoming: async (side) => {
        for (const name of ['brief', 'report', 'trail']) await side.write(`.aidocs/engines/t2/${name}.md`, `${name} t2\n`)
      },
      mine: async (side) => {
        await side.write('.aidocs/engines/t2/brief.md', 'brief of the session\n')
        await side.write('.aidocs/engines/t2/notes.md', 'notes of the session\n')
      },
    },
    {
      name: 'obstructed-file-equal',
      victim: 'src/new.txt',
      expected: { shape: 'obstructed-file', rule: 'take-incoming' },
      base: (side) => side.write('src/a.txt', 'a\n'),
      incoming: (side) => side.write('src/new.txt', 'same\n'),
      mine: (side) => side.write('src/new.txt', 'same\n'),
    },
    {
      name: 'obstructed-file-differing',
      victim: 'src/new.txt',
      expected: { shape: 'obstructed-file', rule: null },
      base: (side) => side.write('src/a.txt', 'a\n'),
      incoming: (side) => side.write('src/new.txt', 'theirs\n'),
      mine: (side) => side.write('src/new.txt', 'mine\n'),
    },
    {
      name: 'added-both',
      victim: 'src/new.txt',
      expected: { shape: 'added-both', rule: null },
      base: (side) => side.write('src/a.txt', 'a\n'),
      incoming: (side) => side.write('src/new.txt', 'theirs\n'),
      mine: async (side) => {
        await side.write('src/new.txt', 'mine\n')
        await side.run(['add', '--', 'src/new.txt'])
      },
    },
    {
      name: 'added-both-equal',
      victim: 'src/new.txt',
      // Equal bytes, but svn info gives a local add no BASE checksum, so nothing proves them equal.
      expected: { shape: 'added-both', rule: null },
      base: (side) => side.write('src/a.txt', 'a\n'),
      incoming: (side) => side.write('src/new.txt', 'same\n'),
      mine: async (side) => {
        await side.write('src/new.txt', 'same\n')
        await side.run(['add', '--', 'src/new.txt'])
      },
    },
    {
      name: 'added-both-history',
      victim: 'src/new.txt',
      expected: { shape: 'added-both', rule: null },
      base: (side) => side.write('src/a.txt', 'a\n'),
      incoming: (side) => side.write('src/new.txt', 'theirs\n'),
      mine: (side) => side.run(['copy', '--', 'src/a.txt', 'src/new.txt']).then(() => undefined),
    },
    {
      name: 'kind-mismatch',
      victim: 'docs',
      expected: { shape: 'kind-mismatch', rule: null },
      base: (side) => side.write('a.txt', 'a\n'),
      incoming: (side) => side.write('docs/index.md', 'index\n'),
      mine: (side) => side.write('docs', 'a file named docs\n'),
    },
    {
      name: 'edit-vs-delete',
      victim: 'src/legacy.txt',
      expected: { shape: 'edit-vs-delete', rule: null },
      base: (side) => side.write('src/legacy.txt', 'legacy\n'),
      incoming: (side) => side.run(['delete', '--', 'src/legacy.txt']).then(() => undefined),
      mine: (side) => side.write('src/legacy.txt', 'legacy mine\n'),
    },
    {
      name: 'edit-vs-replace',
      victim: 'src/legacy.txt',
      expected: { shape: 'edit-vs-replace', rule: null },
      base: (side) => side.write('src/legacy.txt', 'legacy\n'),
      incoming: async (side) => {
        await side.run(['delete', '--', 'src/legacy.txt'])
        await side.write('src/legacy.txt', 'replaced\n')
        await side.run(['add', '--', 'src/legacy.txt'])
      },
      mine: (side) => side.write('src/legacy.txt', 'legacy mine\n'),
    },
    {
      name: 'delete-vs-edit',
      victim: 'src/legacy.txt',
      expected: { shape: 'delete-vs-edit', rule: null },
      base: (side) => side.write('src/legacy.txt', 'legacy\n'),
      incoming: (side) => side.write('src/legacy.txt', 'legacy theirs\n'),
      mine: (side) => side.run(['delete', '--', 'src/legacy.txt']).then(() => undefined),
    },
    {
      name: 'moved-vs-edit',
      victim: 'src/legacy.txt',
      expected: { shape: 'delete-vs-edit', rule: null },
      base: (side) => side.write('src/legacy.txt', 'one\ntwo\nthree\n'),
      incoming: (side) => side.write('src/legacy.txt', 'one\ntwo theirs\nthree\n'),
      mine: (side) => side.run(['move', '--', 'src/legacy.txt', 'src/moved.txt']).then(() => undefined),
    },
    {
      name: 'delete-vs-delete',
      victim: 'src/legacy.txt',
      expected: { shape: 'delete-vs-delete', rule: 'merged' },
      base: (side) => side.write('src/legacy.txt', 'legacy\n'),
      incoming: (side) => side.run(['delete', '--', 'src/legacy.txt']).then(() => undefined),
      mine: (side) => side.run(['delete', '--', 'src/legacy.txt']).then(() => undefined),
    },
    {
      name: 'missing-vs-delete',
      victim: 'src/legacy.txt',
      expected: null,
      base: (side) => side.write('src/legacy.txt', 'legacy\n'),
      incoming: (side) => side.run(['delete', '--', 'src/legacy.txt']).then(() => undefined),
      mine: (side) => side.remove('src/legacy.txt'),
    },
    {
      name: 'text-overlap',
      victim: 'src/catalog.ts',
      expected: { shape: 'text-overlap', rule: null },
      base: (side) => side.write('src/catalog.ts', 'one\ntwo\nthree\nfour\n'),
      incoming: (side) => side.write('src/catalog.ts', 'one\ntwo\nthree theirs\nfour\n'),
      mine: (side) => side.write('src/catalog.ts', 'one\ntwo\nthree mine\nfour\n'),
    },
    {
      name: 'text-eol',
      victim: 'src/catalog.ts',
      expected: { shape: 'text-same', rule: 'take-incoming' },
      base: (side) => side.write('src/catalog.ts', 'one\ntwo\nthree\nfour\n'),
      incoming: (side) => side.write('src/catalog.ts', 'one\ntwo\nthree both\nfour\n'),
      mine: (side) => side.write('src/catalog.ts', 'one\r\ntwo\r\nthree both\r\nfour\r\n'),
    },
    {
      name: 'binary-equal',
      victim: 'assets/logo.png',
      expected: null,
      base: (side) => side.write('assets/logo.png', Buffer.from(ConflictShapesSpike.pngConst.red, 'base64')),
      incoming: (side) => side.write('assets/logo.png', Buffer.from(ConflictShapesSpike.pngConst.blue, 'base64')),
      mine: (side) => side.write('assets/logo.png', Buffer.from(ConflictShapesSpike.pngConst.blue, 'base64')),
    },
    {
      name: 'binary-differing',
      victim: 'assets/logo.png',
      expected: { shape: 'binary', rule: null },
      base: (side) => side.write('assets/logo.png', Buffer.from(ConflictShapesSpike.pngConst.red, 'base64')),
      incoming: (side) => side.write('assets/logo.png', Buffer.from(ConflictShapesSpike.pngConst.green, 'base64')),
      mine: (side) => side.write('assets/logo.png', Buffer.from(ConflictShapesSpike.pngConst.blue, 'base64')),
    },
    {
      name: 'text-utf16',
      victim: 'docs/notes.txt',
      expected: { shape: 'text-unreadable', rule: null },
      base: (side) => side.write('docs/notes.txt', ConflictShapesSpike.utf16('one\r\ntwo\r\nthree\r\n')),
      incoming: (side) => side.write('docs/notes.txt', ConflictShapesSpike.utf16('one\r\ntwo theirs\r\nthree\r\n')),
      mine: (side) => side.write('docs/notes.txt', ConflictShapesSpike.utf16('one\r\ntwo mine\r\nthree\r\n')),
    },
    {
      name: 'mergeinfo',
      victim: '.',
      expected: null,
      base: (side) => side.write('a.txt', 'a\n'),
      incoming: (side) => side.run(['propset', 'svn:mergeinfo', '/branches/theirs:2', '--', '.']).then(() => undefined),
      mine: (side) => side.run(['propset', 'svn:mergeinfo', '/branches/mine:2', '--', '.']).then(() => undefined),
    },
    {
      name: 'ignore',
      victim: '.',
      expected: { shape: 'line-list-property', rule: 'union' },
      base: async (side) => {
        await side.write('a.txt', 'a\n')
        await side.run(['propset', 'svn:ignore', 'node_modules\n', '--', '.'])
      },
      incoming: (side) => side.run(['propset', 'svn:ignore', 'node_modules\ncoverage\n', '--', '.']).then(() => undefined),
      mine: (side) => side.run(['propset', 'svn:ignore', 'node_modules\ndist\n', '--', '.']).then(() => undefined),
    },
    {
      name: 'property-equal',
      victim: 'a.txt',
      expected: null,
      base: (side) => side.write('a.txt', 'a\n'),
      incoming: (side) => side.run(['propset', 'jamat:owner', 'testbed', '--', 'a.txt']).then(() => undefined),
      mine: (side) => side.run(['propset', 'jamat:owner', 'testbed', '--', 'a.txt']).then(() => undefined),
    },
    {
      name: 'property-differing',
      victim: 'a.txt',
      expected: { shape: 'property-value', rule: null },
      base: (side) => side.write('a.txt', 'a\n'),
      incoming: (side) => side.run(['propset', 'jamat:owner', 'theirs', '--', 'a.txt']).then(() => undefined),
      mine: (side) => side.run(['propset', 'jamat:owner', 'mine', '--', 'a.txt']).then(() => undefined),
    },
    {
      name: 'externals',
      victim: '.',
      expected: { shape: 'externals', rule: null },
      base: async (side) => {
        await side.write('a.txt', 'a\n')
        await side.run(['propset', 'svn:externals', '^/Lib ext', '--', '.'])
      },
      incoming: (side) => side.run(['propset', 'svn:externals', '^/Lib ext-theirs', '--', '.']).then(() => undefined),
      mine: (side) => side.run(['propset', 'svn:externals', '^/Lib ext-mine', '--', '.']).then(() => undefined),
    },
    {
      name: 'non-ascii',
      victim: 'složka/přehled.md',
      expected: { shape: 'name-unsafe', rule: null },
      base: (side) => side.write('složka/přehled.md', 'one\ntwo\nthree\n'),
      incoming: (side) => side.write('složka/přehled.md', 'one\ntwo theirs\nthree\n'),
      mine: (side) => side.write('složka/přehled.md', 'one\ntwo mine\nthree\n'),
    },
  ]

  /** Every shape, the printed block, the option trials, and the fixtures to write or compare. */
  async run(): Promise<ConflictSpikeCapture[]> {
    console.log('  Conflict shapes (svn 1.14, update --accept postpone):')
    const captures: ConflictSpikeCapture[] = []
    const outcomes = new Map<string, SpikeOutcome>()
    const manager = new SvnWorktreeManager(this.deps.svn)
    const misread: string[] = []
    for (const spikeCase of ConflictShapesSpike.casesConst) {
      const outcome = await this.spike(spikeCase)
      outcomes.set(spikeCase.name, outcome)
      const set = await manager.conflictSet(outcome.checkout.path, ConflictShapesSpike.baseRevisionConst)
      if (!set.ok) throw new Error(`The conflict set of ${spikeCase.name}: ${set.detail}`)
      const fact = set.value.facts.find((candidate) => candidate.path === spikeCase.victim) ?? null
      const plan = fact === null ? null : SvnConflictShapes.planOf(fact)
      const read = plan === null ? 'none' : `${plan.shape}/${plan.rule ?? 'none'}`
      const expected = spikeCase.expected === null ? 'none' : `${spikeCase.expected.shape}/${spikeCase.expected.rule ?? 'none'}`
      if (read !== expected || set.value.facts.length !== (fact === null ? 0 : 1)) misread.push(`${spikeCase.name} read ${read} of ${set.value.facts.length} facts, expected ${expected}`)
      if (spikeCase.name === 'obstructed-dir-same-name' && JSON.stringify(fact?.content?.files) !== JSON.stringify({ local: 2, incoming: 3, same: 0, differing: 1 }))
        misread.push(`${spikeCase.name} read the files ${JSON.stringify(fact?.content?.files)}`)
      console.log(`    ${spikeCase.name}: ${ConflictShapesSpike.lineOf(outcome, plan)}`)
      const placeholders: [string, string][] = [[outcome.checkout.path, '{ROOT}'], [pathToFileURL(join(dirname(outcome.checkout.path), 'repo')).href, '{REPO}']]
      captures.push(
        { name: `status-${spikeCase.name}.xml`, text: this.deps.anonymized(outcome.status, placeholders) },
        { name: `info-${spikeCase.name}.xml`, text: this.deps.anonymized(outcome.info, placeholders) },
      )
    }
    this.deps.check(`spike: SvnWorktreeManager.conflictSet reads one fact per conflicted shape and SvnConflictShapes classifies each as expected${misread.length === 0 ? '' : ` (${misread.join('; ')})`}`,
      misread.length === 0)
    await this.trials(outcomes)
    await this.options(outcomes)
    await this.moves(outcomes)
    await this.rules(outcomes)
    return captures
  }

  /**
   * UA1-J05-6, CF15 and CF16: keep-both of a move on real svn, from the set read through the words
   * the person sees to the executor. A local move against an incoming edit carries the edit to the
   * move target (`--accept mine-conflict`); a local edit against an incoming move carries the edit to
   * the new place the other commit's log names (`--accept recommended`); a plain incoming delete names
   * no place and offers no keep-both, and a keep-both sent anyway changes nothing.
   */
  async moves(outcomes: ReadonlyMap<string, SpikeOutcome> = new Map()): Promise<void> {
    const { check } = this.deps
    const cases = [...ConflictShapesSpike.casesConst.filter((spikeCase) => spikeCase.name === 'moved-vs-edit' || spikeCase.name === 'edit-vs-delete'),
      ConflictShapesSpike.incomingMoveConst]
    const spiked = new Map(outcomes)
    for (const spikeCase of cases) if (!spiked.has(spikeCase.name)) spiked.set(spikeCase.name, await this.spike(spikeCase))
    const manager = new SvnWorktreeManager(this.deps.svn)
    const entryOf = async (name: string) => {
      const outcome = spiked.get(name) ?? ConflictShapesSpike.missing(name)
      const read = await manager.conflictSet(outcome.checkout.path, ConflictShapesSpike.baseRevisionConst)
      if (!read.ok) throw new Error(`The conflict set of ${name}: ${read.detail}`)
      const entry = SvnConflictFlow.setOf(read.value, ConflictShapesSpike.baseRevisionConst, 0, false).entries.find((candidate) => candidate.path === 'src/legacy.txt')
      if (entry === undefined) throw new Error(`No entry of ${name}`)
      return { outcome, entry, info: SvnConflictWords.infoOf(entry) }
    }

    const away = await entryOf('moved-vs-edit')
    const carried = await this.applied(away.outcome, 'move-away', 'src/legacy.txt', 'tree', 'keep-both', undefined, undefined, undefined, 'away')
    console.log(`  info: CF15 reads "${away.info.description}", options ${away.info.options.map((option) => option.label).join(' / ')}`)
    check('moves: CF15 a local move against an incoming edit names the move target, and keep-both applies the edit there with no conflict left',
      away.entry.facts.movedTo === 'src/moved.txt' && JSON.stringify(away.entry.options) === JSON.stringify(['keep-both', 'keep-mine'])
      && away.info.options[0]?.label === 'Apply to src/moved.txt'
      && carried.ok && await carried.checkout.read('src/moved.txt') === 'one\ntwo theirs\nthree\n'
      && !(await ConflictShapesSpike.rowsOf(carried.checkout)).some((row) => row.conflict))

    const incoming = await entryOf('edit-vs-move')
    const moved = await this.applied(incoming.outcome, 'move-incoming', 'src/legacy.txt', 'tree', 'keep-both', undefined, undefined, undefined, 'incoming')
    console.log(`  info: CF16 reads "${incoming.info.description}", options ${incoming.info.options.map((option) => option.label).join(' / ')}`)
    check('moves: CF16 a local edit against an incoming move names the new place, and keep-both applies the edit there and drops the old place, saved first',
      incoming.entry.facts.movedTo === 'src/renamed.txt' && incoming.entry.options[0] === 'keep-both'
      && incoming.info.options[0]?.label === 'Move my changes to src/renamed.txt'
      && moved.ok && await moved.checkout.read('src/renamed.txt') === 'one theirs\ntwo\nthree mine\n'
      && !await ConflictShapesSpike.onDisk(moved.checkout, 'src/legacy.txt')
      && await readFile(join(moved.savedDir, 'src', 'legacy.txt'), 'utf8') === 'one\ntwo\nthree mine\n'
      && !(await ConflictShapesSpike.rowsOf(moved.checkout)).some((row) => row.conflict))

    const deleted = await entryOf('edit-vs-delete')
    const refused = await this.applied(deleted.outcome, 'move-none', 'src/legacy.txt', 'tree', 'keep-both', undefined, undefined, undefined, 'incoming')
    check('moves: a plain incoming delete names no place and offers no keep-both; a keep-both sent anyway is refused and leaves the conflict and the edit',
      deleted.entry.facts.movedTo === undefined && !deleted.entry.options.includes('keep-both')
      && !refused.ok && refused.detail.startsWith('svn found no single place')
      && await refused.checkout.read('src/legacy.txt') === 'legacy mine\n'
      && (await ConflictShapesSpike.rowsOf(refused.checkout)).some((row) => row.path === 'src/legacy.txt' && row.conflict))
  }

  /**
   * Every shape whose facts prove a rule on this svn, on a copy of its spiked working copy: the set read
   * there, the rule run through the executor as the Finish runs it, then no conflict left on the victim
   * and no guard finding over the settled set. One "fixed automatically" line per shape.
   */
  private async rules(outcomes: ReadonlyMap<string, SpikeOutcome>): Promise<void> {
    const manager = new SvnWorktreeManager(this.deps.svn)
    const failed: string[] = []
    for (const spikeCase of ConflictShapesSpike.casesConst) {
      const outcome = outcomes.get(spikeCase.name)
      if (spikeCase.expected?.rule === undefined || spikeCase.expected.rule === null || outcome === undefined) continue
      const checkout = await this.copyOf(outcome, `rule-${spikeCase.name}`)
      const read = await manager.conflictSet(checkout.path, ConflictShapesSpike.baseRevisionConst)
      if (!read.ok) throw new Error(`The conflict set of ${spikeCase.name}: ${read.detail}`)
      const set = SvnConflictFlow.setOf(read.value, ConflictShapesSpike.baseRevisionConst, 0, true)
      const entry = set.entries.find((candidate) => candidate.path === spikeCase.victim)
      const rule = entry?.state === 'rule' ? entry.rule : undefined
      if (entry === undefined || rule === undefined) {
        failed.push(`${spikeCase.name} has no rule entry`)
        continue
      }
      const executor = new SvnConflictResolutions({ svn: this.deps.svn, markersIn: (root, paths) => SvnResolverLauncher.markersIn(root, paths), now: () => Date.now() })
      const savedDir = join(dirname(checkout.path), 'results', 'a1', 'saved')
      const applied = await executor.apply({
        root: checkout.path, savedDir, path: entry.path, kind: entry.kind, option: rule, journal: null,
        ...entry.facts.properties === undefined ? {} : { properties: entry.facts.properties },
        baseRevision: ConflictShapesSpike.baseRevisionConst,
        onStep: async () => undefined,
      })
      const after = await manager.conflictSet(checkout.path, ConflictShapesSpike.baseRevisionConst)
      if (!after.ok) throw new Error(`The conflict set of ${spikeCase.name} after its rule: ${after.detail}`)
      const settled = SvnConflictFlow.settledBy(set, 'jamat')
      const marked = entry.kind === 'text' ? await SvnResolverLauncher.markersIn(checkout.path, [entry.path]) : []
      const findings = SvnConflictGuard.check({ set: settled, rows: after.value.rows, marked })
      const left = after.value.facts.some((fact) => fact.path === spikeCase.victim)
      console.log(`  fixed automatically: ${spikeCase.name} (${rule})${applied.ok ? '' : ` FAILED: ${applied.detail}`}${left ? ', still conflicted' : ''}${findings.length === 0 ? '' : `, guard: ${findings.map((finding) => finding.kind).join(', ')}`}`)
      if (!applied.ok || left || findings.length > 0) failed.push(spikeCase.name)
    }
    this.deps.check(`rules: each shape with a rule on this svn is settled by it, with no conflict left and no guard finding${failed.length === 0 ? '' : ` (${failed.join('; ')})`}`,
      failed.length === 0)
    const ignore = await this.copyOf(outcomes.get('ignore') ?? ConflictShapesSpike.missing('ignore'), 'rule-ignore-value')
    const read = await manager.conflictSet(ignore.path, ConflictShapesSpike.baseRevisionConst)
    if (!read.ok) throw new Error(read.detail)
    const executor = new SvnConflictResolutions({ svn: this.deps.svn, markersIn: async () => [], now: () => Date.now() })
    await executor.apply({ root: ignore.path, savedDir: join(dirname(ignore.path), 'results', 'a1', 'saved'), path: '.', kind: 'property', option: 'union',
      properties: ['svn:ignore'], baseRevision: ConflictShapesSpike.baseRevisionConst, journal: null, onStep: async () => undefined })
    const value = (await ignore.run(['propget', 'svn:ignore', '--', '.'])).replace(/\r\n/g, '\n')
    this.deps.check('rules: the union of svn:ignore keeps r3\'s lines in their order and appends the line the session added',
      value.startsWith('node_modules\ncoverage\ndist\n'))
  }

  private static missing(name: string): never {
    throw new Error(`No spike of ${name}`)
  }

  /** The parsed facts of one fixture pair, for the parity check against this machine's svn. */
  static factsText(status: string, info: string, victim: string): string {
    return JSON.stringify(ConflictShapesSpike.factsOf(status, info, victim))
  }

  /** `SvnConflictFacts` over one case's status and info XML; the root is a stand-in, the XML names paths relative to it. */
  static factsOf(status: string, info: string, victim: string): SpikeFacts {
    const root = join(tmpdir(), 'conflict-spike-parity')
    const name = victim === '.' ? '.' : victim.split('/').at(-1) ?? ''
    return {
      row: SvnConflictFacts.conflictedRows(status, root).find((row) => row.path === victim) ?? null,
      entry: SvnConflictFacts.infoConflicts(info).find((entry) => entry.name === name) ?? null,
    }
  }

  private async spike(spikeCase: SpikeCase): Promise<SpikeOutcome> {
    const directory = join(this.deps.root, `shape-${spikeCase.name}`)
    await mkdir(directory, { recursive: true })
    const repository = join(directory, 'repo')
    const created = await new CommandInvoker().run({ command: 'svnadmin', args: ['create', repository], cwd: directory, env: process.env })
    if (created.failure !== null || created.code !== 0) throw new Error(created.stderr || JSON.stringify(created))
    const url = pathToFileURL(repository).href
    const land = new SpikeCheckout(join(directory, 'land'), this.deps.svn)
    const mine = new SpikeCheckout(join(directory, 'wc'), this.deps.svn)
    await land.run(['mkdir', '--username', 'fixture', '-m', 'lib', `${url}/Lib`], directory)
    await land.run(['checkout', url, land.path], directory)
    await spikeCase.base(land)
    await land.run(['add', '--force', '--', '.'])
    await land.run(['commit', '-m', 'base', '--', '.'])
    await land.run(['update', '--', '.'])
    await land.run(['checkout', url, mine.path], directory)
    await spikeCase.incoming(land)
    await land.run(['add', '--force', '--', '.'])
    await land.run(['commit', '-m', 'incoming', '--', '.'])
    await spikeCase.mine(mine)
    const update = await mine.attempt(['update', '--accept', 'postpone', '--', '.'])
    const status = await mine.run(['status', '--xml', '--', '.'])
    const parent = spikeCase.victim === '.' ? mine.path : join(mine.path, ...spikeCase.victim.split('/').slice(0, -1))
    const info = await mine.run(['info', '--xml', '--depth', spikeCase.victim === '.' ? 'empty' : 'immediates', '--', '.'], parent)
    const prefix = spikeCase.victim === '.' ? '' : `${spikeCase.victim}/`
    const below = SvnWorktreeEvidence.statusVerboseRows(await mine.run(['status', '-v', '--xml', '--', '.']), mine.path)
      .filter((row) => prefix !== '' && row.path.startsWith(prefix))
      .map((row) => ({ path: row.path, item: row.item }))
    return { spikeCase, checkout: mine, exit: update.code, stderr: update.stderr, status, info, below }
  }

  private static lineOf(outcome: SpikeOutcome, plan: SvnConflictPlan | null): string {
    const { row, entry } = ConflictShapesSpike.factsOf(outcome.status, outcome.info, outcome.spikeCase.victim)
    const kinds = row === null ? [] : [row.tree ? 'tree' : null, row.text ? 'text' : null, row.property ? 'property' : null].filter((kind) => kind !== null)
    const tree = entry?.tree ?? null
    const treeText = tree === null ? ''
      : ` reason=${tree.reason} action=${tree.action} local=${tree.localKind} incoming=${tree.incomingKind}@r${tree.incomingRevision ?? '?'}${tree.localHistory ? ' with history' : ''}`
    const letters = new Map<string, number>()
    for (const below of outcome.below) letters.set(below.item, (letters.get(below.item) ?? 0) + 1)
    const below = [...letters].map(([item, count]) => `${count} ${item}`).join(', ')
    const failure = outcome.exit === 0 ? '' : ` (${outcome.stderr.split(/\r?\n/)[0] ?? ''})`
    const sidecars = entry === null ? [] : Object.entries(entry.sidecars).flatMap(([side, path]) => path === null ? [] : [`${side}=${path.split(/[\\/]/).at(-1) ?? ''}`])
    return [
      kinds.length > 0 ? `conflict ${kinds.join('+')}${treeText}` : 'no conflict',
      `update exit ${outcome.exit}${failure}`,
      ...below === '' ? [] : [`below the victim: ${below}`],
      ...sidecars.length === 0 ? [] : [`sidecars ${sidecars.join(' ')}`],
      ...plan === null ? [] : [`shape ${plan.shape}, rule ${plan.rule ?? 'none'}, options ${plan.options.join('/') || 'none'}${plan.agent ? ', agent' : ''}`],
    ].join('; ')
  }

  /** The candidate sequences of the options, each on a copy of a spiked working copy. */
  private async trials(outcomes: ReadonlyMap<string, SpikeOutcome>): Promise<void> {
    const { check } = this.deps
    const of = (name: string): SpikeOutcome => {
      const outcome = outcomes.get(name)
      if (outcome === undefined) throw new Error(`No spike of ${name}`)
      return outcome
    }

    const incident = of('obstructed-dir')
    const incidentTree = ConflictShapesSpike.factsOf(incident.status, incident.info, incident.spikeCase.victim).entry?.tree
    check('spike: the incident reads reason unversioned, action add (svn\'s word), a local and an incoming dir',
      incident.info.includes('reason="unversioned"') && incident.info.includes('action="add"')
      && incidentTree?.reason === 'unversioned' && incidentTree.action === 'added' && incidentTree.localKind === 'dir' && incidentTree.incomingKind === 'dir')
    const incoming = incident.below.filter((row) => row.path.startsWith('.aidocs/engines/t2'))
    console.log(`  info: the incoming children of the incident read as ${[...new Set(incoming.map((row) => row.item))].join(', ')} and are ${await ConflictShapesSpike.onDisk(incident.checkout, '.aidocs/engines/t2/brief.md') ? 'on' : 'absent from'} disk`)
    check('spike: the incoming children of the incident are scheduled as D or missing (!)',
      incoming.length === 4 && incoming.every((row) => row.item === 'deleted' || row.item === 'missing'))

    const reverted = await this.copyOf(incident, 'revert')
    await reverted.run(['revert', '-R', '--', '.aidocs/engines'])
    const revertedRows = await ConflictShapesSpike.rowsOf(reverted)
    check('spike: svn revert -R on the incident victim restores every incoming file and leaves other-named unversioned files on disk',
      await reverted.read('.aidocs/engines/t2/brief.md') === 'brief t2\n' && await reverted.read('.aidocs/engines/t2/trail.md') === 'trail t2\n'
      && await reverted.read('.aidocs/engines/t1/brief.md') === 'brief t1\n' && await reverted.read('.aidocs/engines/t1/report.md') === 'report t1\n'
      && !revertedRows.some((row) => row.conflict) && revertedRows.some((row) => row.path === '.aidocs/engines/t1'))

    const working = await this.copyOf(incident, 'working')
    await working.run(['resolve', '--accept', 'working', '--', '.aidocs/engines'])
    const workingRows = SvnWorktreeEvidence.statusVerboseRows(await working.run(['status', '-v', '--xml', '--', '.']), working.path)
    check('spike: --accept working on the incident leaves the incoming files scheduled for deletion',
      ['.aidocs/engines/t2/brief.md', '.aidocs/engines/t2/report.md', '.aidocs/engines/t2/trail.md']
        .every((path) => workingRows.some((row) => row.path === path && row.item === 'deleted')))
    const incidentSet = await new SvnWorktreeManager(this.deps.svn).conflictSet(incident.checkout.path, ConflictShapesSpike.baseRevisionConst)
    if (!incidentSet.ok) throw new Error(`The conflict set of the incident: ${incidentSet.detail}`)
    const settledSet = SvnConflictFlow.settledBy(SvnConflictFlow.setOf(incidentSet.value, ConflictShapesSpike.baseRevisionConst, 0, false), 'person')
    const guardRows = SvnConflictFacts.itemRows(await working.run(['status', '--xml', '--', '.']), working.path)
    const findings = SvnConflictGuard.check({ set: settledSet, rows: guardRows, marked: [] })
    // Plain status lists the folder scheduled for deletion alone, not the files below it.
    check('guard: a TortoiseSVN-style --accept working on the incident is found to drop what r3 added below the folder',
      findings.length === 1 && findings[0]?.kind === 'drops-incoming' && findings[0].path === '.aidocs/engines'
      && findings[0].dropped.includes('.aidocs/engines'))

    const putBack = await this.copyOf(incident, 'put-back')
    const aside = join(dirname(putBack.path), 'put-back-aside')
    await rename(join(putBack.path, '.aidocs', 'engines'), aside)
    await putBack.run(['revert', '-R', '--', '.aidocs/engines'])
    await cp(join(aside, 't1'), join(putBack.path, '.aidocs', 'engines', 't1'), { recursive: true })
    await putBack.write('.aidocs/engines/t2/notes.md', 'put back\n')
    const plainAdd = await putBack.attempt(['add', '--', '.aidocs/engines/t1/brief.md'])
    const parentsAdd = await putBack.attempt(['add', '--parents', '--', '.aidocs/engines/t1/brief.md'])
    const restoredDirAdd = await putBack.attempt(['add', '--', '.aidocs/engines/t2/notes.md'])
    console.log(`  info: after moving the local tree aside, revert -R restores ${await putBack.read('.aidocs/engines/t2/brief.md') === 'brief t2\n' ? 'the incoming tree' : 'NOT the incoming tree'}; svn add of a put-back file below an unversioned directory exits ${plainAdd.code}${plainAdd.code === 0 ? '' : ` (${plainAdd.stderr.split(/\r?\n/)[0]})`}, with --parents ${parentsAdd.code}; in a restored directory ${restoredDirAdd.code}`)
    check('spike: a put-back file is added with --parents below a new directory, and plainly inside a restored one',
      parentsAdd.code === 0 && restoredDirAdd.code === 0)

    const sameName = of('obstructed-dir-same-name')
    console.log(`  info: a same-name local file below the incident victim reads as ${sameName.below.find((row) => row.path === '.aidocs/engines/t2/brief.md')?.item ?? 'absent'}, an other-named one as ${sameName.below.find((row) => row.path === '.aidocs/engines/t2/notes.md')?.item ?? 'absent'}`)
    const sameReverted = await this.copyOf(sameName, 'revert')
    await sameReverted.run(['revert', '-R', '--', '.aidocs/engines'])
    check('spike: svn revert -R replaces a same-name local file with the incoming one, so keep-both moves it aside first',
      await sameReverted.read('.aidocs/engines/t2/brief.md') === 'brief t2\n' && await sameReverted.read('.aidocs/engines/t2/notes.md') === 'notes of the session\n')

    const text = of('text-overlap')
    const textFacts = ConflictShapesSpike.factsOf(text.status, text.info, text.spikeCase.victim)
    const sidecarFiles = ['catalog.ts.mine', 'catalog.ts.r2', 'catalog.ts.r3']
    check('spike: a text conflict leaves three sidecars that svn info --xml names',
      JSON.stringify(ConflictShapesSpike.sidecarNames(textFacts)) === JSON.stringify(['catalog.ts.r2', 'catalog.ts.mine', 'catalog.ts.r3'])
      && (await Promise.all(sidecarFiles.map((name) => ConflictShapesSpike.onDisk(text.checkout, `src/${name}`)))).every(Boolean))
    for (const [accept, expected] of [['theirs-full', 'one\ntwo\nthree theirs\nfour\n'], ['mine-full', 'one\ntwo\nthree mine\nfour\n']] as const) {
      const copy = await this.copyOf(text, accept)
      await copy.run(['resolve', '--accept', accept, '--', 'src/catalog.ts'])
      const left = (await Promise.all(sidecarFiles.map((name) => ConflictShapesSpike.onDisk(copy, `src/${name}`)))).some(Boolean)
      check(`spike: --accept ${accept} takes its side of a text conflict and removes the sidecars`,
        await copy.read('src/catalog.ts') === expected && !left && !(await ConflictShapesSpike.rowsOf(copy)).some((row) => row.conflict))
    }

    const ignore = of('ignore')
    const merged = await this.copyOf(ignore, 'merged')
    const mergedFile = join(dirname(merged.path), 'ignore-merged.txt')
    await writeFile(mergedFile, 'node_modules\ndist\ncoverage\n')
    await merged.run(['propset', 'svn:ignore', '-F', mergedFile, '--', '.'])
    await merged.run(['resolve', '--accept', 'working', '--', '.'])
    const mergedValue = await merged.run(['propget', 'svn:ignore', '--', '.'])
    check('spike: propset -F of a merged svn:ignore and --accept working clear a property conflict',
      !(await ConflictShapesSpike.rowsOf(merged)).some((row) => row.conflict) && mergedValue.replace(/\r\n/g, '\n').startsWith('node_modules\ndist\ncoverage\n')
      && !(await readdir(merged.path)).some((name) => name.endsWith('.prej')))

    const nonAscii = of('non-ascii')
    const nonAsciiFacts = ConflictShapesSpike.factsOf(nonAscii.status, nonAscii.info, nonAscii.spikeCase.victim)
    check('spike: a non-ASCII victim is listed by a read in its parent directory with the working directory there',
      nonAsciiFacts.row?.text === true && nonAsciiFacts.entry?.text === true && ConflictShapesSpike.sidecarNames(nonAsciiFacts).length === 3)

    const moved = of('moved-vs-edit')
    const mineConflict = await this.copyOf(moved, 'mine-conflict')
    const resolved = await mineConflict.attempt(['resolve', '--accept', 'mine-conflict', '--', 'src/legacy.txt'])
    console.log(`  info: --accept mine-conflict on a local move against an incoming edit exits ${resolved.code}${resolved.code === 0 ? '' : ` (${resolved.stderr.split(/\r?\n/)[0]})`}; the move target then holds ${JSON.stringify(await mineConflict.read('src/moved.txt'))}`)
    const recommended = await this.copyOf(moved, 'recommended-away')
    const unresolved = await recommended.attempt(['resolve', '--accept', 'recommended', '--', 'src/legacy.txt'])
    check('spike: --accept recommended on a local move against an incoming edit exits 0 and leaves the conflict, so CF15 takes mine-conflict',
      unresolved.code === 0 && (await ConflictShapesSpike.rowsOf(recommended)).some((row) => row.conflict))

    const mergeinfo = of('mergeinfo')
    const mergedInfo = (await mergeinfo.checkout.run(['propget', 'svn:mergeinfo', '--', '.'])).trim().split(/\s+/).join(' ')
    console.log(`  info: svn merges svn:mergeinfo of both sides itself on update, without a conflict: ${mergedInfo}`)

    const exits = [...outcomes.values()].map((outcome) => `${outcome.spikeCase.name} ${outcome.exit}`)
    console.log(`  info: update exit codes with postponed conflicts: ${exits.join(', ')}`)
  }

  /**
   * Every option of `SvnConflictResolutions` on a copy of a spiked working copy, on real svn, and the
   * option the incident needs run again with a stop after each of its steps: the resumed run must leave
   * the same disk and the same status as the run without a stop.
   */
  private async options(outcomes: ReadonlyMap<string, SpikeOutcome>): Promise<void> {
    const { check } = this.deps
    const of = (name: string): SpikeOutcome => {
      const outcome = outcomes.get(name)
      if (outcome === undefined) throw new Error(`No spike of ${name}`)
      return outcome
    }
    const incident = of('obstructed-dir')
    const keepBoth = await this.applied(incident, 'keep-both', '.aidocs/engines', 'tree', 'keep-both')
    const bothRows = await ConflictShapesSpike.rowsOf(keepBoth.checkout)
    check('options: keep-both on the incident restores the 3 files r3 added, keeps and adds the 2 files of the session, saves them, and leaves no conflict',
      keepBoth.ok && keepBoth.diverged.length === 0
      && await keepBoth.checkout.read('.aidocs/engines/t2/trail.md') === 'trail t2\n'
      && await keepBoth.checkout.read('.aidocs/engines/t1/brief.md') === 'brief t1\n'
      && bothRows.some((row) => row.path === '.aidocs/engines/t1/report.md' || row.path === '.aidocs/engines/t1')
      && !bothRows.some((row) => row.conflict)
      && existsSync(join(keepBoth.savedDir, '.aidocs', 'engines', 't1', 'brief.md')))

    const sameName = await this.applied(of('obstructed-dir-same-name'), 'keep-both-same-name', '.aidocs/engines', 'tree', 'keep-both')
    check('options: keep-both leaves a differing same-name file diverged: the incoming file in place, the session\'s copy saved',
      sameName.ok && JSON.stringify(sameName.diverged) === JSON.stringify(['.aidocs/engines/t2/brief.md'])
      && await sameName.checkout.read('.aidocs/engines/t2/brief.md') === 'brief t2\n'
      && await readFile(join(sameName.savedDir, '.aidocs', 'engines', 't2', 'brief.md'), 'utf8') === 'brief of the session\n'
      && await sameName.checkout.read('.aidocs/engines/t2/notes.md') === 'notes of the session\n')

    const takeIncoming = await this.applied(incident, 'take-incoming', '.aidocs/engines', 'tree', 'take-incoming')
    check('options: take-incoming on the incident restores the files of r3 and moves the session\'s files into the saved folder',
      takeIncoming.ok && await takeIncoming.checkout.read('.aidocs/engines/t2/brief.md') === 'brief t2\n'
      && await takeIncoming.checkout.read('.aidocs/engines/t1/brief.md') === null
      && await readFile(join(takeIncoming.savedDir, '.aidocs', 'engines', 't1', 'report.md'), 'utf8') === 'report t1\n'
      && !(await ConflictShapesSpike.rowsOf(takeIncoming.checkout)).some((row) => row.conflict))

    const text = of('text-overlap')
    for (const [option, expected] of [['keep-mine', 'one\ntwo\nthree mine\nfour\n'], ['take-incoming', 'one\ntwo\nthree theirs\nfour\n']] as const) {
      const applied = await this.applied(text, `text-${option}`, 'src/catalog.ts', 'text', option)
      check(`options: ${option} on a text conflict takes its side, saves the session's sidecar and leaves no conflict`,
        applied.ok && await applied.checkout.read('src/catalog.ts') === expected
        && await readFile(join(applied.savedDir, 'src', 'catalog.ts.mine'), 'utf8') === 'one\ntwo\nthree mine\nfour\n'
        && !(await ConflictShapesSpike.rowsOf(applied.checkout)).some((row) => row.conflict))
    }
    const unmerged = await this.applied(text, 'merged-markers', 'src/catalog.ts', 'text', 'merged')
    const merged = await this.applied(text, 'merged', 'src/catalog.ts', 'text', 'merged', async (checkout) => {
      await checkout.write('src/catalog.ts', 'one\ntwo\nthree mine and theirs\nfour\n')
    })
    check('options: merged refuses a file with markers and settles one edited to the merged text',
      !unmerged.ok && unmerged.detail.includes('markers') && (await ConflictShapesSpike.rowsOf(unmerged.checkout)).some((row) => row.conflict)
      && merged.ok && !(await ConflictShapesSpike.rowsOf(merged.checkout)).some((row) => row.conflict)
      && await merged.checkout.read('src/catalog.ts') === 'one\ntwo\nthree mine and theirs\nfour\n')

    const union = await this.applied(of('ignore'), 'union', '.', 'property', 'union', undefined, ['svn:ignore'])
    const unionValue = (await union.checkout.run(['propget', 'svn:ignore', '--', '.'])).replace(/\r\n/g, '\n')
    check('options: union of svn:ignore keeps the lines of both sides and leaves no conflict',
      union.ok && unionValue.startsWith('node_modules\ncoverage\ndist\n') && !(await ConflictShapesSpike.rowsOf(union.checkout)).some((row) => row.conflict))

    const steps = SvnConflictResolutions.stepsOf('tree', 'keep-both')
    const reference = await ConflictShapesSpike.diskOf(keepBoth.checkout)
    const differing: string[] = []
    for (let stop = 1; stop < steps.length; stop += 1) {
      const resumed = await this.applied(incident, `resume-${stop}`, '.aidocs/engines', 'tree', 'keep-both', undefined, undefined, stop)
      if (!resumed.ok || await ConflictShapesSpike.diskOf(resumed.checkout) !== reference) differing.push(`after ${steps[stop - 1]}`)
    }
    check(`options: keep-both on the incident resumed after each of its first ${steps.length - 1} steps leaves the disk of a run without a stop${differing.length === 0 ? '' : ` (differs ${differing.join(', ')})`}`,
      differing.length === 0)
  }

  /**
   * One option on a fresh copy, through `SvnConflictResolutions`; `stopAfter` stops the first run after
   * that many steps, and a second run resumes from the journal the first one left.
   */
  private async applied(
    outcome: SpikeOutcome,
    label: string,
    path: string,
    kind: SvnConflictKind,
    option: SvnConflictOption,
    before?: (checkout: SpikeCheckout) => Promise<void>,
    properties?: readonly string[],
    stopAfter?: number,
    move?: SvnConflictApply['move'],
  ): Promise<{ checkout: SpikeCheckout; savedDir: string; ok: boolean; detail: string; diverged: string[] }> {
    const checkout = await this.copyOf(outcome, `option-${label}`)
    const savedDir = join(dirname(checkout.path), 'results', 'a1', 'saved')
    await before?.(checkout)
    const executor = new SvnConflictResolutions({ svn: this.deps.svn, markersIn: (root, paths) => SvnResolverLauncher.markersIn(root, paths), now: () => Date.now() })
    let journal: SvnConflictJournal | null = null
    let stop = stopAfter
    const diverged: string[] = []
    const run = (): ReturnType<SvnConflictResolutions['apply']> => executor.apply({
      root: checkout.path, savedDir, path, kind, option, journal, ...properties === undefined ? {} : { properties }, ...move === undefined ? {} : { move },
      baseRevision: ConflictShapesSpike.baseRevisionConst,
      onStep: async (next, left) => {
        journal = next
        diverged.push(...left)
        if (stop !== undefined && next.done === stop) throw new SpikeStopped()
      },
    })
    let result: Awaited<ReturnType<typeof run>>
    try {
      result = await run()
    } catch (error) {
      if (!(error instanceof SpikeStopped)) throw error
      stop = undefined
      result = await run()
    }
    return { checkout, savedDir, ok: result.ok, detail: result.ok ? '' : result.detail, diverged }
  }

  /** Every file below `.aidocs` with its text, and the status of the working copy, relative to it. */
  private static async diskOf(checkout: SpikeCheckout): Promise<string> {
    const files = (await readdir(join(checkout.path, '.aidocs'), { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .sort()
    const texts = await Promise.all(files.map(async (file) => `${file.slice(checkout.path.length)}=${await readFile(file, 'utf8')}`))
    const rows = (await ConflictShapesSpike.rowsOf(checkout)).map((row) => `${row.path} ${row.kind}${row.conflict ? ' C' : ''}`).sort()
    return JSON.stringify({ texts, rows })
  }

  private async copyOf(outcome: SpikeOutcome, label: string): Promise<SpikeCheckout> {
    const target = join(dirname(outcome.checkout.path), `trial-${label}`, 'wc')
    await cp(outcome.checkout.path, target, { recursive: true })
    return new SpikeCheckout(target, this.deps.svn)
  }

  private static async rowsOf(checkout: SpikeCheckout): Promise<{ path: string; kind: string; conflict: boolean }[]> {
    return SvnWorktreeEvidence.statusRows(await checkout.run(['status', '--xml', '--', '.']), checkout.path)
  }

  private static async onDisk(checkout: SpikeCheckout, relative: string): Promise<boolean> {
    return existsSync(join(checkout.path, ...relative.split('/')))
  }

  private static utf16(text: string): Buffer {
    return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
  }

  private static sidecarNames(facts: SpikeFacts): string[] {
    const sidecars = facts.entry?.sidecars
    return sidecars === undefined ? [] : [sidecars.older, sidecars.mine, sidecars.theirs, sidecars.prej]
      .flatMap((path) => path === null ? [] : [path.split(/[\\/]/).at(-1) ?? ''])
  }
}
