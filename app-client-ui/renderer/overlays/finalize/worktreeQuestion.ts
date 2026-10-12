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
      const worktree = session.worktree
      if (worktree === undefined) return null
      let local: boolean
      if (scope === 'local') local = true
      else if (scope === 'remote') local = false
      else throw new Error(`Unknown finalize scope: ${JSON.stringify(scope)}`)
      // A running SVN session is asked here too, on this computer: its action stops it first.
      const ended = session.life === 'ended' || session.life === 'lost'
      if (!ended && !(local && worktree.liveFinish === true)) return null
      // An action that runs owns the worktree; one that waits for the person takes the next press.
      const action = session.svnAction
      if (action !== undefined && action.needs === null) return null
      const discardAdmitted = local && (session.admits.includes('discardWorktree') || worktree.liveFinish === true)
      const waiting = local && action?.needs !== undefined && action.needs !== null
      const choices: SessionFinalizeChoice[] = []
      // The library composes what this worktree offers; the kind is never read here to decide it.
      for (const choice of worktree.choices) {
        const row = WorktreeQuestion.rowOf(choice, session, worktree, discardAdmitted, waiting)
        if (row !== null) choices.push(row)
      }
      if (!choices.some((choice) => choice.submitLabel !== null)) return null
      const landing = choices.find((choice) => choice.id === 'commit' || choice.id === 'merge')
      return {
        label: 'Worktree',
        choices,
        chosenDefault: landing?.id ?? 'keep',
        ...waiting && action?.needs ? { note: `The Finish waits for you: ${action.needs}` } : {},
      }
    },
    perform(choiceId, ports, agreement) {
      if (choiceId === 'commit' || choiceId === 'discard' || choiceId === 'keep') return ports.finishWorktree(choiceId, agreement)
      else if (choiceId === 'merge') return ports.finalize(agreement.acknowledgeSetup)
      else
        throw new Error(`Unknown worktree choice: ${JSON.stringify(choiceId)}`)
    },
  }

  private static rowOf(
    choice: SessionFinishChoice,
    session: SessionInfo,
    worktree: SessionWorktreeInfo,
    discardAdmitted: boolean,
    waiting: boolean,
  ): SessionFinalizeChoice | null {
    if (choice === 'commit')
      return session.admits.includes('finalize')
        ? {
            id: 'commit',
            title: 'Commit',
            note: `${worktree.liveFinish === true ? 'stops the session, ' : ''}runs the checks, reviews and commits `
              + 'the changes from the worktree, then removes the worktree',
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
    else if (choice === 'keep') {
      if (waiting)
        return { id: 'keep', title: 'Keep worktree', note: 'ends the waiting Finish; the worktree and its changes stay', glyph: '—', submitLabel: 'Keep worktree' }
      // Leaving a worktree that waits for its removal after the end is no keeping: the removal goes on.
      return worktree.cleanup?.phase === 'pending'
        ? { id: 'keep', title: 'Remove automatically', note: worktree.cleanup.summary, glyph: '↻', submitLabel: null }
        : {
            id: 'keep',
            title: 'Keep worktree',
            note: 'decide later; the row keeps Finish…',
            glyph: '—',
            submitLabel: null,
          }
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
