import type { WorktreeUpdateUnit, WorktreeUpdateState, WorktreeUpdateSkip } from './worktreeContracts'
export type { WorktreeUpdateUnit, WorktreeUpdateState } from './worktreeContracts'
import { randomUUID } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'
import { PathCompare } from '../shared/pathCompare'
import type { SessionRecordsStore } from '../sessionManager/worktreeSessionRecords'
import type { SvnConflictFact, SvnMountState } from '../svn/svn.types'
import type { SvnUpdateSnapshot, SvnUpdateTarget, SvnUpdateTargets } from '../svn/svnUpdateTargets'
import type { SvnWorktreeManager } from '../svn/svnWorktreeManager'
import type { SvnStepRunner, SvnStepResult } from './svnStepRunner'
import type { SvnStepJournalEntry } from './worktreeState'

export class WorktreeUpdateFailure extends Error {
  readonly result: SvnStepResult

  constructor(result: SvnStepResult) {
    super(result.output)
    this.result = result
  }
}

/** What one `run` call carries from unit to unit. */
interface WorktreeRound {
  root: string
  revision: number
  /** Root-relative paths conflicted before the update, and the same as absolute paths. */
  older: readonly string[]
  skipped: readonly string[]
  /** Parents whose definitions this call compared; an update of one mount never writes its parent's. */
  compared: Set<number>
  /** One read of every mount, taken when the first mount is due and again after a native reconcile (D2). */
  mounts: ReadonlyMap<string, SvnMountState> | null
  proven: Array<{ target: SvnUpdateTarget; reason: WorktreeUpdateSkip }>
}

export class WorktreeUpdate {
  private readonly deps: {
    records: SessionRecordsStore
    runner: Pick<SvnStepRunner, 'run' | 'note'>
    targets: Pick<SvnUpdateTargets, 'owner' | 'snapshot' | 'verify'>
    svn: Pick<SvnWorktreeManager, 'conflictSet' | 'mountStates'>
    changed: () => void
  }

  constructor(deps: WorktreeUpdate['deps']) { this.deps = deps }

  /**
   * `older`: root-relative paths svn marked as conflicted before this update. svn skips them and
   * updates everything else, so they stop no target and are left to the person as they are.
   */
  async run(sessionId: string, actionId: string, root: string, revision: number, older: readonly string[] = [])
    : Promise<{ complete: boolean; revision: number; runId?: string }> {
    const failure = this.deps.records.get(sessionId)?.worktreeLifecycle?.updateFailure
    if (failure !== undefined) throw new Error(failure)
    let state = structuredClone(this.read(sessionId))
    if (state === undefined || state.completed || state.actionId !== actionId || PathCompare.comparable(state.root) !== PathCompare.comparable(root)) {
      // An earlier action of this working copy may leave its update unfinished, as a sync that met
      // conflicts did before Finish took a new id (worker-agent 031). With no svn command of it open,
      // svn holds nothing of it, and this update starts again from the owner to its own revision.
      if (state !== undefined && !state.completed && (PathCompare.comparable(state.root) !== PathCompare.comparable(root) || this.open(sessionId, state)))
        throw new Error('An unfinished update belongs to another action or working copy')
      const target = await this.deps.targets.owner(root, revision)
      state = { actionId, generation: randomUUID(), root, revision, cursor: 0, units: [{ target, phase: 'pending' }], completed: false }
      await this.save(sessionId, state)
    }
    const round: WorktreeRound = { root, revision: state.revision, older, skipped: older.map((path) => resolve(root, path)),
      compared: new Set(), mounts: null, proven: [] }
    let paused: { runId?: string } | undefined
    try {
      while (state.cursor < state.units.length) {
        const unit = state.units[state.cursor]
        const outcome = await this.advance(sessionId, state, round)
        if (outcome !== 'proven' && outcome !== 'reconciled') {
          // D5 only shortens the round: a failed read or update ends the early updates and the
          // conflicts still go to the worker. An svn command it left open belongs to recovery.
          try {
            await this.cleanMounts(sessionId, state, round, outcome)
          } catch (error) {
            if (this.open(sessionId, state)) throw error
          }
          paused = { runId: unit.runId }
          break
        }
        unit.phase = 'done'
        state.cursor++
        await this.save(sessionId, state)
      }
    } catch (error) {
      // The proven mounts already lie behind the cursor, so no later call would note them (D3).
      await this.summary(sessionId, state, round.proven).catch(() => undefined)
      throw error
    }
    const noted = await this.summary(sessionId, state, round.proven)
    if (paused !== undefined) return { complete: false, revision: state.revision, runId: paused.runId }
    state.completed = true
    await this.save(sessionId, state, true)
    return { complete: true, revision: state.revision, runId: state.units.at(-1)?.runId ?? noted }
  }

