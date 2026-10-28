import type { MainCopyUpdated } from '../../../lib-orchestrator/worktrees/worktreeFinish'

/** One Windows notification for an UPDATE of a landed row: whose it is, its two lines, and the log a click opens. */
export interface MainCopyUpdateNoticeView {
  sessionId: string
  title: string
  body: string
  log: string | null
}

/**
 * The words of an UPDATE recorded on a landed row. The row and its Session actions go once the main
 * copy holds what it landed, so this notice is where the person reads the revision and finds the
 * UPDATE log the durable worktree result kept.
 */
export class MainCopyUpdateNotice {
  static of(update: MainCopyUpdated): MainCopyUpdateNoticeView {
    const by = update.by
    let asked: string
    switch (by) {
      case 'person': asked = ''; break
      case 'agent': asked = ', updated by an agent'; break
      default: throw new Error(`Unknown UPDATE requester: ${JSON.stringify(by satisfies never)}`)
    }
    const where = update.log === null
      ? 'No update log could be kept; sessions worktree-results has the result.'
      : 'Click to open the update log, kept with the worktree result.'
    return {
      sessionId: update.sessionId,
      title: `Main copy updated: ${update.title}`,
      body: `${update.mainCopy} is at r${update.revision}${asked}. ${where}`,
      log: update.log,
    }
  }
}
