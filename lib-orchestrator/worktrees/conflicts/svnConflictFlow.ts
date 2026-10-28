import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { ErrnoCode } from '../../shared/errnoCode'
import { PathCompare } from '../../shared/pathCompare'
import { SvnCommitGate } from '../../svn/svnCommitGate'

import type { SvnConflictApply, SvnConflictFact, SvnConflictJournal, SvnConflictKind, SvnConflictOption, SvnConflictRead, SvnErrorCode, SvnItemRow, SvnResult } from '../../svn/svn.types'
import type { SvnConflictResolutions } from '../../svn/svnConflictResolutions'
import { SvnConflictShapes } from '../../svn/svnConflictShapes'
import type { SvnWorktreeManager } from '../../svn/svnWorktreeManager'
import type { SessionRecord, SessionRecordConflictMemory, SvnActionConflictEntry, SvnActionConflictSet, SessionRecordSvnAction } from '../../sessionManager/worktreeSessionRecords'
import type { WorktreeResultsStore } from '../results/worktreeResultsStore'
import type { ScriptLogStore } from '../../sessionManager/worktreeSessionScripts'
import type {
  SessionsOpResult,
  SvnActionNeed,
  SvnConflictActor,
  SvnConflictResolveRequest,
  SvnConflictState,
} from '../../sessionManager/sessionManagerApi.types'
import { SvnConflictGuard, type SvnGuardFinding } from './svnConflictGuard'
import { SvnConflictIdentity } from './svnConflictIdentity'
import { SvnConflictWords } from './svnConflictWords'
import { SvnMergerLauncher } from './svnMergerLauncher'
import type { SvnResolverPort } from './svnResolverLauncher'

export interface SvnConflictFlowDeps {
  svn: Pick<SvnWorktreeManager, 'conflictSet' | 'logOf' | 'changes' | 'hashes' | 'baseAbove'>
  /** The content hashes of the changed paths when a merger starts, kept beside the action's result. */
  handover: Pick<WorktreeResultsStore, 'writeHandover' | 'readHandover'>
  /** Where the merger's brief is written, beside the parent's run logs. */
  briefs: Pick<ScriptLogStore, 'mergeBriefPathOf' | 'writeMergeBrief'>
  /** The one writer that settles a path; it saves first and journals its steps. */
  resolutions: Pick<SvnConflictResolutions, 'apply' | 'recoverLocked'> & Partial<Pick<SvnConflictResolutions, 'recoveredChoice'>>
  /** Where an action's saved copies go: `<worktree-results>/<actionId>/saved`. */
  savedDirectoryOf: (actionId: string) => string
  /** The paths among these whose file still holds a conflict marker line. */
  withMarkers: (root: string, paths: readonly string[]) => Promise<string[]>
  /** Why no Claude merger can run on this machine, or null. */
  unavailable: () => string | null
  cli: SvnResolverPort['cli']
  now: () => number
}

/**
 * What the `fixing` step made of the set; `SvnActionFlow` applies it with an exhaustive switch.
 * `applied`: one rule ran, write it and take the next step; `settled`: nothing open, the Finish goes
 * on; `merge`: paths an agent may settle are open and no merger ran on this set yet, so the merger
 * starts on them; `needs`: the person.
 */
export type SvnConflictStep =
  | { kind: 'applied'; action: SessionRecordSvnAction }
  | { kind: 'settled'; action: SessionRecordSvnAction }
  | { kind: 'merge'; action: SessionRecordSvnAction }
  | { kind: 'needs'; action: SessionRecordSvnAction; need: SvnActionNeed; reason: string }

/** Writes the step an option reached on a conflict (a path and its kind) on the record before the next step starts. */
export type SvnConflictJournalNote = (path: string, journal: SvnConflictJournal, kind: SvnConflictKind) => Promise<void>

/** Called before each option the step runs, so the session's step can name it. */
export type SvnConflictFixing = (fix: { path: string; option: SvnConflictOption; index: number; count: number }) => void

type SvnConflictReadFailure = { ok: false; code: SvnErrorCode; detail: string; set?: SvnActionConflictSet }

/**
 * The conflict set of an SVN action, beside the flow: one read of every conflict an update left,
 * classified once and bounded for the record. Who works on each path is decided here; the flow
 * only applies it.
 */
export class SvnConflictFlow {
  /** The entries a record keeps; the next read takes the rest from svn. */
  static readonly entriesMaxConst = 200
  /** The entries the snapshot and `sessions worktree` carry beside every open one; `sessions conflicts` answers them all. */
  static readonly wireMaxConst = 50
  /** What a reason asks while a path is open: the press drawn on a wait whose step still checks the conflicts. */
  private static readonly checkAgainConst = `press ${SvnConflictWords.checkAgainConst}`
  private readonly svn: SvnConflictFlowDeps['svn']
  private readonly briefs: SvnConflictFlowDeps['briefs']
  private readonly handover: SvnConflictFlowDeps['handover']
  private readonly resolutions: SvnConflictFlowDeps['resolutions']
  private readonly savedDirectoryOf: (actionId: string) => string
  private readonly withMarkers: SvnConflictFlowDeps['withMarkers']
  private readonly unavailable: () => string | null
  private readonly cli: SvnConflictFlowDeps['cli']
  private readonly now: () => number

  constructor(deps: SvnConflictFlowDeps) {
    this.svn = deps.svn
    this.briefs = deps.briefs
    this.handover = deps.handover
    this.resolutions = deps.resolutions
    this.savedDirectoryOf = deps.savedDirectoryOf
    this.withMarkers = deps.withMarkers
    this.unavailable = deps.unavailable
    this.cli = deps.cli
    this.now = deps.now
  }

