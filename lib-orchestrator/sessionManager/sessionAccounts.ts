import type { SessionAgentId } from './sessionManagerApi.types'
import type { SessionRecord } from './records/sessionRecord.types'
import type { AgentAccounts } from '../agentAccounts/agentAccounts'

export interface SessionAccountRef { agentId: SessionAgentId; accountId: string }
export interface AccountSegment { accountId: string; from: number; to: number | null }
export type SessionAccountsPort = Pick<AgentAccounts, 'exists' | 'defaultAccount' | 'launchEnv'>
  & Partial<Pick<AgentAccounts, 'labelOf' | 'usable'>>

export class SessionAccounts {
  static ref(record: SessionRecord): SessionAccountRef | null {
    if (record.kind === 'agent') return record.agent ? { agentId: record.agent.agentId, accountId: record.agent.accountId ?? 'main' } : null
    else if (record.kind === 'shell') return record.account ?? null
    else throw new Error(`Unknown session kind: ${record.kind}`)
  }

  static segments(record: SessionRecord): AccountSegment[] {
    const account = SessionAccounts.ref(record)
    return record.accountSegments ?? (account === null ? [] : [{ accountId: account.accountId, from: record.createdAt, to: record.endedAt ?? null }])
  }

  static launchRef(record: SessionRecord): SessionAccountRef | null {
    const account = SessionAccounts.ref(record)
    return account && record.agent?.launchAccountId !== undefined
      ? { ...account, accountId: record.agent.launchAccountId } : account
  }

  static close(record: SessionRecord, at: number): AccountSegment[] {
    return SessionAccounts.segments(record).map(segment => segment.to === null ? { ...segment, to: Math.max(segment.from, at) } : segment)
  }

  static open(record: SessionRecord, at: number): AccountSegment[] {
    const account = SessionAccounts.ref(record)
    if (account === null) return []
    return [...SessionAccounts.close(record, at), { accountId: account.accountId, from: at, to: null }]
  }
}
