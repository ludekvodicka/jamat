import type { SessionFinalizeQuestionSpec } from './finalizeCatalog'

export class WorktreeQuestion {
  static readonly spec: SessionFinalizeQuestionSpec = {
    id: 'worktree',
    order: 100,
    questionOf(session, scope) {
      if (scope === 'local') return session.worktree?.questions?.local ?? null
      else if (scope === 'remote') return session.worktree?.questions?.remote ?? null
      else throw new Error(`Unknown finalize scope: ${JSON.stringify(scope satisfies never)}`)
    },
    perform(choiceId, ports, agreement) {
      if (choiceId === 'commit' || choiceId === 'discard' || choiceId === 'keep') return ports.finishWorktree(choiceId, agreement)
      else if (choiceId === 'merge') return ports.finalize(agreement.acknowledgeSetup)
      else
        throw new Error(`Unknown worktree choice: ${JSON.stringify(choiceId)}`)
    },
  }

}