  /**
   * Every kind, after an update. In a Finish an entry whose facts prove a rule is Jamat's (`rule`), one
   * an agent may settle is the merger's (`agent`) and the rest the person's. An UPDATE of a main copy
   * runs the rules of text and property conflicts (a tree rule moves files of a shared copy aside); the
   * other text conflicts go to its resolver, any other kind makes them all the person's.
   * Its set leaves out the paths svn marked before it started that no other UPDATE of the main copy
   * holds in its set (`updateProtection.before`): they are the person's older work, not conflicts of
   * the revisions it brings.
   */
  async read(action: SessionRecordSvnAction): Promise<SvnResult<SvnActionConflictSet>> {
    const read = await this.svn.conflictSet(action.root, action.baseRevision ?? 0)
    if (!read.ok) return read
    const older = action.kind === 'update-main' ? action.updateProtection?.before ?? [] : []
    const facts = read.value.facts.filter((fact) => !older.includes(fact.path))
    return { ok: true, value: SvnConflictFlow.setOf({ ...read.value, facts }, action.baseRevision ?? 0, this.now(), action.kind === 'finish') }
  }

  async remember(action: SessionRecordSvnAction, previous?: SessionRecordConflictMemory): Promise<SvnResult<{ set: SvnActionConflictSet; memory: SessionRecordConflictMemory }>> {
    const read = await this.svn.conflictSet(action.root, action.baseRevision ?? 0)
    if (!read.ok) return read
    const set = SvnConflictFlow.setOf(read.value, action.baseRevision ?? 0, this.now(), action.kind === 'finish')
    const paths = [...previous?.paths ?? []]
    for (const fact of read.value.facts) {
      const known = paths.findIndex((entry) => SvnConflictIdentity.same(entry, fact))
      const fingerprint = createHash('sha256').update(JSON.stringify([fact.kind, fact.tree, fact.sidecars,
        fact.properties.map(({ name, older, theirs }) => [name, older, theirs]), read.value.revision]))
      for (const path of fact.sidecars) fingerprint.update(await readFile(SvnConflictFlow.inside(action.root, path)))
      const source = fingerprint.digest('hex')
      const before = known < 0 ? undefined : paths[known]
      const current = set.entries.find((entry) => SvnConflictIdentity.same(entry, fact))!
      if (before?.source === source && before.occurrenceId !== undefined) {
        current.occurrenceId = before.occurrenceId
        continue
      }
      const directory = join(this.savedDirectoryOf(previous?.actionId ?? action.actionId), 'conflicts')
      await mkdir(directory, { recursive: true })
      const saved = await mkdtemp(join(directory, `${paths.length}-`))
      await mkdir(join(saved, 'sidecars'), { recursive: true })
      if (fact.kind === 'text') {
        try { await copyFile(SvnConflictFlow.inside(action.root, fact.path), join(saved, 'working'), constants.COPYFILE_EXCL) }
        catch (error) { if (ErrnoCode.of(error) !== 'ENOENT' && ErrnoCode.of(error) !== 'EEXIST') throw error }
      }
      for (const [index, sidecar] of fact.sidecars.entries()) {
        try { await copyFile(SvnConflictFlow.inside(action.root, sidecar), join(saved, 'sidecars', String(index)), constants.COPYFILE_EXCL) }
        catch (error) { if (ErrnoCode.of(error) !== 'EEXIST') throw error }
      }
      const remembered = { path: fact.path, saved, sidecars: [...fact.sidecars], kind: fact.kind, occurrenceId: current.occurrenceId!, source }
      if (known < 0) paths.push(remembered)
      else paths[known] = remembered
    }
    return { ok: true, value: { set, memory: { actionId: previous?.actionId ?? action.actionId, readAt: this.now(), paths } } }
  }

  async remembered(action: SessionRecordSvnAction, memory: SessionRecordConflictMemory): Promise<SvnResult<{ memory: SessionRecordConflictMemory; set: SvnActionConflictSet; reasons: string[] }>> {
    const read = await this.read(action)
    if (!read.ok) return read
    const marked = new Map(read.value.entries.map((entry) => [SvnConflictIdentity.keyOf(entry), entry]))
    const paths: SessionRecordConflictMemory['paths'] = []
    const entries: SvnActionConflictEntry[] = []
    const reasons: string[] = []
    for (const entry of memory.paths) {
      const current = marked.get(SvnConflictIdentity.keyOf(entry))
      if (current !== undefined && entry.occurrenceId !== undefined) current.occurrenceId = entry.occurrenceId
      let problem = current === undefined || SvnConflictIdentity.held(action.conflictSet, entry) ? null : `${entry.path} is still conflicted`
      if (entry.kind === undefined || entry.kind === 'text') {
        let working: Buffer | null = null
        try { working = await readFile(SvnConflictFlow.inside(action.root, entry.path)) }
        catch (error) { if (ErrnoCode.of(error) !== 'ENOENT') throw error }
        if (working !== null && !working.subarray(0, 8192).includes(0) && SvnCommitGate.hasMarkerTriplet(working.toString('utf8')))
          problem = `${entry.path} still contains conflict markers`
        const chosen = action.conflictSet?.entries.find((candidate) => SvnConflictIdentity.same(candidate, entry) && candidate.state === 'settled' && candidate.settledWith !== undefined)
        const mine = entry.sidecars.findIndex((path) => /\.(?:mine|working)$/.test(path))
        const incoming = entry.sidecars.map((path, index) => ({ path, index }))
          .filter(({ path }) => /\.(?:r\d+|merge-right\.r\d+)$/.test(path))
          .sort((a, b) => Number(/r(\d+)$/.exec(b.path)?.[1]) - Number(/r(\d+)$/.exec(a.path)?.[1]))[0]
        if (problem === null && chosen === undefined && mine >= 0 && incoming !== undefined) {
          const local = await readFile(join(entry.saved, 'sidecars', String(mine)))
          const theirs = await readFile(join(entry.saved, 'sidecars', String(incoming.index)))
          if (working === null || working.equals(theirs) && !local.equals(theirs))
            problem = `${entry.path} drops the session's side; saved copy: ${entry.saved}`
        }
      }
      if (problem === null) continue
      paths.push(entry)
      reasons.push(problem)
      entries.push({ ...(current ?? { path: entry.path, kind: entry.kind ?? 'text', shape: 'unrecognized', options: [], facts: {} }),
        state: 'person', saved: entry.saved })
    }
    return { ok: true, value: { memory: { ...memory, paths }, set: { ...read.value, entries, waited: true }, reasons } }
  }

