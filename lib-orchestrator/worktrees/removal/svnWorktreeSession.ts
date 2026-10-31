import type { SvnResult } from '../../svn/svn.types'
import { relative } from 'node:path'
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

  /**
   * Which of the unversioned files `paths` are setup outputs the Finish leaves out (`SetupOutputs`):
   * a file the setup baseline names, or one inside an unversioned directory it names, whose content
   * still equals that baseline. The commit dialog lists the files of such a directory one by one.
   */
  async setupPaths(record: SessionRecord, paths: readonly string[]): Promise<SessionsOpResult<string[]>> {
    const worktree = record.worktree
    if (worktree?.kind !== 'svn' || worktree.setupBaseline === undefined) return { ok: true, value: [] }
    const baseline = worktree.setupBaseline.hashes
    // A node hash proves no directory content, and this reader computes tree hashes only.
    const keys = Object.keys(baseline).filter((key) => !baseline[key].startsWith('node:'))
    const owners = new Map<string, string>()
    for (const path of paths.filter((candidate) => PathCompare.isInside(worktree.worktreePath, candidate))) {
      const name = relative(worktree.worktreePath, path).replace(/\\/g, '/')
      const key = keys.filter((candidate) => name === candidate || name.startsWith(`${candidate}/`)).sort((a, b) => b.length - a.length)[0]
      if (key !== undefined) owners.set(path, key)
    }
    if (owners.size === 0) return { ok: true, value: [] }
    const current = await this.deps.commitHashes(worktree.worktreePath, [...new Set(owners.values())])
    if (!current.ok) return { ok: false, code: 'svn-failed', detail: current.detail }
    return { ok: true, value: [...owners].filter(([, key]) => current.value[key] === baseline[key]).map(([path]) => path) }
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
