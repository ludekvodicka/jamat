import { lstat, mkdir, readdir, readFile, readlink, realpath } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

import { ErrnoCode } from '../../shared/errnoCode'
import { ErrorText } from '../../shared/errorText'
import { PathCompare } from '../../shared/pathCompare'
import { AtomicJsonFile } from '../../shared/atomicJsonFile'
import { SessionWorkingDirectory } from '../../sessionManager/sessionWorkingDirectory'
import type { WorktreeRemovalPermit } from './worktreeRemovalPermit'
import { WorktreeContentCopy } from './worktreeContentCopy'
import { type WorktreeHolderLookup, WorktreeFileHolders } from './worktreeFileHolders'
import type { WorktreeResultsStore } from '../results/worktreeResultsStore'
import type { TreeRemovalHeld, TreeRemovalProgress } from '../../shared/treeRemoval'
import type { SvnWorktreeLocation } from '../../svn/svn.types'
import type { SvnWorktreeManager } from '../../svn/svnWorktreeManager'
import type { SessionRecord, SessionRecordWorktree } from '../../sessionManager/worktreeSessionRecords'
import type { SessionRecordsStore } from '../../sessionManager/worktreeSessionRecords'
import type { SvnFinishWorktreeResult } from '../../sessionManager/sessionManagerApi.types'
import type { SessionSteps } from '../../sessionManager/worktreeSessionRuntime'
import type { SessionStepRemovalPhase } from '../../sessionManager/worktreeSessionRuntime'

/** The disk writes a removal makes, named so a test can hand them a scripted set. */
export type SvnRemovalPort = Pick<SvnWorktreeManager, 'renameAside' | 'purgeAside' | 'removeEmptyWorktreesDir' | 'removalStatus' | 'removalSource'>

export interface SvnWorktreeRemovalDeps {
  records: SessionRecordsStore
  svn: SvnRemovalPort
  /** The queue reopen and restart run on, so a removal never races one. */
  onQueue: <T>(work: () => Promise<T>) => Promise<T>
  /** The record moved outside an operation, so the snapshot is composed again. */
  changed: () => void
  /** Each phase of the removal is the session's step; its caller clears the step where its work ends. */
  steps: Pick<SessionSteps, 'at'>
  now?: () => number
  skillRoots: readonly string[]
  results: Pick<WorktreeResultsStore, 'savedDirectoryOf'>
  /** Names the programs holding a file when Windows refuses a rename or a delete; Restart Manager by default. */
  holders?: Pick<WorktreeFileHolders, 'below'>
}

export interface SvnWorktreeRemoved {
  state: SvnFinishWorktreeResult
  lines: string[]
  blocked?: true
}

/**
 * The removal of an SVN worktree by identity, shared by an SVN action and the cleanup after the
 * session's end. This client's own handles are released, the worktree is renamed aside (a holder
 * makes that fail, and then the worktree stays whole), the rest is purged, and the record keeps a
 * tombstone. The rename runs on the operation queue after a re-read, so a reopen that won the race
 * keeps its directory.
 */
export class SvnWorktreeRemoval {
  private static readonly heldCodesConst = ['EPERM', 'EBUSY', 'EACCES']
  private readonly skillRoots: readonly string[]
  private readonly results: Pick<WorktreeResultsStore, 'savedDirectoryOf'>
  private readonly holders: Pick<WorktreeFileHolders, 'below'>
  private readonly copies = new WorktreeContentCopy()
  private readonly records: SessionRecordsStore
  private readonly svn: SvnRemovalPort
  private readonly onQueue: <T>(work: () => Promise<T>) => Promise<T>
  private readonly changed: () => void
  private readonly steps: Pick<SessionSteps, 'at'>
  private readonly now: () => number

  constructor(deps: SvnWorktreeRemovalDeps) {
    this.skillRoots = deps.skillRoots
    this.results = deps.results
    this.holders = deps.holders ?? new WorktreeFileHolders()
    this.records = deps.records
    this.svn = deps.svn
    this.onQueue = deps.onQueue
    this.changed = deps.changed
    this.steps = deps.steps
    this.now = deps.now ?? (() => Date.now())
  }