  private static inside(root: string, path: string): string {
    const absolute = resolve(root, path)
    if (!PathCompare.isInside(root, absolute)) throw new Error(`Conflict path leaves the worktree: ${path}`)
    return absolute
  }

  /**
   * The merger's brief of a Finish whose set holds a path an agent may settle, written beside the
   * parent's run logs: the action names it from then on. A set without one keeps the action as it is;
   * a brief that cannot be written answers why. The other commits' messages are read once here; a log
   * svn cannot give leaves them out.
   */
  async brief(parent: SessionRecord, action: SessionRecordSvnAction): Promise<SvnResult<SessionRecordSvnAction>> {
    const set = action.conflictSet
    if (action.kind !== 'finish' || set === undefined || !set.entries.some(SvnMergerLauncher.forAgent)) return { ok: true, value: action }
    const cli = this.cli()
    if (!cli.ok) return { ok: false, code: 'svn-failed', detail: `the merger's brief could not name the Jamat CLI (${cli.detail})` }
    const log = await this.svn.logOf(action.root, set.baseRevision + 1, set.revision)
    const text = SvnMergerLauncher.briefOf({
      title: parent.title,
      root: action.root,
      set,
      log: log.ok ? log.value : [],
      cli: cli.command,
    })
    const written = await this.briefs.writeMergeBrief(parent.sessionId, action.actionId, text)
    if (!written.ok) return { ok: false, code: 'svn-failed', detail: `the merger's brief could not be written (${written.detail})` }
    return { ok: true, value: { ...action, mergeBrief: this.briefs.mergeBriefPathOf(parent.sessionId, action.actionId) } }
  }

  /**
   * Before a merger starts: the content hash of every path changed now, beside the action's result,
   * so the check after it names what changed outside the conflicts while it ran (guard 3).
   */
  async handOver(action: SessionRecordSvnAction): Promise<SvnResult<void>> {
    const changes = await this.svn.changes(action.root)
    if (!changes.ok) return changes
    const hashes = await this.svn.hashes(action.root, changes.value.map((row) => row.path))
    if (!hashes.ok) return hashes
    return await this.handover.writeHandover(action.actionId, hashes.value)
      ? { ok: true, value: undefined }
      : { ok: false, code: 'svn-failed', detail: 'the merger handover could not be written' }
  }

  /**
   * `fixing`, one call per drive step. A set the person or the merger had (Check again, the end of a
   * merger) is read again for what they changed (`checked`). A fresh set runs its rules first, one entry
   * per call (`applied`), then the guards; paths an agent may settle go to the merger once per set,
   * the rest to the person.
   */
  async fix(action: SessionRecordSvnAction, onFix: SvnConflictFixing, noteJournal: SvnConflictJournalNote, agentPress = false): Promise<SvnConflictStep> {
    // Without a set, svn is the only account: read it as at Check again.
    const set: SvnActionConflictSet = action.conflictSet
      ?? { readAt: this.now(), baseRevision: action.baseRevision ?? 0, revision: action.baseRevision ?? 0, entries: [], more: 0, waited: true }
    if (set.waited === true) return this.checked(action, set, onFix, agentPress)
    const rule = set.entries.find((entry) => entry.state === 'rule')
    return rule === undefined ? this.afterRules(action, set) : this.ruled(action, set, rule, onFix, noteJournal)
  }

  /**
   * One rule on one entry, saved first and journaled (a restart resumes it at its first undone step),
   * settled by Jamat with the diverged files its last step left, then the guards over what svn shows
   * now. A failed step or a guard finding stops the rules: the person gets the set with the reason.
   */
  private async ruled(
    action: SessionRecordSvnAction,
    set: SvnActionConflictSet,
    entry: SvnActionConflictEntry,
    onFix: SvnConflictFixing,
    noteJournal: SvnConflictJournalNote,
  ): Promise<SvnConflictStep> {
    const option = entry.rule
    if (option === undefined) throw new Error(`The rule entry ${entry.path} names no rule`)
    const done = set.entries.filter((candidate) => candidate.state === 'settled' && candidate.by === 'jamat').length
    const rules = set.entries.filter((candidate) => candidate.state === 'rule').length
    onFix({ path: entry.path, option, index: done + 1, count: done + rules })
    const settled = await this.settle(action, set, entry, option, 'jamat', false, (journal) => noteJournal(entry.path, journal, entry.kind))
    if (settled.failure !== null) {
      const waiting = SvnConflictFlow.toPerson(settled.set)
      const reason = `Jamat could not apply ${SvnConflictWords.optionWordOf(option)} to ${entry.path}: ${settled.failure.detail}; ${SvnConflictWords.reasonOf(waiting, SvnConflictFlow.checkAgainConst)}`
      return { kind: 'needs', action: { ...action, conflictSet: waiting }, need: 'conflict', reason }
    }
    const read = await this.svn.conflictSet(action.root, set.baseRevision)
    if (!read.ok)
      return { kind: 'needs', action: { ...action, conflictSet: settled.set }, need: 'svn-failed', reason: `svn cannot report the conflicts of ${action.root}: ${read.detail}` }
    const findings = await this.guarded(action, settled.set, read.value.rows)
    if (findings.length > 0) {
      const waiting = SvnConflictFlow.toPerson(SvnConflictFlow.reopened(settled.set, findings))
      const reason = `${SvnConflictWords.guardOf(findings)}; ${SvnConflictWords.reasonOf(waiting, SvnConflictFlow.checkAgainConst)}`
      return { kind: 'needs', action: { ...action, conflictSet: waiting }, need: 'conflict', reason }
    }
    const fixed = [...action.fixed ?? [], { path: entry.path, option }].slice(-SvnConflictFlow.entriesMaxConst)
    return { kind: 'applied', action: { ...action, conflictSet: settled.set, fixed } }
  }

