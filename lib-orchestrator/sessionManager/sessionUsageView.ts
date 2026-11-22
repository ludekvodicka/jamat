import type { SessionRecord } from './records/sessionRecord.types'
import { SessionAccounts, type AccountSegment } from './sessionAccounts'
import type { SessionAgentId } from './sessionManagerApi.types'
import { SessionWorkingDirectory } from './sessionWorkingDirectory'

export interface SessionUsageRecord {
  agentId: SessionAgentId
  nativeSessionId: string
  title?: string
  cwd: string
  ownerPath: string | null
  accountSegments: readonly AccountSegment[]
}

export function sessionUsageRecords(records: readonly SessionRecord[]): SessionUsageRecord[] {
  return records.flatMap(record => record.agent?.nativeSessionId ? [{
    agentId: record.agent.agentId, nativeSessionId: record.agent.nativeSessionId,
    title: record.title,
    cwd: record.transcriptCwd ?? SessionWorkingDirectory.ofRecord(record),
    ownerPath: record.worktree?.repositoryRoot ?? null,
    accountSegments: SessionAccounts.segments(record),
  }] : [])
}
