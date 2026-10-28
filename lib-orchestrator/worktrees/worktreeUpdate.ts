import type { WorktreeUpdateUnit, WorktreeUpdateState } from './worktreeContracts'
export type { WorktreeUpdateUnit, WorktreeUpdateState } from './worktreeContracts'
import { randomUUID } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'
import { PathCompare } from '../shared/pathCompare'
import type { SessionRecordsStore } from '../sessionManager/worktreeSessionRecords'
import type { SvnUpdateTarget, SvnUpdateTargets } from '../svn/svnUpdateTargets'
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

export class WorktreeUpdate {
  private readonly deps: {
    records: SessionRecordsStore
    runner: Pick<SvnStepRunner, 'run'>
    targets: Pick<SvnUpdateTargets, 'owner' | 'snapshot' | 'verify'>
    svn: Pick<SvnWorktreeManager, 'conflictSet'>
    changed: () => void
  }

  constructor(deps: WorktreeUpdate['deps']) { this.deps = deps }

  /**
   * `older`: root-relative paths svn marked as conflicted before this update. svn skips them and
   * updates everything else, so they stop no target and are left to the person as they are.
   */
  async run(sessionId: string, actionId: string, root: string, revision: number, older: readonly string[] = [])
    : Promise<{ complete: boolean; revision: number; runId?: string }> {
    const skipped = older.map((path) => resolve(root, path))
    const failure = this.deps.records.get(sessionId)?.worktreeLifecycle?.updateFailure
    if (failure !== undefined) throw new Error(failure)
    let state = structuredClone(this.read(sessionId))
    if (state === undefined || state.completed || state.actionId !== actionId || PathCompare.comparable(state.root) !== PathCompare.comparable(root)) {
      if (state !== undefined && !state.completed) throw new Error('An unfinished update belongs to another action or working copy')
      const target = await this.deps.targets.owner(root, revision)
      state = { actionId, generation: randomUUID(), root, revision, cursor: 0, units: [{ target, phase: 'pending' }], completed: false }
      await this.save(sessionId, state)
    }
    while (state.cursor < state.units.length) {
      const unit = state.units[state.cursor]
      const target = unit.target
      if (!PathCompare.isInside(root, target.path)) throw new Error('An update target is outside its owner')
      if (unit.parent !== undefined) {
        const parent = state.units[unit.parent]
        const current = await this.deps.targets.snapshot(parent.target, false)
        if (JSON.stringify(current.properties) !== JSON.stringify(parent.definitions))
          throw new Error(`External definitions changed while updating ${target.path}. Preserve local external work, inspect the incoming mapping, then start a new preparation with the intended definitions. Do not revert an upstream definition just to resume this update.`)
      }
      if (unit.phase === 'pending') {
        if (unit.before === undefined) {
          const before = await this.deps.targets.snapshot(target, false, true)
          unit.before = before.properties
          unit.protectedMounts = before.protectedMounts
          unit.mappingChanged = before.localMappingChanges
          await this.save(sessionId, state)
        }
        if (target.kind === 'dir') await this.command(sessionId, state, unit, false)
        else if (target.kind === 'file') await this.deps.targets.verify(target)
        else throw new Error(`Unknown update target kind: ${JSON.stringify(target.kind satisfies never)}`)
        unit.phase = 'updated'
        await this.save(sessionId, state)
      }
      if (await this.conflicted(root, state.revision, older)) return { complete: false, revision: state.revision, runId: unit.runId }
      await this.deps.targets.verify(target, true, skipped)
      let snapshot = await this.deps.targets.snapshot(target)
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
        await this.command(sessionId, state, unit, true)
        unit.phase = 'reconciled'
        await this.save(sessionId, state)
        if (await this.conflicted(root, state.revision, older)) return { complete: false, revision: state.revision, runId: unit.runId }
        await this.deps.targets.verify(target, true, skipped)
        snapshot = await this.deps.targets.snapshot(target)
      }
      if (snapshot.missing.length > 0 || snapshot.mismatched.length > 0) {
        unit.phase = 'reconciling'
        await this.save(sessionId, state)
        throw new Error(`SVN did not reconcile external mounts: ${[...snapshot.missing, ...snapshot.mismatched].join(', ')}`)
      }
      if (unit.phase !== 'reconciled') throw new Error(`Unexpected update phase: ${unit.phase}`)
      for (const child of snapshot.children) {
        const known = state.units.find((row) => PathCompare.comparable(row.target.path) === PathCompare.comparable(child.path))
        if (known !== undefined) {
          if (known.target.url !== child.url || known.target.revision !== child.revision)
            throw new Error(`Conflicting external definitions own ${child.path}`)
        } else state.units.push({ target: child, phase: 'pending', parent: state.cursor })
      }
      unit.definitions = snapshot.properties
      unit.phase = 'done'
      state.cursor++
      await this.save(sessionId, state)
    }
    state.completed = true
    await this.save(sessionId, state, true)
    return { complete: true, revision: state.revision, runId: state.units.at(-1)?.runId }
  }

  async recover(sessionId: string, entry: SvnStepJournalEntry, main: boolean): Promise<boolean> {
    const state = this.read(sessionId)
    if (state === undefined || state.completed) return false
    const unit = state.units[state.cursor]
    if (unit === undefined || entry.kind !== 'update' || entry.stepId !== this.stepId(state, unit.phase === 'reconciling')
      || entry.targetRevision !== unit.target.revision || entry.cwd !== this.cwd(unit.target)) return false
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

  private async command(sessionId: string, state: WorktreeUpdateState, unit: WorktreeUpdateUnit, reconcile: boolean): Promise<void> {
    const target = unit.target
    const own = relative(state.root, target.path).replace(/\\/g, '/') || '.'
    const stepId = this.stepId(state, reconcile)
    await this.deps.targets.verify(target, false)
    const previous = this.deps.records.get(sessionId)?.worktreeLifecycle?.journal.filter((entry) => entry.stepId === stepId).at(-1)
    const result = await this.deps.runner.run(sessionId, 'update', this.cwd(target),
      ['update', '-r', String(target.revision), ...reconcile ? [] : ['--ignore-externals'], '--accept', 'postpone', '--',
        target.kind === 'dir' ? '.' : `${relative(dirname(target.path), target.path)}@`],
      { stepId, attempt: (previous?.attempt ?? 0) + 1, targetRevision: target.revision, paths: [own] },
      { title: reconcile ? `Reconcile externals in ${own}` : `Update ${own} to r${target.revision}${target.pinned ? ' (pinned)' : ''}` })
    unit.runId = result.runId
    if (!result.ok && result.failure !== 'conflict') throw new WorktreeUpdateFailure(result)
  }

  private stepId(state: WorktreeUpdateState, reconcile: boolean): string {
    return `${state.actionId}-update-${state.generation}-${state.cursor}${reconcile ? '-externals' : ''}`
  }

  private cwd(target: SvnUpdateTarget): string { return target.kind === 'dir' ? target.path : dirname(target.path) }

  private read(sessionId: string): WorktreeUpdateState | undefined {
    return this.deps.records.get(sessionId)?.worktreeLifecycle?.update
  }

  private async conflicted(root: string, revision: number, older: readonly string[]): Promise<boolean> {
    const conflicts = await this.deps.svn.conflictSet(root, revision)
    if (!conflicts.ok) throw new Error(conflicts.detail)
    return conflicts.value.facts.some((fact) => !older.includes(fact.path))
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
