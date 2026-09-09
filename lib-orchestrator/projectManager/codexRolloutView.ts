import { CodexRolloutIndex } from './providers/codex/codexRolloutIndex'
import { CodexSessionSource } from './providers/codex/codexSessionSource'

/** One rollout, reduced to the three things a caller outside this subsystem can act on. */
export interface CodexRolloutMatch {
  sessionId: string
  createdAt: number
  /** The conversation this one was forked from, per its own header; null for a fresh one. */
  forkedFromId: string | null
}

/**
 * The subsystem's second declared READ surface, beside `catalogView`. It exists for the same reason
 * that one does: a second subsystem needs one answer out of `providers/`, and `providers/` is
 * imported by this subsystem and by nothing else.
 *
 * Read-only by construction: the index is built WITHOUT the cwd memo, so this can write nothing at
 * all and the memo file keeps its single writer, the ProjectManager's own index. The price is an
 * exact-window walk instead of a memo read, and it is not a price at all for the one caller there
 * is: naming a conversation only ever accepts a rollout from inside the launch window. The listing
 * path is `CodexRolloutIndex.filesForProject`, which this view does not expose.
 */
export class CodexRolloutView {
  private constructor(private readonly index: CodexRolloutIndex) {}

  static load(options?: {
    codexHome?: string
    report?: (message: string) => void
  }): CodexRolloutView {
    const home = options?.codexHome ?? CodexSessionSource.defaultHome()
    return new CodexRolloutView(new CodexRolloutIndex(home, options?.report))
  }

  /**
   * The rollouts Codex recorded for this directory inside one exact launch window, newest first.
   *
   * A session asks this on regular reconcile passes after launch, once during startup recovery, and
   * before a fork. A listing would answer out of a map up to thirty seconds old, so it cannot see a
   * rollout written a second ago, and without a memo it reads every header in ninety days to build
   * that map. This walk opens only what the window holds, and that is where the parent link comes
   * from as well.
   */
  async rolloutsBetween(
    directory: string,
    from: number,
    until: number,
  ): Promise<readonly CodexRolloutMatch[]> {
    const found = await this.index.rolloutsBetween(directory, from, until)
    return found.map((ref) => ({
      sessionId: ref.sessionId,
      createdAt: ref.createdAt,
      forkedFromId: ref.forkedFromId,
    }))
  }
}