  /**
   * No rule left in a fresh set: the guards over what svn shows now, and a conflict the set does not
   * hold yet joins it for the person. Nothing open: settled. A path an agent may settle, a diverged file
   * too, goes to the merger when no merger ran on this set and Claude runs here; the others wait for
   * the person meanwhile. A guard finding, or no merger: the whole rest waits for the person.
   */
  private async afterRules(action: SessionRecordSvnAction, set: SvnActionConflictSet): Promise<SvnConflictStep> {
    const read = await this.svn.conflictSet(action.root, set.baseRevision)
    if (!read.ok) return { kind: 'needs', action, need: 'svn-failed', reason: `svn cannot report the conflicts of ${action.root}: ${read.detail}` }
    const known = new Set(set.entries.map(SvnConflictIdentity.keyOf))
    const added = read.value.facts.filter((fact) => !known.has(SvnConflictIdentity.keyOf(fact))).map((fact) => SvnConflictFlow.entryOf(fact, read.value.revision, 'person'))
    const all = [...set.entries, ...added]
    const next: SvnActionConflictSet = {
      ...set,
      entries: all.slice(0, SvnConflictFlow.entriesMaxConst),
      more: Math.max(0, all.length - SvnConflictFlow.entriesMaxConst),
    }
    const findings = await this.guarded(action, next, read.value.rows)
    const checked = findings.length === 0 ? next : SvnConflictFlow.reopened(next, findings)
    if (!SvnConflictFlow.unsettled(checked) && findings.length === 0) return { kind: 'settled', action: { ...action, conflictSet: checked } }
    const forAgent = checked.entries.some(SvnMergerLauncher.forAgent)
    const unavailable = forAgent ? this.unavailable() : null
    // A set with paths the record does not list never goes to a merger: its last call could not end it.
    if (findings.length === 0 && forAgent && checked.more === 0 && action.merger?.setAt !== checked.readAt && unavailable === null)
      return { kind: 'merge', action: { ...action, conflictSet: SvnConflictFlow.toAgent(checked) } }
    const waiting = SvnConflictFlow.toPerson(checked)
    const reason = SvnConflictWords.reasonOf(waiting, SvnConflictFlow.checkAgainConst)
    const why = findings.length > 0 ? `${SvnConflictWords.guardOf(findings)}; ${reason}`
      : unavailable !== null ? `${reason} (no merger runs here: ${unavailable})`
      : reason
    return { kind: 'needs', action: { ...action, conflictSet: waiting }, need: 'conflict', reason: why }
  }

  /**
   * `fixing` after Check again or a merger: what svn and the person or the merger changed since the set
   * was read. An entry svn no longer marks is settled as it stands; a text entry still marked whose
   * file holds no marker line is settled with `merged` (sidecars saved, `--accept working`); a conflict
   * the set does not hold yet joins it for the person. A diverged file is no svn conflict, so only an
   * option settles it. The first check after a merger counts those as the merger's and runs guards 3
   * and 4 once: a change outside the set, or a commit, waits for the person, whose next Check again
   * accepts it. Nothing open: settled, and the Finish goes on; anything open waits for the person.
   */
  private async checked(action: SessionRecordSvnAction, set: SvnActionConflictSet, onFix: SvnConflictFixing, agentPress: boolean): Promise<SvnConflictStep> {
    // The first check after a merger ended: what svn no longer marks, the merger did.
    const merger = action.merger
    const afterMerger = merger !== undefined && merger.endedAt !== undefined && merger.checkedAt === undefined
    const read = await this.reread(action, set, afterMerger ? 'merger' : 'person', onFix)
    if (!read.ok) return { kind: 'needs', action: read.set === undefined ? action : { ...action, conflictSet: read.set }, need: 'svn-failed', reason: read.detail }
    const { set: checked, findings } = read.value
    const mergerRead = afterMerger ? await this.mergerGuarded(action, checked) : { ok: true as const, value: [] }
    if (!mergerRead.ok)
      return { kind: 'needs', action, need: 'svn-failed', reason: `svn cannot report what the merger changed in ${action.root}: ${mergerRead.detail}` }
    const guards = mergerRead.value
    const after: SessionRecordSvnAction = afterMerger ? { ...action, merger: { ...merger, checkedAt: this.now() } } : action
    const open = SvnConflictFlow.unsettled(checked)
    if (!open && guards.length === 0 && findings.length === 0) return { kind: 'settled', action: { ...after, conflictSet: checked } }
    // Resolve with agent: the person's press starts a merger on what is left, whatever ran on the set.
    if (agentPress && open && guards.length === 0 && findings.length === 0 && checked.more === 0
      && checked.entries.some(SvnMergerLauncher.forAgent) && this.unavailable() === null)
      return { kind: 'merge', action: { ...after, conflictSet: SvnConflictFlow.toAgent({ ...checked, waited: undefined }) } }
    const waiting = SvnConflictFlow.toPerson(checked)
    const left = waiting.entries.filter((entry) => entry.state !== 'settled').length + waiting.more
    const rest = open ? SvnConflictWords.reasonOf(waiting, SvnConflictFlow.checkAgainConst) : `${SvnConflictWords.summaryOf(waiting)}; ${SvnConflictFlow.checkAgainConst}`
    const reason = [
      ...guards.length === 0 ? [] : [SvnConflictWords.guardOf(guards)],
      ...findings.length === 0 ? [] : [SvnConflictWords.guardOf(findings)],
      ...afterMerger && open ? [`the merger ended with ${left} left`] : [],
      rest,
    ].join('; ')
    return { kind: 'needs', action: { ...after, conflictSet: waiting }, need: 'conflict', reason }
  }