  /**
   * D2: the read of the round proves what `verify(target, true)` proves after an update. A carrier is
   * never proven: its children are found, and their floating targets fixed, only by its own discovery.
   */
  static atTarget(mount: SvnMountState, target: SvnUpdateTarget, mappingChanged: boolean): boolean {
    return target.kind === 'dir' && mount.base === target.revision && mount.url === target.url && mount.repository === target.repository
      && !mount.missing && !mount.switched && !mount.skipped && !mount.carrier && !mappingChanged
  }

  async recover(sessionId: string, entry: SvnStepJournalEntry, main: boolean): Promise<boolean> {
    const state = this.read(sessionId)
    if (state === undefined || state.completed || entry.kind !== 'update') return false
    // The unit at the cursor, or a later mount a conflict pause updated (D5).
    const index = state.units.findIndex((unit, at) => at >= state.cursor && entry.stepId === this.stepId(state, at, unit.phase === 'reconciling'))
    const unit = state.units[index]
    if (unit === undefined || entry.targetRevision !== unit.target.revision || entry.cwd !== this.cwd(unit.target)) return false
    if (!main) {
      const cleanup = await this.deps.runner.run(sessionId, 'cleanup', this.cwd(unit.target), ['cleanup', '--', '.'],
        { stepId: `${entry.stepId}-recovery-cleanup`, attempt: entry.attempt })
      if (!cleanup.ok) throw new Error(cleanup.output)
    }
    if (!await this.deps.records.update(sessionId, (record) => record.worktreeLifecycle === undefined ? null : {
      ...record, worktreeLifecycle: { ...record.worktreeLifecycle, version: record.worktreeLifecycle.version + 1,
        journal: record.worktreeLifecycle.journal.map((row) => row.runId === entry.runId
          ? { ...row, endedAt: row.endedAt ?? Date.now(), outcome: row.outcome ?? 'other' } : row) },
    })) throw new Error('The interrupted update journal could not be retained')
    return true
  }

  pending(sessionId: string): boolean { const state = this.read(sessionId); return state !== undefined && !state.completed }

  /** A Finish resumed after Keep owns no update yet, so it has not reached any target. */
  reached(sessionId: string, actionId: string): boolean {
    const state = this.read(sessionId)
    return state !== undefined && state.completed && state.actionId === actionId
  }

  async retry(sessionId: string): Promise<void> {
    if (!await this.deps.records.update(sessionId, (record) => {
      const state = record.worktreeLifecycle
      if (state?.update === undefined || state.update.completed) return null
      return { ...record, worktreeLifecycle: { ...state, version: state.version + 1, stoppedFailure: undefined,
        update: { ...state.update, generation: randomUUID() } } }
    })) throw new Error('The update retry could not be saved')
    this.deps.changed()
  }

  /**
   * svn update exits 0 with postponed conflicts; it prints `Summary of conflicts:` and a `C` in a status
   * column for each one, also for paths it skipped as still conflicted.
   */
  static conflictFree(output: string): boolean {
    return !/Summary of conflicts|^Skipped|^.{0,3}C /m.test(output)
  }

