import type { SessionRecordSvnAction } from '../../sessionManager/worktreeSessionRecords'

export class SvnResolverTiming {
  static readonly limitMillisecondsConst = 20 * 60_000

  static overdue(action: SessionRecordSvnAction, now: number): boolean {
    return action.stage === 'resolving' && action.needs === undefined && action.verdict === undefined
      && action.conflicts !== undefined && now - action.conflicts.at > SvnResolverTiming.limitMillisecondsConst
  }

}