  /**
   * Check again while the merger works: what the person settled by hand counts as theirs, at once,
   * and the merger goes on with the rest. Open entries keep who works on them; a reopened or a new one
   * is the person's. The answer is the set to write.
   */
  async recheck(action: SessionRecordSvnAction, onFix: SvnConflictFixing): Promise<{ ok: true; value: SvnActionConflictSet } | SvnConflictReadFailure> {
    const set = action.conflictSet
    if (set === undefined) throw new Error(`The SVN ${action.kind} of ${action.root} checks no conflict set`)
    const read = await this.reread(action, set, 'person', onFix)
    return read.ok ? { ok: true, value: read.value.set } : read
  }

  /**
   * The set as svn and the files stand now: an entry svn no longer marks is settled as it stands by
   * `by`, a text entry still marked without a marker line through `merged`, a new conflict joins for
   * the person; then guards 1 and 2, whose findings reopen their entries. A failure is worded for the
   * person: a lock its recovery could not lift in the recovery's sentence, a read svn refused as svn's.
   */
  private async reread(action: SessionRecordSvnAction, set: SvnActionConflictSet, by: SvnConflictActor, onFix: SvnConflictFixing)
    : Promise<{ ok: true; value: { set: SvnActionConflictSet; findings: SvnGuardFinding[] } } | SvnConflictReadFailure> {
    const recovered = await this.resolutions.recoverLocked(action.root, this.savedDirectoryOf(action.actionId), action.actionId,
      set.entries.flatMap((entry) => entry.state === 'settled' || entry.occurrenceId === undefined ? [] : [entry.occurrenceId]))
    const read = await this.svn.conflictSet(action.root, set.baseRevision)
    if (!read.ok) return recovered.ok ? { ...read, detail: `svn cannot report the conflicts of ${action.root}: ${read.detail}` } : recovered
    if (!recovered.ok && (recovered.code !== 'locked' || read.value.lockedPaths === undefined)) return recovered
    const marked = new Map(read.value.facts.map((fact) => [SvnConflictIdentity.keyOf(fact), fact]))
    const known = new Set(set.entries.map(SvnConflictIdentity.keyOf))
    let entries = await Promise.all(set.entries.map(async (entry) => {
      const current = marked.get(SvnConflictIdentity.keyOf(entry))
      if (entry.state === 'settled' && current !== undefined && !SvnConflictIdentity.held(set, entry))
        return SvnConflictFlow.entryOf(current, read.value.revision, 'person')
      const locked = read.value.lockedPaths?.some((path) => PathCompare.isInside(resolve(action.root, path), resolve(action.root, entry.path))) === true
      if (entry.state === 'settled' || entry.kind === 'diverged' || current !== undefined || locked) return entry
      const choice = entry.occurrenceId === undefined ? null : await this.resolutions.recoveredChoice?.({ actionId: action.actionId, occurrenceId: entry.occurrenceId,
        root: action.root, path: entry.path, kind: entry.kind, savedDir: this.resolutionDirectory(action.actionId, entry), journal: entry.journal ?? null }) ?? null
      return SvnConflictFlow.settledOf(entry, by, choice)
    }))
    const candidates = entries.filter((entry) => recovered.ok && entry.state !== 'settled' && entry.kind === 'text' && marked.get(SvnConflictIdentity.keyOf(entry))?.takesArgument === true
      && (entry.facts.properties?.length ?? 0) === 0)
    const withMarkers = new Set(candidates.length === 0 ? [] : await this.withMarkers(action.root, candidates.map((entry) => entry.path)))
    const merged = candidates.filter((entry) => !withMarkers.has(entry.path))
    for (const [index, entry] of merged.entries()) {
      onFix({ path: entry.path, option: 'merged', index: index + 1, count: merged.length })
      const settled = await this.applied(action, entry, 'merged', by)
      entries = entries.map((candidate) => SvnConflictIdentity.same(candidate, entry) ? settled.entry : candidate)
    }
    const added = read.value.facts.filter((fact) => !known.has(SvnConflictIdentity.keyOf(fact))).map((fact) => SvnConflictFlow.entryOf(fact, read.value.revision, 'person'))
    const all = [...entries, ...added]
    const next: SvnActionConflictSet = {
      ...set,
      entries: all.slice(0, SvnConflictFlow.entriesMaxConst),
      more: Math.max(0, all.length - SvnConflictFlow.entriesMaxConst),
    }
    let rows = read.value.rows
    // The rows of the first read predate the options this step ran.
    if (merged.length > 0) {
      const again = await this.svn.conflictSet(action.root, set.baseRevision)
      if (!again.ok) return again
      rows = again.value.rows
    }
    const findings = await this.guarded(action, next, rows)
    const checked = findings.length === 0 ? next : SvnConflictFlow.reopened(next, findings)
    return recovered.ok ? { ok: true, value: { set: checked, findings } } : { ...recovered, set: checked }
  }

  /**
   * Guards 3 and 4 after a merger: the hashes it started on against the files now, over every path
   * changed then or now, and the highest BASE against the update's revision.
   */
  private async mergerGuarded(action: SessionRecordSvnAction, set: SvnActionConflictSet): Promise<SvnResult<SvnGuardFinding[]>> {
    const before = await this.handover.readHandover(action.actionId)
    const changes = await this.svn.changes(action.root)
    if (!changes.ok) return changes
    const paths = [...new Set([...before?.keys() ?? [], ...changes.value.map((row) => row.path)])]
    const now = await this.svn.hashes(action.root, paths)
    if (!now.ok) return now
    const base = await this.svn.baseAbove(action.root, set.revision)
    if (!base.ok) return base
    return { ok: true, value: SvnConflictGuard.afterMerger({ set, before, now: new Map(Object.entries(now.value)), baseAbove: base.value }) }
  }

