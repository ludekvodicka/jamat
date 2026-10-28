import { createHash, randomUUID } from 'node:crypto'
import { appendFile, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { CommandRunner } from '../shared/commandInvoker.types'
import { ErrnoCode } from '../shared/errnoCode'
import { ErrorText } from '../shared/errorText'
import { PathCompare } from '../shared/pathCompare'
import type {
  SvnConflictApply,
  SvnConflictKind,
  SvnConflictOption,
  SvnConflictStepName,
  SvnResult,
} from './svn.types'
import { SvnConflictFacts } from './svnConflictFacts'
import { SvnWorktreeEvidence } from './svnWorktreeEvidence'
import { SvnTextResolution } from './svnTextResolution'

export interface SvnConflictResolutionsDeps {
  svn: CommandRunner
  /** Records authorized filesystem writes before the next SVN command under the caller's lease. */
  afterFilesChanged?: (root: string) => Promise<void>
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
  /** svn says a path is no node of the working copy. */
  private static readonly nodeNotFoundConst = /\bW155010\b/
  private readonly svn: CommandRunner
  private readonly afterFilesChanged: SvnConflictResolutionsDeps['afterFilesChanged']
  private readonly markersIn: SvnConflictResolutionsDeps['markersIn']
  private readonly now: () => number

  constructor(deps: SvnConflictResolutionsDeps) {
    this.svn = deps.svn
    this.afterFilesChanged = deps.afterFilesChanged
    this.markersIn = deps.markersIn
    this.now = deps.now
  }

  /**
   * The steps of an option on a path of this kind. A tree option moves the local side aside before
   * `svn revert -R` restores the incoming side, because revert overwrites a same-name local file; a
   * text or property option saves the sidecars and lets svn take a side; a diverged file (keep-both
   * left a same-name file for a merge) is no svn conflict, so its options only touch the file.
   * keep-both of a move lets svn carry the other side's edit to where the node lives now.
   */
  static stepsOf(kind: SvnConflictKind, option: SvnConflictOption, move?: SvnConflictApply['move'], rebuild?: true): SvnConflictStepName[] {
    switch (kind) {
      case 'tree': return SvnConflictResolutions.treeStepsOf(option, move)
      case 'text': return rebuild === true && option === 'merged' ? ['save-sidecars', 'write-merged', 'no-markers', 'accept-working']
        : SvnConflictResolutions.contentStepsOf(option)
      case 'property': return SvnConflictResolutions.contentStepsOf(option)
      case 'diverged': return SvnConflictResolutions.divergedStepsOf(option)
      default: throw new Error(`Unknown conflict kind: ${JSON.stringify(kind satisfies never)}`)
    }
  }

  /** Runs the option from the first step the journal does not name done; a failed step keeps its journal. */
  async apply(input: SvnConflictApply): Promise<SvnResult<void>> {
    let refusal: string | null
    try {
      refusal = await this.refusalOf(input)
      if (refusal !== null) return { ok: false, code: 'refused', detail: refusal }
      const recovered = await this.recoverLocked(input.root, input.savedDir, undefined, [], input.path, input.mainCopy !== true)
      if (!recovered.ok) return recovered
      refusal = await this.refusalOf(input)
    }
    catch (error) { return SvnConflictResolutions.heldOf(error, input) ?? { ok: false, code: 'svn-failed', detail: ErrorText.of(error) } }
    if (refusal !== null) return { ok: false, code: 'refused', detail: refusal }
    const steps = SvnConflictResolutions.stepsOf(input.kind, input.option, input.move, input.rebuild)
    const journaled = input.journal?.option === input.option ? Math.min(input.journal.done, steps.length) : 0
    // The diverged files are reported only by put-back; a resume past it would settle without them.
    const putBack = steps.indexOf('put-back')
    const from = putBack >= 0 && journaled > putBack ? putBack : journaled
    for (let index = from; index < steps.length; index += 1) {
      const step = steps[index]
      let done: StepResult
      try {
        done = await this.run(step, input)
      } catch (error) {
        done = SvnConflictResolutions.heldOf(error, input) ?? { ok: false, code: 'io-failed', detail: ErrorText.of(error) }
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

  private static treeStepsOf(option: SvnConflictOption, move: SvnConflictApply['move']): SvnConflictStepName[] {
    switch (option) {
      case 'keep-both': return SvnConflictResolutions.keepBothStepsOf(move)
      case 'take-incoming': return ['save-local', 'remove-saved', 'revert-incoming']
      case 'keep-mine': return ['save-sidecars', 'accept-working']
      case 'merged': return ['save-sidecars', 'accept-working']
      case 'union': throw new Error('A tree conflict has no union')
      default: throw new Error(`Unknown conflict option: ${JSON.stringify(option satisfies never)}`)
    }
  }

  private static keepBothStepsOf(move: SvnConflictApply['move']): SvnConflictStepName[] {
    switch (move) {
      case undefined: return ['save-local', 'remove-saved', 'revert-incoming', 'put-back', 'accept-working']
      case 'away': return ['save-sidecars', 'accept-mine-conflict']
      case 'incoming': return ['save-sidecars', 'accept-incoming-move']
      default: throw new Error(`Unknown move: ${JSON.stringify(move satisfies never)}`)
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
    if (unsafe.length > 0) return `svn cannot take the names ${unsafe.join(', ')} below ${input.path}; resolve it in an SVN client`
    if (input.kind === 'tree' && (input.option === 'take-incoming' || input.option === 'keep-both')) {
      const info = await this.svnIn(input.root, ['info', '--xml', '--depth', 'empty', '--', `${input.path}@`])
      // svn's move of the session's edit removes the old place, so a resume after it finds no node there.
      if (!info.ok) return input.move === 'incoming' && SvnConflictResolutions.nodeNotFoundConst.test(info.detail) ? null : info.detail
      const entry = SvnConflictFacts.infoConflicts(info.value)[0]
      if (entry?.tree?.operation === 'merge') return 'A merge keeps the target BASE; edit this tree conflict and mark it resolved instead of reverting to incoming'
      if (entry?.tree?.reason === 'moved-away' && (input.move !== 'away' || input.option !== 'keep-both'))
        return 'A moved-away conflict requires a refreshed review and Keep both to merge into the move destination'
      if (input.move === 'incoming' && entry?.tree !== undefined && entry.tree !== null
        && (entry.tree.reason !== 'edited' || entry.tree.action !== 'deleted' || entry.tree.localKind !== 'file'))
        return `${input.path} is no file the other commit moved; read the conflicts again`
    }
    return null
  }

  private async run(step: SvnConflictStepName, input: SvnConflictApply): Promise<StepResult> {
    switch (step) {
      case 'save-local': return this.saveLocal(input)
      case 'remove-saved': return this.removeSaved(input)
      case 'revert-incoming': return SvnConflictResolutions.none(await this.svnIn(input.root, ['revert', '-R', '--', `${input.path}@`]))
      case 'put-back': return this.putBack(input)
      case 'restore-saved': return this.restoreSaved(input)
      case 'save-sidecars': return this.saveSidecars(input)
      case 'write-merged':
        await new SvnTextResolution(this.svn, this.afterFilesChanged).writeMerged(input)
        return SvnConflictResolutions.nothingDiverged()
      case 'no-markers': return this.noMarkers(input)
      case 'union-properties': return this.unionProperties(input)
      case 'accept-working': return this.accept(input, 'working')
      case 'accept-theirs-full': return this.accept(input, 'theirs-full')
      case 'accept-mine-full': return this.accept(input, 'mine-full')
      case 'accept-mine-conflict': return this.accept(input, 'mine-conflict')
      case 'accept-incoming-move': return this.incomingMove(input)
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
    let changed = false
    try {
      for (const path of await SvnConflictResolutions.filesUnder(input.root, input.path)) {
        const file = SvnConflictResolutions.absolute(input.root, path)
        if (await SvnConflictResolutions.sameBytes(file, SvnConflictResolutions.absolute(input.savedDir, path))) {
          await rm(file, { force: true })
          changed = true
        }
      }
    } finally { if (changed) await this.afterFilesChanged?.(input.root) }
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
    let changed = false
    try {
      for (const path of saved) {
        const target = SvnConflictResolutions.absolute(input.root, path)
        if (await SvnConflictResolutions.exists(target)) continue
        await mkdir(dirname(target), { recursive: true })
        await SvnConflictResolutions.atomicCopy(SvnConflictResolutions.absolute(input.savedDir, path), target)
        changed = true
      }
    } finally { if (changed) await this.afterFilesChanged?.(input.root) }
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
    await SvnConflictResolutions.atomicCopy(saved, SvnConflictResolutions.absolute(input.root, input.path))
    await this.afterFilesChanged?.(input.root)
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
    const prej = entry === undefined ? [] : SvnConflictFacts.prejOf(entry, cwd, entry.property && entry.sidecars.prej === null ? await readdir(cwd) : [])
    const sidecars = entry === undefined ? [] : [entry.sidecars.older, entry.sidecars.mine, entry.sidecars.theirs, ...prej]
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
    const info = await this.svnIn(input.root, ['info', '--xml', '--depth', 'empty', '--', target])
    if (!info.ok) return info
    const sources = SvnConflictFacts.infoConflicts(info.value)[0]?.propertySources ?? null
    for (const name of names) {
      const mine = await this.propertyIn(input.root, name, [], target)
      if (!mine.ok) return mine
      const theirs = sources === null ? await this.propertyIn(input.root, name, ['-r', 'BASE'], target)
        : sources.theirs === null ? { ok: true as const, value: '' }
        : await this.propertyIn(input.root, name, ['-r', String(sources.theirs.revision)], `${sources.theirs.url}@${sources.theirs.revision}`)
      if (!theirs.ok) return theirs
      let value: string
      if (name === 'svn:mergeinfo') value = SvnConflictResolutions.mergeinfoUnion(mine.value, theirs.value)
      else if (sources === null && input.baseRevision === undefined) return { ok: false, code: 'refused', detail: `the merge of ${name} needs its value before the update` }
      else {
        const older = sources === null ? await this.propertyIn(input.root, name, ['-r', String(input.baseRevision)], target)
          : sources.older === null ? { ok: true as const, value: '' }
          : await this.propertyIn(input.root, name, ['-r', String(sources.older.revision)], `${sources.older.url}@${sources.older.revision}`)
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

  /**
   * Take incoming of a property conflict that shares its path with a text conflict: each conflicted
   * property set to the value the other commit gave it (the new BASE of an update, source-right of a
   * merge), or deleted where that commit has none, so `--accept working` keeps it.
   */
  private async incomingProperties(input: SvnConflictApply): Promise<StepResult> {
    const names = input.properties ?? []
    if (names.length === 0)
      return { ok: false, code: 'refused', detail: `Jamat could not tell which properties of ${input.path} conflict; resolve them in an SVN client such as TortoiseSVN, then check again` }
    const target = `${input.path}@`
    const info = await this.svnIn(input.root, ['info', '--xml', '--depth', 'empty', '--', target])
    if (!info.ok) return info
    const sources = SvnConflictFacts.infoConflicts(info.value)[0]?.propertySources ?? null
    for (const name of names) {
      const theirs = sources === null ? await this.propertyOrNull(input.root, name, ['-r', 'BASE'], target)
        : sources.theirs === null ? { ok: true as const, value: null }
        : await this.propertyOrNull(input.root, name, ['-r', String(sources.theirs.revision)], `${sources.theirs.url}@${sources.theirs.revision}`)
      if (!theirs.ok) return theirs
      if (theirs.value === null) {
        const deleted = await this.svnIn(input.root, ['propdel', name, '--', target])
        if (!deleted.ok) return deleted
        continue
      }
      const file = join(dirname(input.savedDir), `incoming-${createHash('sha1').update(`${input.path}\n${name}`).digest('hex')}.txt`)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, theirs.value)
      const set = await this.svnIn(input.root, ['propset', name, '-F', file, '--', target])
      await rm(file, { force: true })
      if (!set.ok) return set
    }
    return SvnConflictResolutions.nothingDiverged()
  }

  /**
   * Only while svn still marks the path, so a repeat after a done resolve does nothing. svn resolves
   * every kind of a path at once, so a property option on a path that also has a text conflict sets
   * its own side (the incoming values for take-incoming) and accepts the working copy, which keeps the
   * text as it stands; a held option stops before the resolve, while svn still marks the other kind.
   */
  private async accept(input: SvnConflictApply, accept: 'working' | 'theirs-full' | 'mine-full' | 'mine-conflict'): Promise<StepResult> {
    const text = new SvnTextResolution(this.svn, this.afterFilesChanged)
    if (input.kind === 'text' && (accept === 'mine-full' || accept === 'theirs-full'))
      await text.choose(input, accept === 'mine-full' ? 'mine' : 'theirs')
    const status = await this.svnIn(input.root, ['status', '--xml', '--depth', 'empty', '--', `${input.path}@`])
    if (!status.ok) return status
    const row = SvnConflictFacts.conflictedRows(status.value, input.root).find((candidate) => candidate.path === input.path)
    if (row === undefined) return SvnConflictResolutions.nothingDiverged()
    let resolveWith = accept
    if (input.kind === 'property' && row.text) {
      if (accept === 'theirs-full') {
        const taken = await this.incomingProperties(input)
        if (!taken.ok) return taken
      }
      else if (accept === 'mine-conflict') throw new Error('A property conflict has no mine-conflict')
      resolveWith = 'working'
    }
    if (input.held === true && (input.kind === 'text' ? row.property : input.kind === 'property' && row.text))
      return SvnConflictResolutions.nothingDiverged()
    const resolved = input.kind === 'text' ? await text.resolve(input.root, input.path)
      : await this.svnIn(input.root, ['resolve', '--accept', resolveWith, '--', `${input.path}@`])
    const scope = await SvnTextResolution.rootOf(input.root, input.path)
    const checked = await this.svnIn(scope, ['status', '--xml', '--ignore-externals', '--', '.'])
    if (!checked.ok) return resolved.ok ? checked : resolved
    // A resolve stopped inside its work queue leaves the working copy locked; svn's own words stay in the step's log.
    if (SvnWorktreeEvidence.lockedPaths(checked.value, scope).length > 0) {
      const held = SvnTextResolution.heldIn(input.root, resolved.ok ? resolved.value : resolved.detail)
      return { ok: false, code: 'locked', detail: `${held === null ? 'SVN' : `${held} is open in another program, so SVN`} could not finish settling ${input.path} `
        + `and the working copy stays locked. Close ${held === null ? 'any program that holds one of its files' : 'that program'}, `
        + 'then choose the option again or press Check again; Jamat finishes its own SVN step first.' }
    }
    if (!resolved.ok) return resolved
    if (SvnWorktreeEvidence.statusRows(checked.value, scope).some((row) => PathCompare.comparable(join(scope, row.path)) === PathCompare.comparable(join(input.root, input.path)) && row.conflict))
      return { ok: false, code: 'locked', detail: 'Conflict settlement is incomplete. Release file holders and retry this option.' }
    return SvnConflictResolutions.nothingDiverged()
  }

  /**
   * svn's recommended resolution of a local edit against an incoming delete is the merge into the
   * one place the other commit moved the file to, and it then removes the old place; with no move, or
   * more than one candidate, svn recommends nothing, exits 0 and leaves the conflict (the spike).
   */
  private async incomingMove(input: SvnConflictApply): Promise<StepResult> {
    const marked = async (): Promise<SvnResult<boolean>> => {
      const status = await this.svnIn(input.root, ['status', '--xml', '--depth', 'empty', '--', `${input.path}@`])
      return status.ok ? { ok: true, value: SvnWorktreeEvidence.statusRows(status.value, input.root).some((row) => row.path === input.path && row.conflict) } : status
    }
    const before = await marked()
    if (!before.ok) return before
    if (!before.value) return SvnConflictResolutions.nothingDiverged()
    const resolved = await this.svnIn(input.root, ['resolve', '--accept', 'recommended', '--', `${input.path}@`])
    if (!resolved.ok) return resolved
    const after = await marked()
    if (!after.ok) return after
    if (after.value)
      return { ok: false, code: 'refused', detail: `svn found no single place where the other commit moved ${input.path}; nothing changed. Carry the session's changes there by hand, then take incoming` }
    return SvnConflictResolutions.nothingDiverged()
  }

  /** `cleanup` false: a main copy, where a lock is refused for the person and no svn cleanup runs. */
  async recoveredChoice(input: Pick<SvnConflictApply, 'root' | 'path' | 'savedDir' | 'kind' | 'journal' | 'actionId' | 'occurrenceId'>): Promise<'keep-mine' | 'take-incoming' | null> {
    return SvnTextResolution.recoveredChoice(input)
  }

  async recoverLocked(root: string, savedDir: string, _actionId?: string, _occurrences: readonly string[] = [], target?: string, cleanup = true): Promise<SvnResult<void>> {
    if (target !== undefined) root = await SvnTextResolution.rootOf(root, target)
    const args = ['status', '--xml', ...target === undefined ? [] : ['--ignore-externals'], '--', '.']
    const status = await this.svnIn(root, args)
    if (!status.ok) return status
    const locked = SvnWorktreeEvidence.lockedPaths(status.value, root)
    if (locked.length === 0) return { ok: true, value: undefined }
    if (!cleanup)
      return { ok: false, code: 'locked', detail: `The main copy ${root} is locked, and Jamat runs no svn cleanup in a main copy. `
        + 'Close every program that works in it, run Cleanup there in TortoiseSVN, then choose the option again.' }
    const recovered = await new SvnTextResolution(this.svn, this.afterFilesChanged).recover(root, locked, savedDir, this.now())
    if (!recovered.ok) return recovered
    const checked = await this.svnIn(root, args)
    if (!checked.ok) return checked
    return SvnWorktreeEvidence.lockedPaths(checked.value, root).length === 0 ? { ok: true, value: undefined }
      : { ok: false, code: 'locked', detail: 'The working copy remains locked; release file holders and retry the conflict option' }
  }

  /**
   * A file another program holds open (Windows answers EBUSY, or EPERM and EACCES, which a read-only
   * file gives too) is no svn failure: the person closes it and chooses again, and the journal resumes.
   * The worktree file the error names is shown, else the conflicted path.
   */
  private static heldOf(error: unknown, input: SvnConflictApply): { ok: false; code: 'locked'; detail: string } | null {
    const code = ErrnoCode.of(error)
    if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') return null
    // A code proves an object; the paths of a node: error are optional fields on it.
    const { path: source, dest } = error as { path?: unknown; dest?: unknown }
    const named = [source, dest].find((value): value is string => typeof value === 'string' && PathCompare.isInside(input.root, value)
        && !SvnWorktreeEvidence.relativeTo(input.root, value).split('/').includes('.svn'))
    const path = named === undefined ? input.path : SvnWorktreeEvidence.relativeTo(input.root, named)
    return { ok: false, code: 'locked', detail: code === 'EBUSY' ? `${path} is open in another program; close it and choose the option again`
      : `${path} is open in another program or read-only; close it or clear its read-only attribute, then choose the option again` }
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
    const read = await this.propertyOrNull(root, name, revision, target)
    return read.ok ? { ok: true, value: read.value ?? '' } : read
  }

  /** A property's value, or null where svn says the node does not have it. */
  private async propertyOrNull(root: string, name: string, revision: string[], target: string): Promise<SvnResult<string | null>> {
    const read = await this.svnIn(root, ['propget', name, '--no-newline', ...revision, '--', target])
    return !read.ok && SvnConflictResolutions.propertyNotFoundConst.test(read.detail) ? { ok: true, value: null } : read
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
    await SvnConflictResolutions.atomicCopy(from, to)
  }

  private static async atomicCopy(from: string, to: string): Promise<void> {
    const temporary = `${to}.jamat-${randomUUID()}.tmp`
    try {
      await copyFile(from, temporary)
      await rename(temporary, to)
    } finally { await rm(temporary, { force: true }) }
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