  /** `revisions` (`<repository URL>:r<N>`) join those of the last outcome in the tombstone. */
  async remove(sessionId: string, location: SvnWorktreeLocation, revisions: readonly string[], permit: WorktreeRemovalPermit, actionId: string): Promise<SvnWorktreeRemoved> {
    const path = location.worktreePath
    this.steps.at(sessionId, { kind: 'removal', phase: 'queue', path })
    let blocked: string[] = []
    let copyLines: string[] = []
    let resumed: { resumed?: true } = {}
    let saved = ''
    // Set once the worktree lies aside, so a refusal from there on says where it lies and what is saved.
    let aside: { root: string; stage: 'copy' | 'remainder' } | null = null
    let failure: unknown = null
    const renamed = await this.onQueue(async () => {
      const now = this.records.get(sessionId)
      if (!now || now.life === 'live' || now.life === 'starting' || now.pendingOperationId !== undefined) return null
      const holders = this.records.list().filter((record) => (record.life === 'live' || record.life === 'starting')
        && PathCompare.isInside(path, SessionWorkingDirectory.ofRecord(record)))
      if (holders.length > 0) { blocked = [`live sessions still have their working directory inside: ${holders.map((record) => record.sessionId).join(', ')}`]; return null }
      try {
        const links = await this.linksInto(path)
        if (links.length > 0) { blocked = [`global skill links still target the worktree: ${links.join(', ')}`]; return null }
        const source = await this.svn.removalSource(location)
        if (!source.ok) { blocked = [source.detail]; return null }
        location = { ...location, directoryId: location.directoryId ?? source.value.directoryId }
        const identity = location.directoryId ?? location.worktreePath
        // Without an aside no copy of this rename exists yet, so the copy belongs to the action that renames.
        const preservationActionId = source.value.aside
          ? now.worktree?.preservationActionId ?? await this.legacyPreservation(identity, actionId, source.value.path) ?? actionId
          : actionId
        if (now.worktree?.preservationActionId !== preservationActionId || now.worktree.directoryId !== location.directoryId) {
          if (!await this.records.update(sessionId, (current) => current.worktree === undefined ? null
            : { ...current, worktree: { ...current.worktree, directoryId: location.directoryId, preservationActionId } }))
            throw new Error('The worktree changed before its removal identity could be saved')
        }
        let root = source.value.path
        if (source.value.aside) resumed = { resumed: true }
        const destination = dirname(this.results.savedDirectoryOf(preservationActionId))
        saved = destination
        const intentFile = join(destination, 'removal-copy.json')
        let intent: { identity: string; stage: 'copy' | 'purge'; attempts: number } | null = await readFile(intentFile, 'utf8')
          .then((text) => JSON.parse(text)).catch((error: unknown) => { if (ErrnoCode.of(error) === 'ENOENT') return null; throw error })
        if (intent !== null && (intent.identity !== identity || !['copy', 'purge'].includes(intent.stage)
          || !Number.isSafeInteger(intent.attempts) || intent.attempts < 0)) throw new Error('Invalid removal copy intent; keep the worktree for inspection')
        const remainder = source.value.aside && intent?.stage !== 'copy'
        const status = remainder
          ? { ok: true as const, value: [{ path: '.', kind: 'clean' as const, conflict: false, ignored: false }] }
          : await this.svn.removalStatus(root)
        if (!status.ok) { blocked = [status.detail]; return null }
        if (permit.kind === 'clean') {
          // A reverted setup path must still be clean; an allowlist is no proof of its latest bytes.
          blocked = status.value.filter((row) => !row.ignored
            && !(row.unversioned && WorktreeContentCopy.waste(row.path))
            && (row.conflict || row.kind !== 'clean' && row.kind !== 'external'))
            .map((row) => `changed after the check: ${row.path}`)
          if (blocked.length > 0) return null
        }
        else if (permit.kind !== 'discard') throw new Error(`Unknown removal permit: ${JSON.stringify(permit satisfies never)}`)
        if (!source.value.aside) {
          intent = { identity, stage: 'copy', attempts: 0 }
          await mkdir(destination, { recursive: true })
          await AtomicJsonFile.writeAsync(intentFile, intent)
        }
        this.steps.at(sessionId, { kind: 'removal', phase: 'rename', path, ...resumed })
        const renamed = await this.svn.renameAside(location)
        if (!renamed.ok || renamed.value !== 'renamed') return renamed
        const moved = await this.svn.removalSource(location)
        if (!moved.ok) { blocked = [moved.detail]; return null }
        root = moved.value.path
        aside = { root, stage: remainder ? 'remainder' : 'copy' }
        if (intent?.stage === 'copy') {
          intent = { ...intent, attempts: intent.attempts + 1 }
          await AtomicJsonFile.writeAsync(intentFile, intent)
        }
        this.steps.at(sessionId, { kind: 'removal', phase: 'copy', path, ...resumed })
        const copied = await this.copies.copy(root, status.value, permit, destination, remainder, identity)
        const latest = remainder ? status : await this.svn.removalStatus(root)
        if (!latest.ok) { blocked = [latest.detail]; return null }
        if (JSON.stringify(latest.value) !== JSON.stringify(status.value)) { blocked = ['changed after the copy: svn status']; return null }
        await this.copies.verify(root, copied, permit)
        await AtomicJsonFile.writeAsync(intentFile, { identity, stage: 'purge', attempts: intent?.attempts ?? 0 })
        if (copied.ignored > 0 || copied.discarded > 0 || copied.bundle || copied.links > 0)
          copyLines = [`COPIED: ${copied.ignored} ignored files, ${copied.discarded} discarded files${copied.bundle ? ', checkpoint bundle' : ''}${copied.links > 0 ? `, ${copied.links} link descriptions in copy-manifests` : ''} to ${destination} (copy ${copied.attempt})`]
        return renamed
      } catch (error) { blocked = [ErrorText.of(error)]; failure = error; return null }
    })
    if (blocked.length > 0)
      return { state: 'kept', blocked: true, lines: [...blocked.map((reason) => `KEPT: ${reason}`), ...await this.asideLines(aside, saved, failure, blocked)] }
    if (renamed === null) return { state: 'kept', lines: [`KEPT: session ${sessionId} runs again, so ${path} stays`] }
    if (!renamed.ok) return { state: 'kept', lines: [...copyLines, `ERROR: ${renamed.detail}; the worktree is kept`] }
    if (typeof renamed.value === 'object')
      return { state: 'in-use', lines: [...copyLines, `REMOVAL BLOCKED (${renamed.value.blocked}): ${renamed.value.path}. ${renamed.value.detail}`,
        ...SvnWorktreeRemoval.renameHeldLines(await this.holders.below(renamed.value.path), renamed.value.path)] }
    else if (renamed.value === 'in-use')
      return { state: 'in-use', lines: [...copyLines, `IN USE: ${path} (a process has its working directory or an open file there; the worktree is kept)`] }
    else if (renamed.value !== 'renamed' && renamed.value !== 'absent')
      throw new Error(`Unknown rename result: ${JSON.stringify(renamed.value satisfies never)}`)
    const deleting = `${path}.deleting`
    // The last file a program held, and one holder lookup per held path while the purge runs.
    let held: TreeRemovalHeld | null = null
    let purging = true
    const lookups = new Map<string, Promise<WorktreeHolderLookup>>()
    const named = new Map<string, string>()
    const report = (progress: TreeRemovalProgress): void => {
      const facts = { kind: 'removal' as const, phase: SvnWorktreeRemoval.phaseOf(progress.phase), path, ...resumed }
      const count = { done: progress.done, total: progress.total }
      const refused = progress.held
      if (refused === undefined) { this.steps.at(sessionId, facts, count); return }
      held = refused
      if (!lookups.has(refused.path)) {
        const lookup = this.holders.below(refused.path)
        lookups.set(refused.path, lookup)
        // The names arrive seconds later; a purge that ended meanwhile owns no step any more.
        void lookup.then((found) => {
          if (found.kind === 'found') named.set(refused.path, WorktreeFileHolders.holdersOf(found.files.flatMap((file) => file.holders)))
          if (purging && held === refused) report(progress)
        })
      }
      this.steps.at(sessionId, { ...facts, held: { file: WorktreeFileHolders.nameOf(refused.path, deleting), code: refused.code,
        holders: named.get(refused.path) ?? null, attempt: refused.attempt, attempts: refused.attempts,
        everySeconds: Math.round(refused.delayMilliseconds / 1_000) } }, count)
    }
    const purged = await this.svn.purgeAside(location, report).finally(() => { purging = false })
    if (!purged.ok || purged.value === 'undeleted') {
      const last = held as TreeRemovalHeld | null
      const lookup = last === null ? null : await lookups.get(last.path) ?? null
      return {
        state: 'undeleted',
        lines: [...copyLines, `ERROR: ${deleting} is left half deleted${purged.ok ? '' : ` (${purged.detail})`}.`,
          ...SvnWorktreeRemoval.purgeHeldLines(last, lookup, deleting, saved)],
      }
    }
    const recreated = await SvnWorktreeRemoval.recreatedLines(path)
    this.steps.at(sessionId, { kind: 'removal', phase: 'tombstone', path })
    await this.svn.removeEmptyWorktreesDir(location.ownerDir)
    await this.onQueue(() => this.records.update(sessionId, (current) => {
      const caller = current.worktree?.caller ?? current.retiredWorktree?.caller
      const directoryId = location.directoryId ?? current.retiredWorktree?.directoryId
      const next: SessionRecord = {
        ...current,
        retiredWorktree: {
          worktreePath: path,
          kind: 'svn',
          revisions: SvnWorktreeRemoval.joined(current.worktreeOutcome?.revisions ?? [], revisions),
          removedAt: this.now(),
          ownerDir: location.ownerDir,
          ...directoryId === undefined ? {} : { directoryId },
          ...caller === undefined ? {} : { caller },
        },
        completed: true,
      }
      if (next.pendingSetup?.agreement !== undefined) {
        next.endedReason = 'Setup cancelled; worktree removed'
        next.stopRequested = true
      }
      delete next.pendingSetup
      delete next.worktree
      delete next.worktreeCleanup
      return next
    }))
    this.changed()
    return { state: 'removed', lines: [...copyLines, '   worktree removed', ...recreated] }
  }

