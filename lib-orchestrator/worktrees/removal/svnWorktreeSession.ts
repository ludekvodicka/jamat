import type { SvnResult } from '../../svn/svn.types'
import { join, relative } from 'node:path'
import { PathCompare } from '../../shared/pathCompare'
import { LandedRows } from '../landing/landedRows'
import type { SessionRecord } from '../../sessionManager/worktreeSessionRecords'
import type { SessionsOpResult } from '../../sessionManager/sessionManagerApi.types'
import type { WorktreeLifecycleDeps, WorktreeSessionAdapter } from '../worktreeLifecycle.types'

interface SvnWorktreeSessionDeps extends Pick<WorktreeLifecycleDeps, 'records' | 'requestCleanup' | 'remove'> {
  commitHashes(root: string, paths: readonly string[]): Promise<SvnResult<Record<string, string>>>
  clean(sessionId: string): Promise<void>
}

export class SvnWorktreeSession implements WorktreeSessionAdapter {
  private readonly deps: SvnWorktreeSessionDeps

  constructor(deps: SvnWorktreeSessionDeps) {
    this.deps = deps
  }

  async setupPaths(record: SessionRecord, paths: readonly string[]): Promise<SessionsOpResult<string[]>> {
    const worktree = record.worktree
    if (worktree?.kind !== 'svn' || worktree.setupBaseline === undefined) return { ok: true, value: [] }
    const baseline = worktree.setupBaseline
    const names = paths.filter((path) => PathCompare.isInside(worktree.worktreePath, path))
      .map((path) => relative(worktree.worktreePath, path).replace(/\\/g, '/'))
      .filter((path) => Object.hasOwn(baseline.hashes, path))
    const current = await this.deps.commitHashes(worktree.worktreePath, names)
    if (!current.ok) return { ok: false, code: 'svn-failed', detail: current.detail }
    return { ok: true, value: names.filter((path) => current.value[path] === baseline.hashes[path])
      .map((path) => join(worktree.worktreePath, ...path.split('/'))) }
  }

  async removeWithSession(record: SessionRecord): Promise<SessionsOpResult> {
    const sessionId = record.sessionId
    if (record?.worktree?.kind !== 'svn' || (record.life !== 'ended' && record.life !== 'lost'))
      return this.deps.remove(sessionId)
    const requested = await this.deps.requestCleanup(sessionId)
    if (!requested.ok) return requested
    await this.deps.clean(sessionId)
    const after = this.deps.records()?.get(sessionId)
    if (!after) return { ok: true, value: undefined }
    const worktree = after.worktree
    const cleanup = after.worktreeCleanup
    // A worktree that published stays as a landed row until the main copy holds what it landed (UA1-J11-3).
    if (worktree === undefined && after.retiredWorktree !== undefined && LandedRows.landingOf(after) !== null)
      return { ok: true, value: undefined }
    if (worktree === undefined || cleanup === undefined)
      return this.deps.remove(sessionId)
    if (cleanup.phase === 'kept')
      return {
        ok: false,
        code: 'dirty',
        detail: `Session ${sessionId} keeps its worktree ${worktree.worktreePath} (${cleanup.reason ?? 'changes'}); `
          + 'Finish it: Commit lands the changes, Discard throws them away, and either takes the session away',
      }
    if (cleanup.reason === 'in use' || cleanup.reason === 'undeleted')
      return {
        ok: false,
        code: 'locked',
        detail: `Session ${sessionId}: its worktree ${worktree.worktreePath} is ${cleanup.reason}; `
          + 'it is removed once nothing holds it, and the session goes with it',
      }
    return this.deps.remove(sessionId)
  }
}
