import type { SessionAgentId } from '../../sessionManager/sessionManagerApi.types'
import { PathCompare } from '../../shared/pathCompare'
import type { AttemptRecord, QueueEntry, SnapinItem } from './snapinContract'

export interface KindAdmission {
  kind: string
  paused: boolean
  listingAvailable: boolean
  queue: { entry: QueueEntry; item: SnapinItem | null }[]
  attempts: { record: AttemptRecord; life: 'starting' | 'live' | 'ended' | 'lost' | 'missing'; setupRunning: boolean }[]
}
export interface AdmissionInput {
  limit: number
  agents: SessionAgentId[]
  kinds: KindAdmission[]
  foreign: { title: string; directory: string }[]
}
export interface Grant { kind: string; entry: QueueEntry; item: SnapinItem; agentId: SessionAgentId }
export interface AdmissionAnswer { grants: Grant[]; holds: { itemKey: string; hold: string }[]; dropped: string[] }

export function isOpen(attempt: AttemptRecord): boolean {
  switch (attempt.phase) {
    case 'pending': case 'working': case 'waiting': case 'blocked': return true
    case 'review': case 'completed': case 'ended': return false
    default: throw new Error(`Unknown attempt phase ${attempt.phase}`)
  }
}

export function counted(attempt: KindAdmission['attempts'][number]): boolean {
  switch (attempt.record.phase) {
    case 'pending': case 'working': return true
    case 'waiting': return attempt.life === 'starting' || attempt.life === 'live'
    case 'blocked': case 'review': case 'completed': case 'ended': return false
    default: throw new Error(`Unknown attempt phase ${attempt.record.phase}`)
  }
}

export function pathsConflict(a: string, b: string): boolean { return PathCompare.isInside(a, b) || PathCompare.isInside(b, a) }

export function admit(input: AdmissionInput): AdmissionAnswer {
  const attempts = input.kinds.flatMap((kind) => kind.attempts)
  const active = attempts.filter(counted)
  let free = Math.max(0, input.limit - active.length)
  let setups = 3 - attempts.filter(({ record, setupRunning }) => record.mode === 'wt' && record.phase === 'pending'
    && (!record.sessionId || setupRunning)).length
  const counts = new Map(input.agents.map((agent) => [agent, active.filter(({ record }) => record.agentId === agent).length]))
  const leases = attempts.filter(({ record }) => record.leaseHeld).map(({ record }) => ({ id: record.attemptId, directory: record.projectDirectory }))
  const answer: AdmissionAnswer = { grants: [], holds: [], dropped: [] }
  for (const kind of input.kinds) {
    if (kind.paused || !kind.listingAvailable) continue
    for (const { entry, item } of kind.queue) {
      if (!item) { answer.dropped.push(entry.itemKey); continue }
      let hold = item.hold
      if (!hold && entry.setupAgreement && entry.acknowledgeSetup !== entry.setupAgreement.hash) hold = 'Worktree commands need approval'
      if (!hold && kind.attempts.some(({ record }) => record.itemKey === item.key && (isOpen(record) || record.phase === 'review')))
        hold = 'already running'
      if (item.mode === 'wc') {
        if (!hold && leases.some((lease) => lease.id !== entry.inheritsLeaseFrom && pathsConflict(lease.directory, item.projectDirectory)))
          hold = 'working copy busy'
        const foreign = input.foreign.find((session) => pathsConflict(session.directory, item.projectDirectory))
        if (!hold && foreign && !entry.startAnyway) hold = `session ${foreign.title} works here`
      } else if (item.mode === 'wt') {
        if (!hold && setups <= 0) hold = 'setup cap'
      } else throw new Error(`Unknown pass mode ${item.mode}`)
      if (hold) { answer.holds.push({ itemKey: item.key, hold }); continue }
      if (!free || !input.agents.length) continue
      const agentId = input.agents.reduce((best, agent) => counts.get(agent)! < counts.get(best)! ? agent : best)
      const grantedEntry = { ...entry }
      if (item.mode === 'wt') delete grantedEntry.inheritsLeaseFrom
      answer.grants.push({ kind: kind.kind, entry: grantedEntry, item, agentId })
      free--
      counts.set(agentId, counts.get(agentId)! + 1)
      if (item.mode === 'wt') setups--
      else if (item.mode === 'wc') leases.push({ id: '', directory: item.projectDirectory })
      else throw new Error(`Unknown pass mode ${item.mode}`)
    }
  }
  return answer
}
