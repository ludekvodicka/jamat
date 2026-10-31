import { FinishProjection } from './finishProjection'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { PathCompare } from '../../shared/pathCompare'
import type { SvnWorktreeManager } from '../../svn/svnWorktreeManager'
import type { SessionRecordSvnAction } from '../../sessionManager/worktreeSessionRecords'
import type { SessionRecordsStore } from '../../sessionManager/worktreeSessionRecords'
import type { ScriptLogStore } from '../../sessionManager/worktreeSessionScripts'
import type { SvnStepRunner, SvnStepResult } from '../svnStepRunner'
import type { SvnStepJournalEntry } from '../worktreeState'

/** `candidates`: the revisions that may hold the commit, for a person to inspect; none of them is proven ours. */
export type CommitRecovery = { kind: 'landed'; revision: number } | { kind: 'not-landed' } | { kind: 'ambiguous'; reason: string; candidates: number[] }
export type CommitPublication = { kind: 'waiting' | 'review' | 'syncing' | 'repository-busy' }
  | { kind: 'completed'; result: SvnStepResult }

export interface CommitStepDeps {
  records: SessionRecordsStore
  runner: Pick<SvnStepRunner, 'run'>
  svn: Pick<SvnWorktreeManager, 'prepareCommit' | 'logSince'>
  logs: Pick<ScriptLogStore, 'writeCommitFiles'>
  now: () => number
}

export class CommitStep {
  private readonly deps: CommitStepDeps

  constructor(deps: CommitStepDeps) {
    this.deps = deps
  }

  static messageHash(message: string): string {
    return createHash('sha256').update(message.replace(/\r\n/g, '\n')).digest('hex')
  }