  /**
   * The guards over the set as svn and the files stand now (`SvnConflictGuard`). A binary or unreadable
   * file has no marker lines to look for, and its NUL bytes would reopen it after every option.
   */
  private async guarded(action: SessionRecordSvnAction, set: SvnActionConflictSet, rows: readonly SvnItemRow[]): Promise<SvnGuardFinding[]> {
    const text = set.entries.filter((entry) => entry.state === 'settled' && entry.kind === 'text' && entry.facts.unsafe !== true
      && entry.shape !== 'binary' && entry.shape !== 'text-unreadable').map((entry) => entry.path)
    const marked = text.length === 0 ? [] : await this.withMarkers(action.root, text)
    return SvnConflictGuard.check({ set, rows, marked, finish: action.kind === 'finish' })
  }

  /**
   * Each entry a guard found open again for the person, its journal gone so the next option starts
   * from its first step. An entry whose commit would drop incoming work becomes `drops-incoming`,
   * which admits keep-both, or keep-mine with the loss confirmed.
   */
  static reopened(set: SvnActionConflictSet, findings: readonly SvnGuardFinding[]): SvnActionConflictSet {
    return {
      ...set,
      entries: set.entries.map((entry) => {
        const found = findings.filter((finding) => SvnConflictGuard.pathOf(finding) === entry.path
          && (finding.kind !== 'markers' || entry.kind === 'text' || entry.kind === 'diverged'))
        if (found.length === 0) return entry
        const open: SvnActionConflictEntry = { ...entry, state: 'person' }
        delete open.by
        delete open.settledWith
        delete open.journal
        delete open.confirmedLoss
        const drops = found.find((finding) => finding.kind === 'drops-incoming')
        return drops === undefined ? open : {
          ...open,
          shape: 'drops-incoming',
          options: [...SvnConflictShapes.optionsOf('drops-incoming')],
          facts: { ...open.facts, dropped: SvnConflictFlow.droppedCountOf(open, drops.dropped) },
        }
      }),
    }
  }

  /**
   * How many files the commit would delete. `svn status` lists a folder scheduled for deletion alone,
   * so a dropped victim folder counts the incoming files read with the set; otherwise the dropped
   * paths no other one lies below.
   */
  private static droppedCountOf(entry: SvnActionConflictEntry, dropped: readonly string[]): number {
    if (dropped.includes(entry.path) && entry.facts.files !== undefined) return entry.facts.files.incoming
    return dropped.filter((path) => !dropped.some((other) => other.startsWith(`${path}/`))).length
  }

  /**
   * One option on one path of a Finish or a main-copy UPDATE that waits on its conflicts, chosen by
   * the person (window or CLI) or, in a Finish, by the merger. It settles the entry with the option
   * through the executor, which saves first and journals its steps (`noteJournal` writes each on the
   * record before the next starts); the same-name files a keep-both left differing become `diverged`
   * entries. A loss of incoming work is the person's alone, in the window, confirmed. The action never
   * goes on by itself: Check again does, or for an UPDATE its Update press. The answer is the action
   * to write, or the refusal.
   */
  async resolve(
    action: SessionRecordSvnAction,
    request: SvnConflictResolveRequest & { by: SvnConflictActor },
    noteJournal: SvnConflictJournalNote,
    step?: import('../worktreeState').FinishStep,
  ): Promise<SessionsOpResult<{ action: SessionRecordSvnAction; state: SvnConflictState; left: number }>> {
    const set = action.conflictSet
    const merging = step === 'worker-resolving' || action.stage === 'merging' && action.needs === undefined
    if (action.needs === undefined && !merging)
      return { ok: false, code: 'merge-pending', detail: `The SVN ${action.kind} is ${action.stage}; settle its conflicts once it waits for you` }
    const need = action.needs?.kind
    const press = SvnConflictFlow.pressOf(action.kind)
    if ((!merging && need !== 'conflict' && need !== 'resolver-failed') || press === null || !SvnConflictFlow.unsettled(set))
      return { ok: false, code: 'merge-pending', detail: `The SVN ${action.kind} waits for something else (${need ?? action.stage}): ${action.needs?.reason ?? ''}` }
    const matching = set.entries.filter((candidate) => candidate.path === request.path && (request.kind === undefined || candidate.kind === request.kind))
    const open = matching.filter((candidate) => candidate.state !== 'settled')
    if (open.length > 1)
      return { ok: false, code: 'invalid-spec', detail: `${request.path} has a ${open.map((candidate) => candidate.kind).join(' and a ')} conflict; `
        + `name the one to settle: ${open.map((candidate) => `--kind ${candidate.kind}`).join(' or ')}` }
    const entry = open[0] ?? matching[0]
    if (entry === undefined)
      return { ok: false, code: 'invalid-spec', detail: `${request.path} is not a conflict of this Finish; sessions conflicts lists them` }
    if (entry.state === 'settled')
      return { ok: false, code: 'invalid-spec', detail: `${request.path} is settled already` }
    if (!entry.options.includes(request.option))
      return { ok: false, code: 'invalid-spec', detail: `${request.path} admits ${entry.options.join(', ') || 'no option'}, not ${request.option}` }
    if ((request.by === 'agent' || request.by === 'merger' || request.requestedBy !== 'window')
      && !SvnConflictShapes.agentOption(entry.shape, entry.kind, request.option, entry.facts.properties))
      return { ok: false, code: 'person-only', detail: `${request.option} on ${request.path} requires the person to inspect and resolve this ${SvnConflictWords.conflictWordOf(entry)}` }
    const loses = SvnConflictShapes.lossOf(request.option) === 'incoming'
      || request.option === 'merged' && (entry.kind === 'property' || entry.kind === 'tree')
    if (loses && !(request.requestedBy === 'window' && request.confirm))
      return { ok: false, code: 'person-only', detail: `${request.option} on ${request.path} drops what the other commit brought in; only you can choose it, in the window, with a confirmation` }
    const settled = await this.settle(action, set, entry, request.option, request.by, loses, (journal) => noteJournal(entry.path, journal, entry.kind))
    // A locked working copy is no step to resume: its detail says what the person does first.
    if (settled.failure?.code === 'locked')
      return { ok: false, code: 'locked', detail: `${request.option} on ${request.path} stopped: ${settled.failure.detail}` }
    // A refusal (conflict markers left, properties Jamat cannot name) wrote nothing; the person fixes the cause and chooses again.
    if (settled.failure?.code === 'refused')
      return { ok: false, code: 'invalid-spec', detail: `${request.path} was not settled: ${settled.failure.detail}` }
    if (settled.failure !== null)
      return { ok: false, code: 'svn-failed', detail: `${request.option} on ${request.path} stopped: ${settled.failure.detail}; the next call goes on from the step it reached` }
    const next = settled.set
    // The guards after the option; a read that fails leaves them to Check again, which runs them too.
    const read = await this.svn.conflictSet(action.root, set.baseRevision)
    if (!read.ok) return { ok: false, code: 'svn-failed', detail: `The settled path could not be checked: ${read.detail}` }
    const findings = await this.guarded(action, next, read.value.rows)
    const checked = findings.length === 0 ? next : SvnConflictFlow.reopened(next, findings)
    const left = checked.entries.filter((candidate) => candidate.state !== 'settled').length + checked.more
    const summary = left === 0 ? SvnConflictWords.settledOf(checked, press.label) : SvnConflictWords.reasonOf(checked, press.again)
    const reason = findings.length === 0 ? summary : `${SvnConflictWords.guardOf(findings)}; ${summary}`
    const state = checked.entries.find((candidate) => SvnConflictIdentity.same(candidate, entry))?.state ?? 'settled'
    return {
      ok: true,
      value: { action: { ...action, conflictSet: checked, ...action.needs === undefined ? {} : { needs: { ...action.needs, reason } } }, state, left },
    }
  }