  /** The unit at the cursor up to `reconciled` with its children enqueued, proven at its target, or the conflicts it met. */
  private async advance(sessionId: string, state: WorktreeUpdateState, round: WorktreeRound): Promise<'proven' | 'reconciled' | SvnConflictFact[]> {
    const index = state.cursor
    const unit = state.units[index]
    const target = unit.target
    if (!PathCompare.isInside(round.root, target.path)) throw new Error('An update target is outside its owner')
    if (!await this.parentHolds(state, unit, round)) throw new Error(WorktreeUpdate.definitionsChanged(target.path))
    if (unit.phase === 'pending' && unit.parent !== undefined && target.kind === 'dir') {
      round.mounts ??= await this.mounts(round.root)
      const mount = round.mounts.get(PathCompare.comparable(target.path))
      if (mount !== undefined && WorktreeUpdate.atTarget(mount, target, unit.mappingChanged === true)) {
        round.proven.push({ target, reason: 'at-target' })
        return 'proven'
      }
    }
    const clean = unit.phase === 'pending' && await this.update(sessionId, state, index)
    // The conflict read walks the whole tree with every mount; a unit resumed from a saved phase still reads it.
    if (!clean) {
      const facts = await this.conflicts(round)
      if (facts.length > 0) return facts
    }
    await this.deps.targets.verify(target, true, round.skipped)
    let snapshot = await this.deps.targets.snapshot(target)
    // Externals found while this unit's conflicts waited were enqueued under the definitions saved then.
    if (unit.definitions !== undefined && JSON.stringify(unit.definitions) !== JSON.stringify(snapshot.properties))
      throw new Error(WorktreeUpdate.definitionsChanged(target.path))
    for (const mount of unit.protectedMounts ?? []) {
      const current = snapshot.children.find((child) => PathCompare.comparable(child.path) === PathCompare.comparable(mount.path))
      if (current === undefined || current.url !== mount.url || current.repository !== mount.repository)
        throw new Error(`External ${mount.path} contains local changes and its definition was removed or redirected. Its working copy is preserved at ${mount.url}. Restore that definition or preserve and resolve its changes before retrying.`)
    }
    if (unit.phase === 'updated') {
      const changed = unit.mappingChanged || JSON.stringify(unit.before) !== JSON.stringify(snapshot.properties)
      if (snapshot.mismatched.length > 0 && !changed)
        throw new Error(`External URL differs from its unchanged definition: ${snapshot.mismatched.join(', ')}`)
      if (changed || snapshot.missing.length > 0 || snapshot.children.some((child) => child.kind === 'file')) {
        unit.phase = 'reconciling'
        await this.save(sessionId, state)
      } else unit.phase = 'reconciled'
    }
    if (unit.phase === 'reconciling') {
      // Direct file UPDATE can drop SVN's file-external registration; its carrier must update it.
      await this.command(sessionId, state, index, true)
      round.mounts = null
      unit.phase = 'reconciled'
      await this.save(sessionId, state)
      const facts = await this.conflicts(round)
      if (facts.length > 0) return facts
      await this.deps.targets.verify(target, true, round.skipped)
      snapshot = await this.deps.targets.snapshot(target)
    }
    if (snapshot.missing.length > 0 || snapshot.mismatched.length > 0) {
      unit.phase = 'reconciling'
      await this.save(sessionId, state)
      throw new Error(`SVN did not reconcile external mounts: ${[...snapshot.missing, ...snapshot.mismatched].join(', ')}`)
    }
    if (unit.phase !== 'reconciled') throw new Error(`Unexpected update phase: ${unit.phase}`)
    WorktreeUpdate.enqueue(state, index, snapshot)
    unit.definitions = snapshot.properties
    return 'reconciled'
  }

  /**
   * D5: before the conflicts of the unit at the cursor are handed over, every later mount without
   * local changes takes its update. svn raises no conflict in such a mount, and the paused conflict
   * files lie outside it; a mount with local changes waits for them (G2). A unit whose conflicts leave
   * its definitions readable finds its externals first, so the conflicts of a root wait for them too.
   * A failed update stops here; the unit at its turn meets it again.
   */
  private async cleanMounts(sessionId: string, state: WorktreeUpdateState, round: WorktreeRound, facts: readonly SvnConflictFact[]): Promise<void> {
    const index = state.cursor
    const unit = state.units[index]
    if (unit.phase === 'updated' && unit.target.kind === 'dir' && !state.units.some((row) => row.parent === index)
      && facts.every((fact) => fact.kind === 'text' || fact.kind === 'property' && !fact.properties.some((property) => property.name === 'svn:externals'))) {
      const snapshot = await this.deps.targets.snapshot(unit.target)
      if (!unit.mappingChanged && JSON.stringify(unit.before) === JSON.stringify(snapshot.properties) && snapshot.missing.length === 0
        && snapshot.mismatched.length === 0 && snapshot.children.every((child) => child.kind === 'dir')) {
        WorktreeUpdate.enqueue(state, index, snapshot)
        unit.definitions = snapshot.properties
        await this.save(sessionId, state)
      }
    }
    round.mounts ??= await this.mounts(round.root)
    for (let later = index + 1; later < state.units.length; later++) {
      const row = state.units[later]
      const mount = round.mounts.get(PathCompare.comparable(row.target.path))
      if (row.phase !== 'pending' || mount === undefined || mount.localChanges || WorktreeUpdate.atTarget(mount, row.target, row.mappingChanged === true)) continue
      if (!await this.parentHolds(state, row, round)) return
      try {
        if (!await this.update(sessionId, state, later)) return
      } catch (error) {
        if (error instanceof WorktreeUpdateFailure) return
        throw error
      }
    }
  }

