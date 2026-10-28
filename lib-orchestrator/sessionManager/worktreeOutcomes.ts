import { WorktreeWords } from '../worktrees/worktreeViews'

export class WorktreeOutcomes {
  static of(...args: Parameters<typeof WorktreeWords.outcome>): ReturnType<typeof WorktreeWords.outcome> {
    return WorktreeWords.outcome(...args)
  }
}