  /** The press that goes on once the person settled the paths of an action, or null for an action whose conflicts nobody settles here. */
  private static pressOf(kind: SessionRecordSvnAction['kind']): { label: string; again: string } | null {
    switch (kind) {
      case 'finish': return { label: SvnConflictWords.checkAgainConst, again: SvnConflictFlow.checkAgainConst }
      case 'update-main': return { label: SvnConflictWords.updateConst, again: `press ${SvnConflictWords.updateConst} again` }
      case 'discard': return null
      default: throw new Error(`Unknown SVN action kind: ${JSON.stringify(kind satisfies never)}`)
    }
  }

  /**
   * One option on one entry, by a rule or by a hand: settled with its saved copy and, for a confirmed
   * loss, the mark; each same-name file a keep-both left differing becomes a `diverged` entry for the
   * person, whose saved copy is the session's version. A failure leaves the entry open with its journal.
   */
  private async settle(
    action: SessionRecordSvnAction,
    set: SvnActionConflictSet,
    entry: SvnActionConflictEntry,
    option: SvnConflictOption,
    by: SvnConflictActor,
    confirmedLoss: boolean,
    noteJournal: (journal: SvnConflictJournal) => Promise<void>,
  ): Promise<{ set: SvnActionConflictSet; failure: { code: SvnErrorCode; detail: string } | null }> {
    const applied = await this.applied(action, entry, option, by, noteJournal)
    const replaced = (next: SvnActionConflictEntry): SvnActionConflictEntry[] =>
      set.entries.map((candidate) => SvnConflictIdentity.same(candidate, entry) ? next : candidate)
    if (applied.failure !== null) return { set: { ...set, entries: replaced(applied.entry) }, failure: applied.failure }
    const savedDir = this.resolutionDirectory(action.actionId, entry)
    const settled: SvnActionConflictEntry = {
      ...applied.entry,
      saved: join(savedDir, ...entry.path.split('/')),
      ...confirmedLoss ? { confirmedLoss: true as const } : {},
    }
    const known = new Set(set.entries.map((candidate) => candidate.path))
    const diverged = applied.diverged.filter((path) => !known.has(path)).map((path): SvnActionConflictEntry => ({
      path,
      occurrenceId: entry.occurrenceId,
      kind: 'diverged',
      shape: 'diverged',
      state: 'person',
      options: [...SvnConflictShapes.optionsOf('diverged')],
      facts: { incomingRevision: entry.facts.incomingRevision ?? set.revision },
      saved: join(savedDir, ...path.split('/')),
    }))
    const all = [...replaced(settled), ...diverged]
    return {
      set: { ...set, entries: all.slice(0, SvnConflictFlow.entriesMaxConst), more: set.more + Math.max(0, all.length - SvnConflictFlow.entriesMaxConst) },
      failure: null,
    }
  }

  /**
   * One option on one entry through the executor, from the step its journal reached: settled with the
   * option on success, open with the journal it reached on a failure.
   */
  private async applied(
    action: SessionRecordSvnAction,
    entry: SvnActionConflictEntry,
    option: SvnConflictOption,
    by: SvnConflictActor,
    noteJournal: (journal: SvnConflictJournal) => Promise<void> = async () => undefined,
  ): Promise<{ entry: SvnActionConflictEntry; failure: { code: SvnErrorCode; detail: string } | null; diverged: string[] }> {
    let journal = entry.journal ?? null
    const diverged: string[] = []
    const base = action.conflictSet?.baseRevision ?? action.baseRevision
    const applied = await this.resolutions.apply({
      actionId: action.actionId, occurrenceId: entry.occurrenceId,
      ...SvnConflictFlow.moveOf(entry),
      root: action.root,
      savedDir: this.resolutionDirectory(action.actionId, entry),
      path: entry.path,
      kind: entry.kind,
      option,
      ...entry.facts.properties === undefined ? {} : { properties: entry.facts.properties },
      ...base === undefined ? {} : { baseRevision: base },
      ...SvnConflictIdentity.openBeside(action.conflictSet, entry) ? { held: true as const } : {},
      ...action.kind === 'update-main' ? { mainCopy: true as const } : {},
      ...by === 'jamat' && option === 'merged' && entry.kind === 'text' ? { rebuild: true as const } : {},
      journal,
      onStep: async (next, left) => {
        journal = next
        diverged.push(...left)
        await noteJournal(next)
      },
    })
    const journaled = journal === null ? entry : { ...entry, journal }
    return applied.ok
      ? { entry: SvnConflictFlow.settledOf(journaled, by, option), failure: null, diverged }
      : { entry: { ...journaled, state: 'person' }, failure: { code: applied.code, detail: applied.detail }, diverged }
  }