  async publish(sessionId: string, action: SessionRecordSvnAction, control: {
    commands: Pick<import('../worktreeSvnCommands').WorktreeSvnCommands, 'lease' | 'verify'>
    svn: Pick<SvnWorktreeManager, 'commitHashes' | 'unprepareCommit' | 'assembly'>
    busyReason: (sessionId: string) => string | null
    holdInput: (sessionId: string) => () => void
  }): Promise<CommitPublication> {
    return control.commands.lease.within(action.root, 'commit', async () => {
      const record = this.deps.records.get(sessionId)
      const state = record?.worktreeLifecycle
      const stored = record === null ? undefined : FinishProjection.action(record)
      if (state?.review === undefined || state.approvedAt === undefined || state.preparation?.checkedAt === undefined || stored?.actionId !== action.actionId)
        return { kind: 'review' }
      if (state.phase !== 'finishing' || state.step !== 'awaiting-idle' && state.step !== 'committing') return { kind: 'review' }
      const approved = state.review
      const root = action.roots?.[action.rootCursor]
      const storedRoot = stored!.roots?.[stored!.rootCursor]
      if (root === undefined || storedRoot === undefined || record?.worktree === undefined
        || PathCompare.comparable(action.root) !== PathCompare.comparable(record.worktree.worktreePath)
        || !PathCompare.isInside(action.root, root.path) || JSON.stringify(root) !== JSON.stringify(storedRoot)) return { kind: 'review' }
      const selected = approved.selection.map((path) => resolve(action.root, path))
      const same = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length
        && left.every((path) => right.some((other) => PathCompare.comparable(path) === PathCompare.comparable(other)))
      const rootSelection = selected.filter((path) => PathCompare.isInside(root.path, path)
        && !action.roots!.some((other) => other.path !== root.path && PathCompare.isInside(root.path, other.path) && PathCompare.isInside(other.path, path)))
      if (!same(root.selection ?? [], rootSelection)) return { kind: 'review' }
      if (action.commit === undefined || !same(action.commit.selection, selected) || action.commit.message !== approved.message
        || (action.commit.messageSource ?? 'unknown') !== approved.source
        || JSON.stringify([...(action.commit.acknowledgedFindings ?? [])].sort()) !== JSON.stringify([...approved.acknowledged].sort())
        || selected.some((_path, index) => action.commit!.hashes[approved.selection[index]] !== approved.hashes[approved.selection[index]])
        || action.roots?.[action.rootCursor]?.selection?.some((path) => !selected.some((other) => PathCompare.comparable(path) === PathCompare.comparable(other)))
        || JSON.stringify(stored!.commit) !== JSON.stringify(action.commit) || stored!.rootCursor !== action.rootCursor)
        return { kind: 'review' }
      const stepId = `${action.actionId}-commit-${root.own || '.'}`
      if (state.journal.some((entry) => entry.stepId === stepId && entry.attempt === state.outOfDate + 1 && entry.recovered !== 'not-landed'
        && !state.verified?.some((receipt) => receipt.revision === entry.revision && PathCompare.comparable(receipt.root) === PathCompare.comparable(root.path)))) return { kind: 'review' }
      // Only the person's confirmation of this very approval publishes under a busy worker; a flag
      // carried from an earlier press does not.
      const busy = control.busyReason(sessionId)
      if (busy !== null && state.busyConfirmedFor !== state.approvedAt) {
        await this.publicationState(sessionId, (state) => ({ ...state, phase: 'finishing', step: 'awaiting-idle',
          awaitingIdleAt: state.awaitingIdleAt ?? this.deps.now(), awaitingIdleReason: busy }), state.version)
        return { kind: 'waiting' }
      }
      const release = control.holdInput(sessionId)
      try {
        await control.commands.verify(action.root)
        const hashes = await control.svn.commitHashes(action.root, state.review.selection, 'node')
        if (!hashes.ok) throw new Error(hashes.detail)
        const changed = state.review.selection.filter((path) => hashes.value[path] !== state.review!.hashes[path])
        if (changed.length > 0) {
          await this.publicationState(sessionId, (latest) => ({ ...latest, phase: 'waiting', step: 'reviewing', approvedAt: undefined,
            preparation: undefined, checks: undefined, wait: { kind: 'review', reason: 'The reviewed files changed; prepare and verify again', at: this.deps.now() },
            review: { ...state.review!, version: latest.version + 1, hashes: { ...state.review!.hashes, ...hashes.value } } }), state.version)
          return { kind: 'review' }
        }
        if (!await this.deps.records.update(sessionId, (latest) => latest.worktreeLifecycle?.version !== state.version
          || latest.worktreeLifecycle.approvedAt !== state.approvedAt || FinishProjection.action(latest)?.actionId !== action.actionId ? null : {
            ...latest, worktreeLifecycle: { ...latest.worktreeLifecycle, version: state.version + 1, phase: 'finishing', step: 'committing', wait: undefined,
              awaitingIdleAt: undefined, awaitingIdleReason: undefined },
          })) return { kind: 'review' }
        let preparedHashes: Record<string, string> | undefined
        let incoming: string[] = []
        const result = await this.run(sessionId, { ...action, rounds: { ...action.rounds, outOfDate: state.outOfDate } }, async () => {
          const assembly = await control.svn.assembly(action.root, true)
          if (!assembly.ok) throw new Error(assembly.detail)
          if (assembly.value.content !== state.preparation!.content || assembly.value.metadata !== state.preparation!.metadata || assembly.value.incoming.length > 0) {
            preparedHashes = approved.hashes
            incoming = assembly.value.incoming
            return 'The tested assembly or repository changed; prepare and verify again before publication'
          }
          const hashes = await control.svn.commitHashes(action.root, approved.selection, 'node')
          if (!hashes.ok) throw new Error(hashes.detail)
          const changed = approved.selection.filter((path) => hashes.value[path] !== approved.hashes[path])
          if (changed.length === 0) return
          preparedHashes = hashes.value
          return `Commit preparation changed the reviewed content or properties: ${changed.join(', ')}. Review the prepared changes before publication.`
        })
        if (preparedHashes !== undefined) {
          await this.publicationState(sessionId, (latest) => ({ ...latest, phase: 'waiting', step: 'reviewing', approvedAt: undefined, checks: undefined,
            preparation: undefined, wait: { kind: 'review', reason: 'The tested assembly changed; prepare and verify again', at: this.deps.now() },
            ...incoming.length === 0 ? {} : { knownIncoming: { paths: incoming, at: this.deps.now() } },
            review: { ...approved, version: latest.version + 1, hashes: { ...approved.hashes, ...preparedHashes } },
            journal: latest.journal.map((entry) => entry.runId === result.runId ? { ...entry, recovered: 'not-landed' as const } : entry) }))
          return { kind: 'review' }
        }
        if (!result.ok && result.failure === 'out-of-date') {
          const latest = this.deps.records.get(sessionId)
          const attempts = (latest?.worktreeLifecycle?.outOfDate ?? 0) + 1
          const history = await this.deps.svn.logSince(action.root, action.roots?.[action.rootCursor].bounds?.since ?? 0)
          if (!history.ok) throw new Error(history.detail)
          const incoming = history.value.map(({ revision, author }) => ({ revision, author }))
          await this.publicationState(sessionId, (state) => ({ ...state, outOfDate: attempts, incoming,
            phase: 'waiting', step: 'syncing', approvedAt: undefined, preparation: undefined, checks: undefined,
            wait: { kind: (state.execution?.evidence.length ?? 0) > 0 ? 'partially-landed' : 'repository-busy', at: this.deps.now(),
              reason: 'Repository changed. Published revisions are retained. Prepare, test and confirm the remaining changes again.' } }))
          return { kind: 'repository-busy' }
        }
        if (result.ok) await this.publicationState(sessionId, (state) => ({ ...state, phase: 'finishing', step: 'verifying', wait: undefined }))
        return { kind: 'completed', result }
      } finally { release() }
    })
  }

