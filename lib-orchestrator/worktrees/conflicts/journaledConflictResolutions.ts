import { createHash } from 'node:crypto'
import { SvnConflictResolutions } from '../../svn/svnConflictResolutions'
import { SvnCommand } from '../../svn/svnCommand'
import type { SvnConflictApply } from '../../svn/svn.types'
import type { SvnWorktreeManager } from '../../svn/svnWorktreeManager'
import type { SessionRecordsStore } from '../../sessionManager/worktreeSessionRecords'
import type { SvnStepRunner } from '../svnStepRunner'
import type { WorktreeSvnCommands } from '../worktreeSvnCommands'

export class JournaledConflictResolutions {
  private readonly deps: { records: SessionRecordsStore; commands: WorktreeSvnCommands; runner: Pick<SvnStepRunner, 'run'>;
    svn: Pick<SvnWorktreeManager, 'locked'>; now(): number; markersIn(root: string, paths: readonly string[]): Promise<string[]> }

  constructor(deps: JournaledConflictResolutions['deps']) { this.deps = deps }

  async apply(input: SvnConflictApply) {
    const executor = this.executor(input.actionId, input.path, input.occurrenceId, input.option)
    if (executor === null) return { ok: false as const, code: 'refused' as const, detail: 'Conflict resolution has no persisted action owner' }
    return executor.apply(input)
  }

  async recoverLocked(root: string, savedDir: string, actionId?: string, occurrences: readonly string[] = []) {
    const executor = this.executor(actionId, '.', undefined, 'recovery')
    if (executor === null) return { ok: false as const, code: 'refused' as const, detail: 'Conflict recovery has no persisted action owner' }
    return this.deps.commands.lease.within(root, 'resolve', () => executor.recoverLocked(root, savedDir, actionId, occurrences))
  }

  async recoveredChoice(input: Parameters<SvnConflictResolutions['recoveredChoice']>[0]) {
    const executor = this.executor(input.actionId, input.path, input.occurrenceId, 'recovery')
    return executor === null ? null : executor.recoveredChoice(input)
  }

  private executor(actionId: string | undefined, path: string, occurrenceId: string | undefined, option: string): SvnConflictResolutions | null {
    const owner = this.deps.records.list().find((record) => actionId !== undefined
      && (record.worktreeLifecycle?.actionId === actionId || record.svnAction?.actionId === actionId))
    if (owner === undefined) return null
    return new SvnConflictResolutions({ now: this.deps.now, markersIn: this.deps.markersIn,
      afterFilesChanged: (root) => this.deps.commands.accept(root),
      svn: { run: async (cwd, args, options) => {
        const command = SvnCommand.of(args)
        if (command !== null && SvnCommand.reads.has(command)) return this.deps.commands.run(cwd, args, options)
        const stepId = `${actionId}-conflict-${createHash('sha256').update(JSON.stringify([occurrenceId, path, option, args])).digest('hex')}`
        const journal = this.deps.records.get(owner.sessionId)?.worktreeLifecycle?.journal ?? []
        const attempt = journal.filter((entry) => entry.stepId === stepId).length + 1
        const result = await this.deps.runner.run(owner.sessionId, command === 'cleanup' ? 'cleanup' : command === 'revert' ? 'revert' : 'resolve', cwd, args,
          { stepId, attempt, paths: [path] })
        return { code: result.exitCode, stdout: result.ok ? result.output : '', stderr: result.ok ? '' : result.output, failure: null }
      } } })
  }
}
