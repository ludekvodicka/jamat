import { join } from 'node:path'

import type { RuntimeChannel } from '../../shared/configIdentity.types'
import { ErrorText } from '../../shared/errorText'
import { OrchestratorPaths } from '../../shared/orchestratorPaths'
import { LaunchPlanner } from '../launch/launchPlanner'
import type { SessionRecord } from '../records/sessionRecord.types'
import type { SessionAgentId, SessionErasure } from '../sessionManagerApi.types'
import type { AgentHistoryEraser, ErasureReport } from './agentHistoryEraser.types'
import { ErasureLedger } from './erasureLedger'

export interface SessionPurgeDeps {
  instance: { configIdentity: string; channel: RuntimeChannel }
  /** Absent for an agent means its store is left as it is, and the erasure says so. */
  erasers: Partial<Record<SessionAgentId, AgentHistoryEraser>>
  /** Drops the records from every recovery point of the records file. */
  scrubRecoveryPoints: (sessionIds: readonly string[]) => Promise<ErasureReport>
  forgetNotifies: (sessionId: string) => Promise<void>
  removeScriptLogs: (sessionId: string) => Promise<void>
  /** Files of the session kept outside this manager, such as pasted clipboard content; answers what went. */
  sessionFiles?: (sessionId: string) => Promise<readonly string[]>
}

/**
 * Everything this machine keeps of a session whose record is already gone: Jamat's own files of it,
 * the copies of its record in the recovery points, and the agent's conversation in the agent's store.
 * Each step runs whatever the one before came to, so one failure leaves one named leftover.
 */
export class SessionPurge {
  private static readonly plainIdPatternConst = /^[A-Za-z0-9_-]{1,128}$/

  private readonly deps: SessionPurgeDeps

  constructor(deps: SessionPurgeDeps) {
    this.deps = deps
  }

  /** The conversation ids a record names, the unconfirmed one included. */
  static conversationIdsOf(record: SessionRecord): string[] {
    const agent = record.agent
    if (agent === undefined) return []
    return [...new Set([agent.nativeSessionId, agent.unverifiedNativeSessionId].filter((id) => id !== undefined))]
  }

  /**
   * `removed` is the record and every run record that went with it; `forks` the sessions forked from
   * its conversation, which hold a copy of it that this erase does not take.
   */
  async erase(record: SessionRecord, removed: readonly string[], forks: readonly SessionRecord[]): Promise<SessionErasure> {
    const sessionId = record.sessionId
    if (!SessionPurge.plainIdPatternConst.test(sessionId))
      throw new Error(`Not a plain session id: ${JSON.stringify(sessionId)}`)
    const ledger = new ErasureLedger()
    const { configIdentity, channel } = this.deps.instance
    const conversations = SessionPurge.conversationIdsOf(record)
    await ledger.remove(join(OrchestratorPaths.codexSessionsDirectory(configIdentity, channel), sessionId))
    await ledger.remove(join(OrchestratorPaths.claudeIdentitiesDirectory(configIdentity, channel), `${sessionId}.json`))
    await ledger.remove(join(OrchestratorPaths.claudeStatusLineDirectory(configIdentity, channel), `settings-${sessionId}.json`))
    await ledger.remove(join(OrchestratorPaths.antigravityIdentitiesDirectory(configIdentity, channel), `${sessionId}.json`))
    await ledger.remove(join(OrchestratorPaths.antigravityStatusLineDirectory(configIdentity, channel), `settings-${sessionId}.json`))
    await ledger.remove(join(OrchestratorPaths.antigravityContextSnapshotsDirectory(configIdentity, channel), `session-${sessionId}.json`))
    for (const id of conversations.filter((one) => ErasureLedger.conversationId(one))) {
      await ledger.remove(join(OrchestratorPaths.claudeContextSnapshotsDirectory(configIdentity, channel), `${id}.json`))
      await ledger.remove(join(OrchestratorPaths.antigravityContextSnapshotsDirectory(configIdentity, channel), `${id}.json`))
    }
    await SessionPurge.step(ledger, 'Script logs', () => this.deps.removeScriptLogs(sessionId))
    await SessionPurge.step(ledger, 'Session notifies', () => this.deps.forgetNotifies(sessionId))
    if (this.deps.sessionFiles !== undefined) {
      const files = this.deps.sessionFiles
      await SessionPurge.step(ledger, 'Pasted files', async () => { ledger.report.erased.push(...await files(sessionId)) })
    }
    await SessionPurge.merged(ledger, 'Recovery points', () => this.deps.scrubRecoveryPoints([sessionId, ...removed]))
    const agent = record.agent
    if (agent !== undefined && conversations.length > 0) {
      const eraser = this.deps.erasers[agent.agentId]
      if (eraser === undefined)
        ledger.report.leftovers.push(`${agent.agentId} conversation ${conversations.join(', ')}: this build has no eraser for the agent`)
      else
        await SessionPurge.merged(ledger, `${agent.agentId} conversation`, () =>
          eraser.erase({ nativeSessionIds: conversations, cwd: record.transcriptCwd ?? LaunchPlanner.cwdOf(record), since: record.createdAt }))
    }
    else if (record.kind === 'agent')
      ledger.report.notes.push('The session named no conversation, so nothing was searched for in the agent\'s store')
    for (const fork of forks)
      ledger.report.notes.push(`Session ${fork.title} (${fork.sessionId}) was forked from this conversation and holds a copy of it; erase it too if it should go`)
    return { sessionId, ...ledger.report }
  }

  /** A conversation no Jamat record names: only the agent's store holds it. */
  async eraseConversation(agentId: SessionAgentId, nativeSessionId: string, cwd: string, since: number): Promise<SessionErasure> {
    const ledger = new ErasureLedger()
    const eraser = this.deps.erasers[agentId]
    if (eraser === undefined)
      ledger.report.leftovers.push(`${agentId} conversation ${nativeSessionId}: this build has no eraser for the agent`)
    else
      await SessionPurge.merged(ledger, `${agentId} conversation`, () =>
        eraser.erase({ nativeSessionIds: [nativeSessionId], cwd, since }))
    return { sessionId: nativeSessionId, ...ledger.report }
  }

  private static async step(ledger: ErasureLedger, label: string, work: () => Promise<void>): Promise<void> {
    try { await work() }
    catch (error) { ledger.report.leftovers.push(`${label}: ${ErrorText.of(error)}`) }
  }

  private static async merged(ledger: ErasureLedger, label: string, work: () => Promise<ErasureReport>): Promise<void> {
    await SessionPurge.step(ledger, label, async () => {
      const report = await work()
      ledger.report.erased.push(...report.erased)
      ledger.report.leftovers.push(...report.leftovers)
      ledger.report.notes.push(...report.notes)
    })
  }
}
