import type { SvnConflictJournal, SvnConflictKind } from '../../svn/svn.types'
import type { WorktreeLifecycle } from '../worktreeState'
import { SvnConflictIdentity } from './svnConflictIdentity'

export class ConflictJournals {
  static migrate(state: WorktreeLifecycle): WorktreeLifecycle {
    if (state.syncConflictSet === undefined || state.syncJournals === undefined) return state
    const pending = { ...state.syncJournals }
    const entries = state.syncConflictSet.entries.map((entry) => {
      const key = entry.occurrenceId === undefined ? entry.path : `${entry.occurrenceId}:${entry.path}`
      const journal = entry.journal ?? pending[key]
      delete pending[key]
      return journal === undefined ? entry : { ...entry, journal }
    })
    return { ...state, syncConflictSet: { ...state.syncConflictSet, entries },
      syncJournals: Object.keys(pending).length === 0 ? undefined : pending }
  }

  /** The journal of the one conflict `path` and `kind` name; a path can hold a text and a property conflict. */
  static record(state: WorktreeLifecycle, path: string, journal: SvnConflictJournal, kind: SvnConflictKind): WorktreeLifecycle {
    const current = ConflictJournals.migrate(state)
    if (!current.syncConflictSet?.entries.some((entry) => SvnConflictIdentity.same(entry, { path, kind }))) throw new Error(`No conflict occurrence owns the ${kind} conflict of ${path}`)
    return { ...current, syncConflictSet: { ...current.syncConflictSet,
      entries: current.syncConflictSet.entries.map((entry) => SvnConflictIdentity.same(entry, { path, kind }) ? { ...entry, journal } : entry) } }
  }
}