  /** The lines a durable result keeps of a removal: what it saved, and an original path written again. */
  static resultLinesOf(lines: readonly string[]): string[] {
    return lines.filter((line) => line.startsWith('COPIED:') || line.startsWith('RECREATED:'))
  }

  /**
   * After the rename a refusal says where the worktree lies and what its saved copy holds, names the
   * program holding a file the copy could not read, and ends with the button that resumes (UA1-J11-4).
   */
  private async asideLines(aside: { root: string; stage: 'copy' | 'remainder' } | null, saved: string, failure: unknown, reasons: readonly string[]): Promise<string[]> {
    if (aside === null) return []
    const refused = (failure as { path?: unknown } | null)?.path
    const code = ErrnoCode.of(failure)
    const heldLines = typeof refused === 'string' && code !== null && SvnWorktreeRemoval.heldCodesConst.includes(code) && PathCompare.isInside(aside.root, refused)
      ? await this.holders.below(refused).then((lookup) => lookup.kind === 'found' ? WorktreeFileHolders.linesOf(lookup, aside.root) : [])
      : []
    let state: string
    if (aside.stage === 'copy') state = `The worktree now lies at ${aside.root}; nothing of it was deleted, and its saved copy in ${saved} is incomplete.`
    else if (aside.stage === 'remainder') state = `The partly deleted worktree lies at ${aside.root}; nothing more of it was deleted.`
    else throw new Error(`Unknown removal stage: ${JSON.stringify(aside.stage satisfies never)}`)
    return [...heldLines, reasons.some((reason) => reason.includes('press Try again')) ? state : `${state} Remove the cause, then press Try again.`]
  }

