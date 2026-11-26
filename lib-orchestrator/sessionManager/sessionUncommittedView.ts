import type { SessionRecord } from './records/sessionRecord.types'
import type { SessionAgentId, SessionInfo } from './sessionManagerApi.types'
import { SessionWorkingDirectory } from './sessionWorkingDirectory'

/** A session the uncommitted mark is computed for, with what its transcripts are found by. */
export interface SessionUncommittedCandidate {
  sessionId: string
  agentId: SessionAgentId
  nativeSessionId: string
  /** Where the session runs; relative transcript paths and the mark's sample are read against it. */
  cwd: string
  /** The directory the agent's transcripts are filed under. */
  transcriptCwd: string
  life: 'live' | 'ended'
}

/**
 * D17, the one eligibility rule of the mark: an agent session, live or ended, that names its
 * conversation and works in the main copy, still in the tree. Worktree sessions, retired ones,
 * script runs, setup and resolve sessions never are; whether the directory is an SVN working copy
 * is the tracker's to find out.
 */
export class SessionUncommittedCandidates {
  static of(records: readonly SessionRecord[], infos: readonly SessionInfo[]): SessionUncommittedCandidate[] {
    const bySession = new Map(records.map((record) => [record.sessionId, record]))
    return infos.flatMap((info): SessionUncommittedCandidate[] => {
      const record = bySession.get(info.sessionId)
      const nativeSessionId = record?.agent?.nativeSessionId
      if (record === undefined || record.agent === undefined || nativeSessionId === undefined || nativeSessionId === '') return []
      if (info.kind !== 'agent' || record.worktree !== undefined || info.worktree !== undefined
        || info.retiredWorktree !== undefined || info.script !== undefined
        || info.resolveFor !== undefined || info.setupFor !== undefined)
        return []
      const life = SessionUncommittedCandidates.lifeOf(info.life)
      if (life === null) return []
      const cwd = SessionWorkingDirectory.ofRecord(record)
      return [{
        sessionId: info.sessionId,
        agentId: record.agent.agentId,
        nativeSessionId,
        cwd,
        transcriptCwd: record.transcriptCwd ?? cwd,
        life,
      }]
    })
  }

  private static lifeOf(life: SessionInfo['life']): 'live' | 'ended' | null {
    switch (life) {
      case 'live':
      case 'ended':
        return life
      case 'starting':
      case 'lost':
        return null
      default:
        throw new Error(`Unknown session life: ${JSON.stringify(life satisfies never)}`)
    }
  }
}