  private async publicationState(sessionId: string, update: (state: import('../worktreeState').WorktreeLifecycle) => import('../worktreeState').WorktreeLifecycle, expectedVersion?: number): Promise<void> {
    const saved = await this.deps.records.update(sessionId, (record) => record.worktreeLifecycle === undefined
      || expectedVersion !== undefined && record.worktreeLifecycle.version !== expectedVersion ? null : {
      ...record, worktreeLifecycle: { ...update(record.worktreeLifecycle), version: record.worktreeLifecycle.version + 1 },
    })
    if (!saved && expectedVersion === undefined) throw new Error('The commit publication state could not be saved')
  }

  async run(sessionId: string, action: SessionRecordSvnAction, checkPrepared?: () => Promise<void | string>): Promise<SvnStepResult> {
    const root = action.roots?.[action.rootCursor]
    const commit = action.commit
    if (root?.bounds === undefined || commit === undefined) throw new Error('Commit needs the approved selection and repository bound')
    const relativePaths = (paths: readonly string[]) => paths.map((path) => relative(root.path, path).replace(/\\/g, '/') || '.')
    const repositoryPaths = (paths: readonly string[]) => relativePaths(paths).map((path) => CommitStep.repositoryPath(path === '.' ? root.bounds!.base : `${root.bounds!.base}/${path}`))
    const approved = this.deps.records.get(sessionId)?.worktreeLifecycle?.review
    const message = approved?.repositories?.find((row) => PathCompare.comparable(row.root) === PathCompare.comparable(root.path))?.message ?? commit.message
    const files = await this.deps.logs.writeCommitFiles(sessionId, action.actionId, relativePaths(root.selection ?? []), message)
    if (!files.ok) throw new Error(files.detail)
    const stepId = `${action.actionId}-commit-${root.own || '.'}`
    const attempt = Math.max(action.rounds.outOfDate, ...this.deps.records.get(sessionId)?.worktreeLifecycle?.journal
      .filter((entry) => entry.stepId === stepId).map((entry) => entry.attempt) ?? []) + 1
    return this.deps.runner.run(sessionId, 'commit', root.path,
      ['commit', '--encoding', 'UTF-8', '--targets', files.targetsFile, '-F', files.messageFile, '--depth', 'empty'],
      { stepId, attempt,
        baseRevision: root.bounds.since, paths: repositoryPaths(root.selection ?? []), messageHash: CommitStep.messageHash(message), message, preparedAdds: [] },
      { beforeRun: async () => {
        if (!await this.deps.records.update(sessionId, (record) => {
          const state = record.worktreeLifecycle
          if (state === undefined || FinishProjection.action(record)?.actionId !== action.actionId) return null
          const publication = { ...commit, preparedAdds: [], files: { targetsFile: files.targetsFile, messageFile: files.messageFile } }
          return { ...record, ...(state.execution === undefined ? { svnAction: { ...record.svnAction!, commit: publication } } : {}),
            worktreeLifecycle: { ...state, version: state.version + 1,
              ...(state.execution === undefined ? {} : { execution: { ...state.execution, commit: undefined } }) } }
        })) throw new Error('Commit intent could not be recorded')
        return checkPrepared?.()
      } })
  }

