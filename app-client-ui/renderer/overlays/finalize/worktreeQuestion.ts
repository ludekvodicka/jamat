import type {
  SessionFinishChoice,
  SessionInfo,
  SessionWorktreeInfo,
} from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { SessionFinalizeChoice } from './finalizeModel'
import type { SessionFinalizeQuestionSpec } from './finalizeCatalog'

export class WorktreeQuestion {
  static readonly spec: SessionFinalizeQuestionSpec = {
    id: 'worktree',
    order: 100,
    questionOf(session, scope) {
      if (session.worktree === undefined) return null
      if (session.life !== 'ended' && session.life !== 'lost') return null
      let discardAdmitted: boolean
      if (scope === 'local') discardAdmitted = session.admits.includes('discardWorktree')
      else if (scope === 'remote') discardAdmitted = false
      else throw new Error(`Unknown finalize scope: ${JSON.stringify(scope)}`)
      const choices: SessionFinalizeChoice[] = []
      // The library composes what this worktree offers; the kind is never read here to decide it.
      for (const choice of session.worktree.choices) {
        const row = WorktreeQuestion.rowOf(choice, session, session.worktree, discardAdmitted)
        if (row !== null) choices.push(row)
      }
      if (!choices.some((choice) => choice.submitLabel !== null)) return null
      const landing = choices.find((choice) => choice.id === 'commit' || choice.id === 'merge')
      return { label: 'Worktree', choices, chosenDefault: landing?.id ?? 'keep' }
    },
    perform(choiceId, ports) {
      if (choiceId === 'merge' || choiceId === 'commit') return ports.finalize()
      else if (choiceId === 'discard') return ports.discardWorktree()
      else
        throw new Error(`Unknown worktree choice: ${JSON.stringify(choiceId)}`)
    },
  }

  private static rowOf(
    choice: SessionFinishChoice,
    session: SessionInfo,
    worktree: SessionWorktreeInfo,
    discardAdmitted: boolean,
  ): SessionFinalizeChoice | null {
    if (choice === 'commit')
      return session.admits.includes('finalize')
        ? {
            id: 'commit',
            title: 'Commit',
            note: 'reviews and commits the changes from the worktree, updates the main copy and '
              + 'removes the worktree',
            glyph: '✓',
            submitLabel: 'Commit',
          }
        : null
    else if (choice === 'merge')
      return session.admits.includes('finalize')
        ? {
            id: 'merge',
            title: 'Merge back',
            note: `commits anything uncommitted, merges into ${worktree.branch}'s base `
              + 'and removes the worktree',
            glyph: '⇤',
            submitLabel: 'Merge',
          }
        : null
    else if (choice === 'keep')
      return {
        id: 'keep',
        title: 'Keep worktree',
        note: 'decide later; the row keeps Finish…',
        glyph: '—',
        submitLabel: null,
      }
    else if (choice === 'discard')
      return discardAdmitted
        ? {
            id: 'discard',
            title: 'Discard worktree',
            note: WorktreeQuestion.discardNoteOf(worktree),
            glyph: '✕',
            submitLabel: 'Discard worktree',
            danger: true,
          }
        : null
    else
      throw new Error(`Unknown finish choice: ${JSON.stringify(choice satisfies never)}`)
  }

  /** The count is the last measurement; before one exists the note says it does not know. */
  private static discardNoteOf(worktree: SessionWorktreeInfo): string {
    const count = worktree.diff === null
      ? 'unmeasured changes'
      : `${worktree.diff.changedFiles} changed ${worktree.diff.changedFiles === 1 ? 'file' : 'files'}`
    if (worktree.kind === 'git') return `throws the branch, the directory and its ${count} away`
    else if (worktree.kind === 'svn') return `throws the checkout and its ${count} away`
    else
      throw new Error(`Unknown worktree kind: ${JSON.stringify(worktree.kind satisfies never)}`)
  }
}
