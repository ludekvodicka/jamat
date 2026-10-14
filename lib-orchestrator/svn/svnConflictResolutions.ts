import { createHash } from 'node:crypto'
import { appendFile, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { CommandRunner } from '../shared/commandInvoker.types'
import { ErrorText } from '../shared/errorText'
import type {
  SvnConflictApply,
  SvnConflictKind,
  SvnConflictOption,
  SvnConflictStepName,
  SvnResult,
} from './svn.types'
import { SvnConflictFacts } from './svnConflictFacts'
import { SvnWorktreeEvidence } from './svnWorktreeEvidence'

export interface SvnConflictResolutionsDeps {
  svn: CommandRunner
  /** The paths among these that still hold a conflict marker line (or cannot be read). */
  markersIn: (root: string, paths: readonly string[]) => Promise<string[]>
  now: () => number
}

type StepResult = SvnResult<{ diverged: string[] }>

/**
 * The option executor: the one place that writes svn to settle a conflicted path. Each option of the
 * vocabulary is a list of named steps (`stepsOf`); every step first copies what it would move, replace
 * or resolve away into the saved folder, appends one line to `fixes.log` beside it, and reports its
 * journal before the next step starts. A resume starts at the first step the journal does not name
 * done, and every step is safe to run again: a removal deletes only a file that still equals its
 * saved copy, a save never overwrites an earlier copy, an accept runs only while svn marks the path.
 * A name svn cannot take as an argument is refused before any step (`SvnWorktreeEvidence.takesArgument`).
 */
export class SvnConflictResolutions {
  private static readonly addBatchConst = 50
  /** svn:ignore and svn:global-ignores: one entry per line, so a three-way merge of the lines is lossless. */
  private static readonly lineListPropertiesConst: readonly string[] = ['svn:ignore', 'svn:global-ignores']
  /** svn says a property has no value on the node. */
  private static readonly propertyNotFoundConst = /\bW200017\b/
  private readonly svn: CommandRunner
  private readonly markersIn: SvnConflictResolutionsDeps['markersIn']
  private readonly now: () => number

  constructor(deps: SvnConflictResolutionsDeps) {
    this.svn = deps.svn
    this.markersIn = deps.markersIn
    this.now = deps.now
  }

  /**
   * The steps of an option on a path of this kind. A tree option moves the local side aside before
   * `svn revert -R` restores the incoming side, because revert overwrites a same-name local file; a
   * text or property option saves the sidecars and lets svn take a side; a diverged file (keep-both
   * left a same-name file for a merge) is no svn conflict, so its options only touch the file.
   */
  static stepsOf(kind: SvnConflictKind, option: SvnConflictOption): SvnConflictStepName[] {
    switch (kind) {
      case 'tree': return SvnConflictResolutions.treeStepsOf(option)
      case 'text': case 'property': return SvnConflictResolutions.contentStepsOf(option)
      case 'diverged': return SvnConflictResolutions.divergedStepsOf(option)
      default: throw new Error(`Unknown conflict kind: ${JSON.stringify(kind satisfies never)}`)
    }
  }

  /** Runs the option from the first step the journal does not name done; a failed step keeps its journal. */
  async apply(input: SvnConflictApply): Promise<SvnResult<void>> {
    const refusal = await this.refusalOf(input)
    if (refusal !== null) return { ok: false, code: 'refused', detail: refusal }
    const steps = SvnConflictResolutions.stepsOf(input.kind, input.option)
    const from = input.journal?.option === input.option ? Math.min(input.journal.done, steps.length) : 0
    for (let index = from; index < steps.length; index += 1) {
      const step = steps[index]
      let done: StepResult
      try {
        done = await this.run(step, input)
      } catch (error) {
        done = { ok: false, code: 'io-failed', detail: ErrorText.of(error) }
      }
      await this.logged(input, step, done)
      if (!done.ok) return done
      await input.onStep({ option: input.option, done: index + 1 }, done.value.diverged)
    }
    return { ok: true, value: undefined }
  }

  /**
   * A three-way merge of two line lists against the value before the update: the incoming lines in
   * their order, without the lines the session removed, then the lines the session added. What either
   * side added stays and what either side removed goes.
   */
  static linesMerged(older: string, mine: string, theirs: string): string {
    const lines = (value: string): string[] => [...new Set(value.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line !== ''))]
    const before = lines(older)
    const own = lines(mine)
    const removed = before.filter((line) => !own.includes(line))
    const incoming = lines(theirs).filter((line) => !removed.includes(line))
    return [...incoming, ...own.filter((line) => !before.includes(line) && !incoming.includes(line))].map((line) => `${line}\n`).join('')
  }

  /**
   * The union of two `svn:mergeinfo` values: per source path the revision ranges of both sides, merged
   * where they meet; a non-inheritable range (`*`) merges only with its own kind. Source paths keep the
   * session's order, the incoming ones it lacks follow.
   */
  static mergeinfoUnion(mine: string, theirs: string): string {
    const ranges = new Map<string, { start: number; end: number; inheritable: boolean }[]>()
    for (const line of [...mine.split(/\r?\n/), ...theirs.split(/\r?\n/)]) {
      const at = line.trim().lastIndexOf(':')
      if (at <= 0) continue
      const source = line.trim().slice(0, at)
      const list = ranges.get(source) ?? []
      for (const token of line.trim().slice(at + 1).split(',')) {
        const match = /^(\d+)(?:-(\d+))?(\*?)$/.exec(token.trim())
        if (match === null) throw new Error(`svn:mergeinfo holds a range Jamat cannot read: ${token}`)
        list.push({ start: Number(match[1]), end: Number(match[2] ?? match[1]), inheritable: match[3] === '' })
      }
      ranges.set(source, list)
    }
    return [...ranges].map(([source, list]) => {
      const merged: { start: number; end: number; inheritable: boolean }[] = []
      for (const range of [...list].sort((a, b) => a.start - b.start || Number(b.inheritable) - Number(a.inheritable))) {
        const last = [...merged].reverse().find((candidate) => candidate.inheritable === range.inheritable)
        if (last !== undefined && range.start <= last.end + 1) last.end = Math.max(last.end, range.end)
        else merged.push({ ...range })
      }
      const text = merged.sort((a, b) => a.start - b.start)
        .map((range) => `${range.start}${range.end === range.start ? '' : `-${range.end}`}${range.inheritable ? '' : '*'}`).join(',')
      return `${source}:${text}\n`
    }).join('')
  }

  private static treeStepsOf(option: SvnConflictOption): SvnConflictStepName[] {
    switch (option) {
      case 'keep-both': return ['save-local', 'remove-saved', 'revert-incoming', 'put-back', 'accept-working']
      case 'take-incoming': return ['save-local', 'remove-saved', 'revert-incoming']
      case 'keep-mine': return ['save-sidecars', 'accept-working']
      case 'merged': return ['save-sidecars', 'accept-working']
      case 'union': throw new Error('A tree conflict has no union')
      default: throw new Error(`Unknown conflict option: ${JSON.stringify(option satisfies never)}`)
    }
  }

  private static contentStepsOf(option: SvnConflictOption): SvnConflictStepName[] {
    switch (option) {
      case 'take-incoming': return ['save-sidecars', 'accept-theirs-full']
      case 'keep-mine': return ['save-sidecars', 'accept-mine-full']
      case 'merged': return ['save-sidecars', 'no-markers', 'accept-working']
      case 'union': return ['save-sidecars', 'union-properties', 'accept-working']
      case 'keep-both': throw new Error('A text or property conflict has no keep-both')
      default: throw new Error(`Unknown conflict option: ${JSON.stringify(option satisfies never)}`)
    }
  }

  /** The incoming file is in place and the session's copy saved: take-incoming has nothing left to do. */
  private static divergedStepsOf(option: SvnConflictOption): SvnConflictStepName[] {
    switch (option) {
      case 'take-incoming': return []
      case 'keep-mine': return ['restore-saved']
      case 'merged': return ['no-markers']
      case 'keep-both': case 'union': throw new Error(`A diverged file has no ${option}`)
      default: throw new Error(`Unknown conflict option: ${JSON.stringify(option satisfies never)}`)
    }
  }

  /** Every name the option would pass to svn, checked before anything is written. */
  private async refusalOf(input: SvnConflictApply): Promise<string | null> {
    if (!SvnWorktreeEvidence.takesArgument(input.path)) return `svn cannot take the name ${input.path} as an argument; resolve it in an SVN client`
    if (input.kind === 'tree' && input.path === '.') return 'a tree conflict on the working copy root is resolved in an SVN client'
    const unsafe = (await SvnConflictResolutions.filesUnder(input.root, input.path)).filter((path) => !SvnWorktreeEvidence.takesArgument(path))
    return unsafe.length === 0 ? null : `svn cannot take the names ${unsafe.join(', ')} below ${input.path}; resolve it in an SVN client`
  }

  private async run(step: SvnConflictStepName, input: SvnConflictApply): Promise<StepResult> {
    switch (step) {
      case 'save-local': return this.saveLocal(input)
      case 'remove-saved': return this.removeSaved(input)
      case 'revert-incoming': return SvnConflictResolutions.none(await this.svnIn(input.root, ['revert', '-R', '--', `${input.path}@`]))
      case 'put-back': return this.putBack(input)
      case 'restore-saved': return this.restoreSaved(input)
      case 'save-sidecars': return this.saveSidecars(input)
      case 'no-markers': return this.noMarkers(input)
      case 'union-properties': return this.unionProperties(input)
      case 'accept-working': return this.accept(input, 'working')
      case 'accept-theirs-full': return this.accept(input, 'theirs-full')
      case 'accept-mine-full': return this.accept(input, 'mine-full')
      default: throw new Error(`Unknown conflict step: ${JSON.stringify(step satisfies never)}`)
    }
  }

  /** Every file on disk at or below the victim, copied to the saved folder. */
  private async saveLocal(input: SvnConflictApply): Promise<StepResult> {
    for (const path of await SvnConflictResolutions.filesUnder(input.root, input.path))
      await SvnConflictResolutions.save(SvnConflictResolutions.absolute(input.root, path), SvnConflictResolutions.absolute(input.savedDir, path))
    return SvnConflictResolutions.nothingDiverged()
  }

  /** Only a file that still equals its saved copy goes; one changed since it was saved stays. */
  private async removeSaved(input: SvnConflictApply): Promise<StepResult> {
    for (const path of await SvnConflictResolutions.filesUnder(input.root, input.path)) {
      const file = SvnConflictResolutions.absolute(input.root, path)
      if (await SvnConflictResolutions.sameBytes(file, SvnConflictResolutions.absolute(input.savedDir, path))) await rm(file, { force: true })
    }
    return SvnConflictResolutions.nothingDiverged()
  }

  /**
   * The session's files back beside the restored incoming ones: a file the incoming side lacks is
   * copied and added (`--parents`, since its directory may be new); a same-name file equal to the
   * incoming one has nothing to add; a differing one is diverged, the incoming file stays in place and
   * the session's copy stays saved. A file already copied and still unversioned is added on a resume.
   */
  private async putBack(input: SvnConflictApply): Promise<StepResult> {
    const saved = await SvnConflictResolutions.filesUnder(input.savedDir, input.path)
    for (const path of saved) {
      const target = SvnConflictResolutions.absolute(input.root, path)
      if (await SvnConflictResolutions.exists(target)) continue
      await mkdir(dirname(target), { recursive: true })
      await copyFile(SvnConflictResolutions.absolute(input.savedDir, path), target)
    }
    const status = await this.svnIn(input.root, ['status', '--xml', '--', `${input.path}@`])
    if (!status.ok) return status
    const unversioned = SvnConflictFacts.itemRows(status.value, input.root).filter((row) => row.item === 'unversioned').map((row) => row.path)
    const toAdd: string[] = []
    const diverged: string[] = []
    for (const path of saved) {
      if (unversioned.some((top) => path === top || path.startsWith(`${top}/`))) toAdd.push(path)
      else if (!await SvnConflictResolutions.sameBytes(SvnConflictResolutions.absolute(input.root, path), SvnConflictResolutions.absolute(input.savedDir, path)))
        diverged.push(path)
    }
    for (let start = 0; start < toAdd.length; start += SvnConflictResolutions.addBatchConst) {
      const batch = toAdd.slice(start, start + SvnConflictResolutions.addBatchConst).map((path) => `${path}@`)
      const added = await this.svnIn(input.root, ['add', '--parents', '--force', '--', ...batch])
      if (!added.ok) return added
    }
    return { ok: true, value: { diverged } }
  }

  /** Keep mine of a diverged file: the session's saved copy over the incoming one. */
  private async restoreSaved(input: SvnConflictApply): Promise<StepResult> {
    const saved = SvnConflictResolutions.absolute(input.savedDir, input.path)
    if (!await SvnConflictResolutions.exists(saved)) return { ok: false, code: 'io-failed', detail: `no saved copy of ${input.path} at ${saved}` }
    await copyFile(saved, SvnConflictResolutions.absolute(input.root, input.path))
    return SvnConflictResolutions.nothingDiverged()
  }

  /** The working file and every sidecar svn names for the path, as `svn info --xml` of its parent lists them. */
  private async saveSidecars(input: SvnConflictApply): Promise<StepResult> {
    const parent = input.path === '.' || !input.path.includes('/') ? '.' : input.path.slice(0, input.path.lastIndexOf('/'))
    const name = input.path === '.' ? '.' : input.path.slice(input.path.lastIndexOf('/') + 1)
    const cwd = SvnConflictResolutions.absolute(input.root, parent)
    const info = await this.svnIn(cwd, ['info', '--xml', '--depth', input.path === '.' ? 'empty' : 'immediates', '--', '.'])
    if (!info.ok) return info
    const entry = SvnConflictFacts.infoConflicts(info.value).find((candidate) => candidate.name === name)
    const sidecars = entry === undefined ? [] : [entry.sidecars.older, entry.sidecars.mine, entry.sidecars.theirs, entry.sidecars.prej]
      .flatMap((path) => path === null ? [] : [SvnWorktreeEvidence.relativeTo(input.root, path)])
    const working = SvnConflictResolutions.absolute(input.root, input.path)
    const files = (await stat(working).catch(() => null))?.isFile() === true ? [input.path, ...sidecars] : sidecars
    for (const path of files)
      await SvnConflictResolutions.save(SvnConflictResolutions.absolute(input.root, path), SvnConflictResolutions.absolute(input.savedDir, path))
    return SvnConflictResolutions.nothingDiverged()
  }

  /** Merged means edited to the merged text: a text file with a marker line is not merged yet. */
  private async noMarkers(input: SvnConflictApply): Promise<StepResult> {
    if (input.kind !== 'text' && input.kind !== 'diverged') return SvnConflictResolutions.nothingDiverged()
    const marked = await this.markersIn(input.root, [input.path])
    return marked.length === 0
      ? SvnConflictResolutions.nothingDiverged()
      : { ok: false, code: 'refused', detail: `${input.path} still holds conflict markers; merge it, then settle it again` }
  }

  /**
   * The union of each conflicted property, set from a temporary file beside the saved folder, outside
   * the worktree: a line list merged three ways against its value before the update (`baseRevision`),
   * `svn:mergeinfo` as the union of its ranges.
   */
  private async unionProperties(input: SvnConflictApply): Promise<StepResult> {
    const names = input.properties ?? []
    const other = names.find((name) => name !== 'svn:mergeinfo' && !SvnConflictResolutions.lineListPropertiesConst.includes(name))
    if (names.length === 0 || other !== undefined)
      return { ok: false, code: 'refused', detail: `a union is known for svn:ignore, svn:global-ignores and svn:mergeinfo only${other === undefined ? '' : `, not ${other}`}` }
    const target = `${input.path}@`
    for (const name of names) {
      const mine = await this.propertyIn(input.root, name, [], target)
      if (!mine.ok) return mine
      const theirs = await this.propertyIn(input.root, name, ['-r', 'BASE'], target)
      if (!theirs.ok) return theirs
      let value: string
      if (name === 'svn:mergeinfo') value = SvnConflictResolutions.mergeinfoUnion(mine.value, theirs.value)
      else if (input.baseRevision === undefined) return { ok: false, code: 'refused', detail: `the merge of ${name} needs its value before the update` }
      else {
        const older = await this.propertyIn(input.root, name, ['-r', String(input.baseRevision)], target)
        if (!older.ok) return older
        value = SvnConflictResolutions.linesMerged(older.value, mine.value, theirs.value)
      }
      const file = join(dirname(input.savedDir), `union-${createHash('sha1').update(`${input.path}\n${name}`).digest('hex')}.txt`)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, value)
      const set = await this.svnIn(input.root, ['propset', name, '-F', file, '--', target])
      await rm(file, { force: true })
      if (!set.ok) return set
    }
    return SvnConflictResolutions.nothingDiverged()
  }

  /** Only while svn still marks the path, so a repeat after a done resolve does nothing. */
  private async accept(input: SvnConflictApply, accept: 'working' | 'theirs-full' | 'mine-full'): Promise<StepResult> {
    const status = await this.svnIn(input.root, ['status', '--xml', '--depth', 'empty', '--', `${input.path}@`])
    if (!status.ok) return status
    const marked = SvnWorktreeEvidence.statusRows(status.value, input.root).some((row) => row.path === input.path && row.conflict)
    if (!marked) return SvnConflictResolutions.nothingDiverged()
    return SvnConflictResolutions.none(await this.svnIn(input.root, ['resolve', '--accept', accept, '--', `${input.path}@`]))
  }

  /** One line per step; the log is evidence for the person and never decides a step. */
  private async logged(input: SvnConflictApply, step: SvnConflictStepName, done: StepResult): Promise<void> {
    const outcome = !done.ok ? `failed: ${done.detail.split(/\r?\n/)[0] ?? ''}`
      : done.value.diverged.length === 0 ? 'done' : `done, diverged: ${done.value.diverged.join(', ')}`
    const line = `${new Date(this.now()).toISOString()} ${input.path} ${input.option} ${step} ${outcome}\n`
    const file = join(dirname(input.savedDir), 'fixes.log')
    try {
      await mkdir(dirname(file), { recursive: true })
      await appendFile(file, line)
    } catch {
      // A log that cannot be written leaves the journal on the record as the account of the step.
    }
  }

  /** A property's value; one svn says the node does not have is empty. */
  private async propertyIn(root: string, name: string, revision: string[], target: string): Promise<SvnResult<string>> {
    const read = await this.svnIn(root, ['propget', name, '--no-newline', ...revision, '--', target])
    return !read.ok && SvnConflictResolutions.propertyNotFoundConst.test(read.detail) ? { ok: true, value: '' } : read
  }

  private async svnIn(cwd: string, args: string[]): Promise<SvnResult<string>> {
    const outcome = await this.svn.run(cwd, [args[0], '--non-interactive', ...args.slice(1)])
    if (outcome.failure === null && outcome.code === 0) return { ok: true, value: outcome.stdout }
    const detail = [outcome.stdout.trim(), outcome.stderr.trim()].filter(Boolean).join('\n') || `svn could not run (${outcome.failure ?? outcome.code})`
    return { ok: false, code: outcome.failure === 'command-missing' ? 'svn-missing' : 'svn-failed', detail }
  }

  /** Root-relative paths of every file at or below `path` on disk; none when it is absent. */
  private static async filesUnder(root: string, path: string): Promise<string[]> {
    const top = SvnConflictResolutions.absolute(root, path)
    const found = await stat(top).catch(() => null)
    if (found === null) return []
    if (found.isFile()) return [path]
    if (!found.isDirectory()) return []
    const entries = await readdir(top, { recursive: true, withFileTypes: true })
    return entries.filter((entry) => entry.isFile())
      .map((entry) => SvnWorktreeEvidence.relativeTo(root, join(entry.parentPath, entry.name)))
      .sort()
  }

  /** The first copy wins: a repeat or a later option never replaces what was saved before it. */
  private static async save(from: string, to: string): Promise<void> {
    if (await SvnConflictResolutions.exists(to) || !await SvnConflictResolutions.exists(from)) return
    await mkdir(dirname(to), { recursive: true })
    await copyFile(from, to)
  }

  private static async sameBytes(left: string, right: string): Promise<boolean> {
    const [a, b] = await Promise.all([readFile(left).catch(() => null), readFile(right).catch(() => null)])
    return a !== null && b !== null && a.equals(b)
  }

  private static async exists(path: string): Promise<boolean> {
    return (await stat(path).catch(() => null)) !== null
  }

  private static absolute(root: string, path: string): string {
    return path === '.' ? root : join(root, ...path.split('/'))
  }

  private static none(result: SvnResult<string>): StepResult {
    return result.ok ? SvnConflictResolutions.nothingDiverged() : result
  }

  private static nothingDiverged(): StepResult {
    return { ok: true, value: { diverged: [] } }
  }
}