  private static renameHeldLines(lookup: WorktreeHolderLookup, worktree: string): string[] {
    const kept = `The worktree stays whole at ${worktree}; publication receipts are retained.`
    const kind = lookup.kind
    if (kind === 'found') return [...WorktreeFileHolders.linesOf(lookup, worktree), `${kept} Close the programs named above, then press Try again.`]
    else if (kind === 'none')
      return ['Windows names no program with a file open in the worktree; a terminal, dev server or editor may have its working directory there. '
        + `Close it, then press Try again. ${kept}`]
    else if (kind === 'unavailable')
      return [`Jamat could not name the program (${lookup.reason}). Close dev servers, terminals or other programs using the worktree, then press Try again. ${kept}`]
    else throw new Error(`Unknown holder lookup: ${JSON.stringify(kind satisfies never)}`)
  }

  private static purgeHeldLines(held: TreeRemovalHeld | null, lookup: WorktreeHolderLookup | null, deleting: string, saved: string): string[] {
    const retained = `The verified saved copy in ${saved} is retained.`
    if (held === null || lookup === null) return [`Close the programs holding files there, then press Try again. ${retained}`]
    const file = WorktreeFileHolders.nameOf(held.path, deleting)
    const kind = lookup.kind
    if (kind === 'found') return [...WorktreeFileHolders.linesOf(lookup, deleting), `Close the programs named above, then press Try again. ${retained}`]
    else if (kind === 'none') return [`HELD: ${file} (${held.code}); Windows names no program holding it.`, `Close the program using it, then press Try again. ${retained}`]
    else if (kind === 'unavailable')
      return [`HELD: ${file} (${held.code}); Jamat could not name the program (${lookup.reason}).`, `Close the program using it, then press Try again. ${retained}`]
    else throw new Error(`Unknown holder lookup: ${JSON.stringify(kind satisfies never)}`)
  }