  async recover(entry: SvnStepJournalEntry, root: string): Promise<CommitRecovery> {
    if (entry.baseRevision === undefined || entry.paths === undefined || entry.paths.length === 0 || entry.messageHash === undefined)
      return { kind: 'ambiguous', reason: 'The interrupted commit has incomplete repository evidence', candidates: [] }
    const history = await this.deps.svn.logSince(root, entry.baseRevision)
    if (!history.ok) throw new Error(history.detail)
    const candidates = history.value.filter((row) => row.revision > entry.baseRevision! && CommitStep.messageHash(row.message) === entry.messageHash
      && (entry.revision === undefined || entry.revision === row.revision)
      && (entry.author === undefined || entry.author === row.author)
      && entry.paths!.some((path) => row.paths.some((other) => CommitStep.repositoryPath(path) === CommitStep.repositoryPath(other))))
    const matches = candidates.filter((row) => CommitStep.samePaths(entry.paths!, row.paths))
    if (matches.length === 0) return candidates.length > 0 || entry.revision !== undefined
      ? { kind: 'ambiguous', reason: 'Repository evidence does not exactly match the interrupted commit; inspect it before retrying', candidates: candidates.map((row) => row.revision) }
      : { kind: 'not-landed' }
    if (matches.length > 1) return { kind: 'ambiguous', reason: 'Several repository revisions match the interrupted commit', candidates: matches.map((row) => row.revision) }
    const hit = matches[0]
    const competing = this.deps.records.list().some((record) => {
      const journal = record.worktreeLifecycle?.journal ?? []
      const sameAction = journal.some((other) => other.runId === entry.runId)
      return journal.some((other) =>
      other.kind === 'commit' && other.runId !== entry.runId && other.recovered !== 'not-landed'
      && !(sameAction && other.stepId === entry.stepId && other.attempt < entry.attempt) && other.messageHash === entry.messageHash
      && other.paths !== undefined && other.baseRevision !== undefined && other.baseRevision < hit.revision
      && CommitStep.samePaths(other.paths, hit.paths)
      && (other.author === undefined || other.author === hit.author))
    })
    if (competing) return { kind: 'ambiguous', reason: 'Another worktree commit matches this revision; inspect the repository before continuing', candidates: [hit.revision] }
    return { kind: 'landed', revision: hit.revision }
  }

  private static repositoryPath(path: string): string { return `/${path.split('/').filter((part) => part !== '' && part !== '.').join('/')}` }

  private static samePaths(left: readonly string[], right: readonly string[]): boolean {
    const first = new Set(left.map(CommitStep.repositoryPath))
    const second = new Set(right.map(CommitStep.repositoryPath))
    return first.size === second.size && [...first].every((path) => second.has(path))
  }

  async receipt(sessionId: string, scopeRoot: string, revision: number, paths: string[]): Promise<boolean> {
    return this.deps.records.update(sessionId, (record) => ({ ...record, commitReceipts: [
      ...(record.commitReceipts ?? []).filter((receipt) => receipt.revision !== revision || PathCompare.comparable(receipt.scopeRoot) !== PathCompare.comparable(scopeRoot)),
      { scopeRoot, revision, paths, at: this.deps.now() },
    ].slice(-50) }))
  }
}