  /** The `pending` phase of a unit: its definitions saved, then its own update; whether svn reported no conflict. */
  private async update(sessionId: string, state: WorktreeUpdateState, index: number): Promise<boolean> {
    const unit = state.units[index]
    const target = unit.target
    if (unit.before === undefined) {
      const before = await this.deps.targets.snapshot(target, false, true)
      unit.before = before.properties
      unit.protectedMounts = before.protectedMounts
      unit.mappingChanged = before.localMappingChanges
      await this.save(sessionId, state)
    }
    let clean: boolean
    if (target.kind === 'dir') clean = await this.command(sessionId, state, index, false)
    else if (target.kind === 'file') { await this.deps.targets.verify(target); clean = true }
    else throw new Error(`Unknown update target kind: ${JSON.stringify(target.kind satisfies never)}`)
    unit.phase = 'updated'
    await this.save(sessionId, state)
    return clean
  }

  /**
   * The children a unit's definitions name. An external enqueued while the unit's conflicts waited
   * keeps the numeric target it was enqueued with, as a retry does (G1).
   */
  private static enqueue(state: WorktreeUpdateState, index: number, snapshot: SvnUpdateSnapshot): void {
    for (const child of snapshot.children) {
      const known = state.units.find((row) => PathCompare.comparable(row.target.path) === PathCompare.comparable(child.path))
      if (known === undefined) state.units.push({ target: child, phase: 'pending', parent: index })
      else if (known.target.url !== child.url || known.target.revision !== child.revision && (known.parent !== index || known.target.pinned))
        throw new Error(`Conflicting external definitions own ${child.path}`)
    }
  }

  private async parentHolds(state: WorktreeUpdateState, unit: WorktreeUpdateUnit, round: WorktreeRound): Promise<boolean> {
    if (unit.parent === undefined || round.compared.has(unit.parent)) return true
    round.compared.add(unit.parent)
    const parent = state.units[unit.parent]
    const current = await this.deps.targets.snapshot(parent.target, false)
    return JSON.stringify(current.properties) === JSON.stringify(parent.definitions)
  }

  private static definitionsChanged(path: string): string {
    return `External definitions changed while updating ${path}. Preserve local external work, inspect the incoming mapping, then start a new preparation with the intended definitions. Do not revert an upstream definition just to resume this update.`
  }

  private async command(sessionId: string, state: WorktreeUpdateState, index: number, reconcile: boolean): Promise<boolean> {
    const unit = state.units[index]
    const target = unit.target
    const own = relative(state.root, target.path).replace(/\\/g, '/') || '.'
    const stepId = this.stepId(state, index, reconcile)
    await this.deps.targets.verify(target, false)
    const previous = this.deps.records.get(sessionId)?.worktreeLifecycle?.journal.filter((entry) => entry.stepId === stepId).at(-1)
    const result = await this.deps.runner.run(sessionId, 'update', this.cwd(target),
      ['update', '-r', String(target.revision), ...reconcile ? [] : ['--ignore-externals'], '--accept', 'postpone', '--',
        target.kind === 'dir' ? '.' : `${relative(dirname(target.path), target.path)}@`],
      { stepId, attempt: (previous?.attempt ?? 0) + 1, targetRevision: target.revision, paths: [own] },
      { title: reconcile ? `Reconcile externals in ${own}` : `Update ${own} to r${target.revision}${target.pinned ? ' (pinned)' : ''}` })
    unit.runId = result.runId
    if (!result.ok && result.failure !== 'conflict') throw new WorktreeUpdateFailure(result)
    return result.ok && WorktreeUpdate.conflictFree(result.output)
  }

