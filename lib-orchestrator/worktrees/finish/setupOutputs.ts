import { lstat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { SvnStatusRow } from '../../svn/svn.types'
import type { SvnWorktreeManager } from '../../svn/svnWorktreeManager'
import type { SessionRecord } from '../../sessionManager/worktreeSessionRecords'

/**
 * What the worktree setup created and the session has not touched since: an unversioned path whose
 * content still equals the setup baseline recorded right after the setup ran. It is no part of the
 * session's change set, so preparation does not add it and the review does not offer it; it stays
 * on disk and goes with the worktree. worker-agent r288 published the empty lockfile an
 * `npm install` wrote, and the next Finish met that file as a conflict.
 *
 * A versioned file the setup modified stays a candidate, as before: leaving it out would publish a
 * repository state the checks never ran on. Files a check run produced stay candidates too; only
 * the setup baseline is read. Any change after the baseline makes a path the session's again, so
 * nothing the session changed is hidden. `SvnWorktreeSession.setupPaths` marks the same paths in
 * the commit dialog.
 */
export class SetupOutputs {
  static async of(svn: Pick<SvnWorktreeManager, 'commitHashes'>, root: string, record: SessionRecord,
    rows: readonly SvnStatusRow[]): Promise<Set<string>> {
    const baseline: Readonly<Record<string, string>> = record.worktree?.setupBaseline?.hashes ?? {}
    const candidates = rows.filter((row) => row.unversioned === true && !row.conflict && Object.hasOwn(baseline, row.path)).map((row) => row.path)
    if (candidates.length === 0) return new Set()
    // A node hash of a directory covers its kind and properties only, so it proves no directory untouched.
    const node: string[] = []
    for (const path of candidates.filter((candidate) => baseline[candidate].startsWith('node:')))
      if ((await lstat(resolve(root, path)).catch(() => null))?.isFile()) node.push(path)
    const tree = candidates.filter((path) => !baseline[path].startsWith('node:'))
    const hashes = { ...await SetupOutputs.hashes(svn, root, node, 'node'), ...await SetupOutputs.hashes(svn, root, tree, 'tree') }
    return new Set(candidates.filter((path) => hashes[path] === baseline[path]))
  }

  private static async hashes(svn: Pick<SvnWorktreeManager, 'commitHashes'>, root: string, paths: readonly string[],
    depth: 'node' | 'tree'): Promise<Record<string, string>> {
    if (paths.length === 0) return {}
    const read = await svn.commitHashes(root, paths, depth)
    if (!read.ok) throw new Error(read.detail)
    return read.value
  }
}
