import type { SessionFinalizeChoice } from './finalizeModel'
import type { SessionFinalizeQuestionSpec } from './finalizeCatalog'

export class WorktreeQuestion {
  static readonly spec: SessionFinalizeQuestionSpec = {
    id: 'worktree',
    order: 100,
    questionOf(session, scope) {
      if (session.worktree === undefined) return null
      if (session.life !== 'ended' && session.life !== 'lost') return null
      const choices: SessionFinalizeChoice[] = []
      if (session.admits.includes('finalize'))
        choices.push({
          id: 'merge',
          title: 'Merge back',
          note: `commits anything uncommitted, merges into ${session.worktree.branch}'s base `
            + 'and removes the worktree',
          glyph: '⇤',
          submitLabel: 'Merge',
        })
      choices.push({
        id: 'keep',
        title: 'Keep worktree',
        note: 'decide later; the row keeps Finish…',
        glyph: '—',
        submitLabel: null,
      })
      let discardAdmitted: boolean
      if (scope === 'local') discardAdmitted = session.admits.includes('discardWorktree')
      else if (scope === 'remote') discardAdmitted = false
      else throw new Error(`Unknown finalize scope: ${JSON.stringify(scope)}`)
      if (discardAdmitted)
        choices.push({
          id: 'discard',
          title: 'Discard worktree',
          note: 'throws the branch and the directory away',
          glyph: '✕',
          submitLabel: 'Discard worktree',
          danger: true,
        })
      if (!choices.some((choice) => choice.submitLabel !== null)) return null
      const chosenDefault = choices.some((choice) => choice.id === 'merge') ? 'merge' : 'keep'
      return { label: 'Worktree', choices, chosenDefault }
    },
    perform(choiceId, ports) {
      if (choiceId === 'merge') return ports.finalize()
      else if (choiceId === 'discard') return ports.discardWorktree()
      else
        throw new Error(`Unknown worktree choice: ${JSON.stringify(choiceId)}`)
    },
  }
}
