import { join } from 'node:path'
import type { SvnWorktreeManager } from '../../svn/svnWorktreeManager'
import type { SessionRecordsStore } from '../../sessionManager/worktreeSessionRecords'
import type { WorktreeRemovalPermit } from '../removal/worktreeRemovalPermit'

export class DispositionStep {
  private readonly records: SessionRecordsStore
  private readonly svn: Pick<SvnWorktreeManager, 'changes' | 'revertSetup'>

  constructor(records: SessionRecordsStore, svn: DispositionStep['svn']) { this.records = records; this.svn = svn }

  async run(sessionId: string, savedDirectory: string, keepWorktree = false): Promise<WorktreeRemovalPermit | null> {
    const record = this.records.get(sessionId)
    const state = record?.worktreeLifecycle
    if (record?.worktree === undefined || state?.step !== 'disposing' || !state.verified?.length
      && !(state.approvedAt !== undefined && state.review?.selection.length === 0))
      throw new Error('Dispositions require verified publication or an approved empty selection')
    if (keepWorktree) {
      await this.records.update(sessionId, (latest) => latest.worktreeLifecycle === undefined ? null : {
        ...latest, worktreeLifecycle: { ...latest.worktreeLifecycle, version: latest.worktreeLifecycle.version + 1, phase: 'kept', step: undefined, wait: undefined } })
      return null
    }
    const root = record.worktree.worktreePath
    const baseline = { ...record.worktree.setupBaseline?.hashes, ...state.checkBaseline }
    const changes = await this.svn.changes(root)
    if (!changes.ok) throw new Error(changes.detail)
    const paths = changes.value.filter((row) => !row.conflict && Object.hasOwn(baseline, row.path)).map((row) => row.path)
    const reverted = await this.svn.revertSetup(root, paths, baseline, join(savedDirectory, 'setup'))
    if (!reverted.ok) throw new Error(reverted.detail)
    const left = await this.svn.changes(root)
    if (!left.ok) throw new Error(left.detail)
    if (left.value.length > 0) {
      await this.records.update(sessionId, (latest) => latest.worktreeLifecycle === undefined ? null : {
        ...latest, worktreeLifecycle: { ...latest.worktreeLifecycle, version: latest.worktreeLifecycle.version + 1, phase: 'waiting',
          wait: { kind: 'removal-blocked', at: Date.now(), reason: `Preserved changes need a disposition: ${left.value.map((row) => row.path).join(', ')}` } } })
      return null
    }
    const permit: WorktreeRemovalPermit = { kind: 'clean', provedAt: Date.now(), allowed: paths }
    if (!await this.records.update(sessionId, (latest) => latest.worktreeLifecycle === undefined ? null : {
      ...latest, worktreeLifecycle: { ...latest.worktreeLifecycle, version: latest.worktreeLifecycle.version + 1,
        phase: 'finishing', step: 'stopping-worker', wait: undefined, removalPermit: permit },
    })) throw new Error('The clean removal permit could not be saved')
    return permit
  }
}