  /**
   * A process that writes by absolute path can make the original path again after the rename
   * (R4-RM3, Jamat#55). That directory is no worktree of this session: it is named, never deleted.
   */
  private static async recreatedLines(path: string): Promise<string[]> {
    const info = await lstat(path).catch((error: unknown) => { if (ErrnoCode.of(error) === 'ENOENT') return null; throw error })
    if (info === null) return []
    let what = 'a file'
    if (info.isDirectory()) {
      const files = (await readdir(path, { recursive: true, withFileTypes: true }).catch(() => []))
        .filter((entry) => !entry.isDirectory()).map((entry) => relative(path, join(entry.parentPath, entry.name))).sort()
      what = files.length === 0 ? 'an empty folder' : `holds ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` and ${files.length - 3} more` : ''}`
    }
    return [`RECREATED: the original path was created again after removal: ${path} (${what}); Jamat left it in place. `
      + 'Find the program that writes there, then move or delete that folder yourself.']
  }

  private async legacyPreservation(identity: string, actionId: string, aside: string): Promise<string | null> {
    const root = dirname(dirname(this.results.savedDirectoryOf(actionId)))
    const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    const candidates: string[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[A-Za-z0-9_-]{1,128}$/.test(entry.name)) continue
      const saved = await readFile(join(root, entry.name, 'removal-copy.json'), 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (saved !== null && JSON.parse(saved).identity === identity) candidates.push(entry.name)
    }
    if (candidates.length > 1)
      throw new Error(`Several preservation attempts name ${aside}: ${candidates.map((name) => join(root, name, 'removal-copy.json')).join(', ')}. `
        + 'Their saved copies stay for inspection. Copy what you need from the aside, delete it, then press Try again.')
    return candidates[0] ?? null
  }

  private async linksInto(worktree: string): Promise<string[]> {
    const links: string[] = []
    for (const root of this.skillRoots) {
      const names = await readdir(root).catch((error: unknown) => {
        if (ErrnoCode.of(error) === 'ENOENT') return []
        throw error
      })
      for (const name of names) {
        const link = join(root, name)
        if (!(await lstat(link)).isSymbolicLink()) continue
        const target = resolve(dirname(link), await readlink(link))
        const physical = await realpath(link).catch((error: unknown) => {
          if (ErrnoCode.of(error) === 'ENOENT') return target
          throw error
        })
        const physicalRoot = await realpath(worktree).catch((error: unknown) => {
          if (ErrnoCode.of(error) === 'ENOENT') return worktree
          throw error
        })
        if (PathCompare.isInside(worktree, target) || PathCompare.isInside(physicalRoot, physical)) links.push(link)
      }
    }
    return links
  }

  private static phaseOf(phase: TreeRemovalProgress['phase']): SessionStepRemovalPhase {
    if (phase === 'counting') return 'count'
    else if (phase === 'deleting') return 'delete'
    else throw new Error(`Unknown tree removal phase: ${JSON.stringify(phase satisfies never)}`)
  }

  static locationOf(worktree: SessionRecordWorktree): SvnWorktreeLocation {
    return {
      worktreePath: worktree.worktreePath,
      ownerDir: worktree.repositoryRoot,
      url: worktree.branch,
      ...worktree.directoryId === undefined ? {} : { directoryId: worktree.directoryId },
    }
  }

  /** Two lists of `<repository>:r<N>`, once each, by repository and number; a hand-edited entry sorts by its text. */
  static joined(earlier: readonly string[], later: readonly string[]): string[] {
    const keyOf = (entry: string): [string, number] => {
      const match = /^(.*):r(\d+)$/.exec(entry)
      return match === null ? [entry, 0] : [match[1], Number(match[2])]
    }
    return [...new Set([...earlier, ...later])].sort((a, b) => {
      const [left, right] = [keyOf(a), keyOf(b)]
      return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : left[1] - right[1]
    })
  }
}