  /** An svn command of this update whose end no journal row records; recovery owns it, not a new update. */
  private open(sessionId: string, state: WorktreeUpdateState): boolean {
    const prefix = `${state.actionId}-update-${state.generation}-`
    return this.deps.records.get(sessionId)?.worktreeLifecycle?.journal
      .some((entry) => entry.stepId.startsWith(prefix) && entry.endedAt === undefined) ?? false
  }

  private stepId(state: WorktreeUpdateState, index: number, reconcile: boolean): string {
    return `${state.actionId}-update-${state.generation}-${index}${reconcile ? '-externals' : ''}`
  }

  private cwd(target: SvnUpdateTarget): string { return target.kind === 'dir' ? target.path : dirname(target.path) }

  private read(sessionId: string): WorktreeUpdateState | undefined {
    return this.deps.records.get(sessionId)?.worktreeLifecycle?.update
  }

  /** No read is no proof: every mount then takes the path of an update. */
  private async mounts(root: string): Promise<ReadonlyMap<string, SvnMountState>> {
    const read = await this.deps.svn.mountStates(root)
    return read.ok ? read.value : new Map()
  }

  /** The one journal row of the units this call left without an svn command (D3); its run id, or none. */
  private async summary(sessionId: string, state: WorktreeUpdateState, skipped: ReadonlyArray<{ target: SvnUpdateTarget; reason: WorktreeUpdateSkip }>)
    : Promise<string | undefined> {
    if (skipped.length === 0) return undefined
    const own = (target: SvnUpdateTarget): string => relative(state.root, target.path).replace(/\\/g, '/')
    const parts = [...new Set(skipped.map((row) => row.reason))].map((reason) => WorktreeUpdate.skippedOf(reason, skipped.flatMap((row) => row.reason === reason ? [row.target] : [])))
    const text = skipped.map(({ target }) => `  ${own(target)} r${target.revision}\n`).join('')
    const intent = { stepId: `${state.actionId}-update-${state.generation}-${state.cursor}-skipped`, attempt: 1, paths: skipped.map(({ target }) => own(target)) }
    return this.deps.runner.note(sessionId, 'update', state.root, intent, parts.map((part) => part.title).join('; '),
      `${parts.map((part) => part.detail).join('\n')}\n${text}`)
  }

  private static skippedOf(reason: WorktreeUpdateSkip, targets: readonly SvnUpdateTarget[]): { title: string; detail: string } {
    switch (reason) {
      case 'at-target': {
        const revisions = [...new Set(targets.map((target) => target.revision))].sort((a, b) => a - b).map((revision) => `r${revision}`).join(', ')
        return { title: `${targets.length} external${targets.length === 1 ? '' : 's'} already at ${revisions}`,
          detail: 'One read of this round proved these mounts at their revision, so no svn update ran in them:' }
      }
      default: throw new Error(`Unknown update skip: ${JSON.stringify(reason satisfies never)}`)
    }
  }

  /** The conflicts svn marks that it did not hold before the update. */
  private async conflicts(round: WorktreeRound): Promise<SvnConflictFact[]> {
    const conflicts = await this.deps.svn.conflictSet(round.root, round.revision)
    if (!conflicts.ok) throw new Error(conflicts.detail)
    return conflicts.value.facts.filter((fact) => !round.older.includes(fact.path))
  }

  /** A completed update brought every incoming change it was started after, so a known one is no longer pending. */
  private async save(sessionId: string, update: WorktreeUpdateState, completed = false): Promise<void> {
    if (!await this.deps.records.update(sessionId, (record) => record.worktreeLifecycle === undefined ? null : {
      ...record, worktreeLifecycle: { ...record.worktreeLifecycle, version: record.worktreeLifecycle.version + 1, update: structuredClone(update),
        ...completed ? { knownIncoming: undefined } : {} },
    })) throw new Error('The update cursor could not be saved')
    this.deps.changed()
  }
}