  /** `rules`: an entry with a proven rule is Jamat's, and only the rest decide between an agent and the person. */
  static setOf(read: SvnConflictRead, baseRevision: number, readAt: number, rules: boolean): SvnActionConflictSet {
    const listed = read.facts.slice(0, SvnConflictFlow.entriesMaxConst)
    const fits = read.facts.length <= SvnConflictFlow.entriesMaxConst
    const ruled = (fact: SvnConflictFact): boolean => SvnConflictShapes.planOf(fact).rule !== null && (rules || fact.kind !== 'tree')
    const textOnly = fits && listed.every((fact) => ruled(fact) || fact.kind === 'text')
    // A set the record cannot list whole goes to no agent; the merger's set is sorted per entry below.
    const state: SvnConflictState = rules ? fits ? 'agent' : 'person' : textOnly ? 'agent' : 'person'
    const set: SvnActionConflictSet = {
      readAt,
      baseRevision,
      revision: read.revision,
      entries: listed.map((fact) => SvnConflictFlow.entryOf(fact, read.revision, ruled(fact) ? 'rule' : state)),
      more: Math.max(0, read.facts.length - SvnConflictFlow.entriesMaxConst),
    }
    return rules && fits ? SvnConflictFlow.toAgent(set) : set
  }

  /** Whether the set holds a conflict at all. */
  static open(set: SvnActionConflictSet | undefined): set is SvnActionConflictSet {
    return SvnConflictWords.open(set)
  }

  /** Whether a path of the set is still open, listed or not. */
  static unsettled(set: SvnActionConflictSet | undefined): set is SvnActionConflictSet {
    return set !== undefined && (set.more > 0 || set.entries.some((entry) => entry.state !== 'settled'))
  }

  /** Whether an agent works on every path of the set. */
  static forAgent(set: SvnActionConflictSet): boolean {
    return set.more === 0 && set.entries.length > 0 && set.entries.every((entry) => entry.state === 'agent')
  }

  /**
   * The merger's paths: each open entry an agent may settle is `agent`, every other open one `person`.
   * Rule entries stay Jamat's.
   */
  static toAgent(set: SvnActionConflictSet): SvnActionConflictSet {
    return {
      ...set,
      entries: set.entries.map((entry) => entry.state === 'settled' || entry.state === 'rule' ? entry
        : { ...entry, state: SvnMergerLauncher.forAgent(entry) ? 'agent' : 'person' }),
    }
  }

  /** Nobody else can settle them: the whole set waits for the person, and Check again reads what they changed. */
  static toPerson(set: SvnActionConflictSet): SvnActionConflictSet {
    return { ...set, waited: true, entries: set.entries.map((entry) => entry.state === 'settled' ? entry : { ...entry, state: 'person' }) }
  }

  /** Every open entry was settled, by whom. */
  static settledBy(set: SvnActionConflictSet, by: SvnConflictActor): SvnActionConflictSet {
    return { ...set, entries: set.entries.map((entry) => entry.state === 'settled' ? entry : { ...entry, state: 'settled', by }) }
  }

  /** How many conflicts the set holds, listed or not. */
  static totalOf(set: SvnActionConflictSet | undefined): number {
    return set === undefined ? 0 : set.entries.length + set.more
  }

  /** Settled by whom and, when an option did it, with which. */
  static settledOf(entry: SvnActionConflictEntry, by: SvnConflictActor, option: SvnConflictOption | null): SvnActionConflictEntry {
    const next: SvnActionConflictEntry = { ...entry, state: 'settled', by }
    if (option === null) delete next.settledWith
    else next.settledWith = option
    return next
  }

  private resolutionDirectory(actionId: string, entry: SvnActionConflictEntry): string {
    return entry.occurrenceId === undefined ? this.savedDirectoryOf(actionId)
      : join(this.savedDirectoryOf(actionId), 'resolutions', entry.occurrenceId)
  }

  /** keep-both of a move follows it: the session's move target, or the place the other commit moved a file to. */
  private static moveOf(entry: SvnActionConflictEntry): Pick<SvnConflictApply, 'move'> {
    const { reason, action, localKind, movedTo } = entry.facts
    if (reason === 'moved-away' && action === 'edited') return { move: 'away' }
    return reason === 'edited' && action === 'deleted' && localKind === 'file' && movedTo !== undefined ? { move: 'incoming' } : {}
  }

  private static entryOf(fact: SvnConflictFact, revision: number, state: SvnConflictState): SvnActionConflictEntry {
    const plan = SvnConflictShapes.planOf(fact)
    const tree = fact.tree
    const facts: SvnActionConflictEntry['facts'] = {
      ...tree === null ? {} : { reason: tree.reason, action: tree.action, localKind: tree.localKind, incomingKind: tree.incomingKind },
      ...tree?.movedTo === undefined ? {} : { movedTo: tree.movedTo },
      incomingRevision: tree?.incomingRevision ?? fact.rootRevision ?? revision,
      ...fact.content?.files === undefined ? {} : { files: fact.content.files },
      ...fact.properties.length === 0 ? {} : { properties: fact.properties.map((property) => property.name) },
      ...fact.takesArgument ? {} : { unsafe: true },
    }
    return {
      occurrenceId: randomUUID(),
      path: fact.path,
      kind: fact.kind,
      shape: plan.shape,
      state,
      options: [...plan.options],
      ...plan.rule === null ? {} : { rule: plan.rule },
      facts,
    }
  }
}
