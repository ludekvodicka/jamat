import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { RuntimeChannel } from '../../shared/configIdentity.types'
import { ErrnoCode } from '../../shared/errnoCode'
import { OrchestratorPaths } from '../../shared/orchestratorPaths'
import type { SessionRecord } from '../records/sessionRecord.types'
import { SessionPurge } from './sessionPurge'

export interface EphemeralSessionFilesOptions {
  instance: { configIdentity: string; channel: RuntimeChannel }
  now?: () => number
  maxAgeMilliseconds?: number
}

/**
 * Routine cleanup and stale-file sweep for ephemeral per-session status-line, identity and context
 * snapshot files under `claude-{statusline,identity,context}` and `antigravity-{statusline,identity,context}`.
 *
 * Shared relay scripts (`relay.cjs`, `relay.cmd`, `relay.sh`), `codex-sessions/`, agent conversation
 * stores and files belonging to known sessions or conversations are never deleted here.
 */
export class EphemeralSessionFiles {
  static readonly maxAgeMillisecondsConst = 7 * 24 * 60 * 60 * 1000
  private static readonly plainIdPatternConst = /^[0-9A-Za-z_-]{1,128}$/
  private static readonly settingsFilePatternConst = /^settings-([0-9A-Za-z_-]{1,128})\.json$/
  private static readonly plainJsonFilePatternConst = /^([0-9A-Za-z_-]{1,128})\.json$/
  private static readonly antigravitySessionContextPatternConst = /^session-([0-9A-Za-z_-]{1,128})\.json$/

  private readonly configIdentity: string
  private readonly channel: RuntimeChannel
  private readonly now: () => number
  private readonly maxAgeMilliseconds: number

  constructor(options: EphemeralSessionFilesOptions) {
    this.configIdentity = options.instance.configIdentity
    this.channel = options.instance.channel
    this.now = options.now ?? Date.now
    this.maxAgeMilliseconds = options.maxAgeMilliseconds ?? EphemeralSessionFiles.maxAgeMillisecondsConst
  }

  /**
   * Removes ephemeral status-line, identity and context files for sessions that were removed or
   * archived. Conversation-keyed context snapshots are deleted only when no remaining known record
   * still references the conversation id.
   */
  async removeForSessions(
    records: readonly SessionRecord[],
    remainingKnownConversations: ReadonlySet<string>,
    options: { includeConversationContext: boolean },
  ): Promise<number> {
    let removed = 0
    for (const record of records) {
      const sessionId = record.sessionId
      if (!EphemeralSessionFiles.plainIdPatternConst.test(sessionId)) continue
      for (const path of [
        join(OrchestratorPaths.claudeStatusLineDirectory(this.configIdentity, this.channel), `settings-${sessionId}.json`),
        join(OrchestratorPaths.claudeIdentitiesDirectory(this.configIdentity, this.channel), `${sessionId}.json`),
        join(OrchestratorPaths.antigravityStatusLineDirectory(this.configIdentity, this.channel), `settings-${sessionId}.json`),
        join(OrchestratorPaths.antigravityIdentitiesDirectory(this.configIdentity, this.channel), `${sessionId}.json`),
        join(OrchestratorPaths.antigravityContextSnapshotsDirectory(this.configIdentity, this.channel), `session-${sessionId}.json`),
      ])
        if (await EphemeralSessionFiles.unlinkExisting(path)) removed += 1
      if (!options.includeConversationContext) continue
      for (const conversationId of SessionPurge.conversationIdsOf(record)) {
        if (!EphemeralSessionFiles.plainIdPatternConst.test(conversationId)) continue
        if (remainingKnownConversations.has(conversationId)) continue
        for (const path of [
          join(OrchestratorPaths.claudeContextSnapshotsDirectory(this.configIdentity, this.channel), `${conversationId}.json`),
          join(OrchestratorPaths.antigravityContextSnapshotsDirectory(this.configIdentity, this.channel), `${conversationId}.json`),
        ])
          if (await EphemeralSessionFiles.unlinkExisting(path)) removed += 1
      }
    }
    return removed
  }

  /**
   * Removes files older than `maxAgeMilliseconds` belonging to unknown sessions/conversations across
   * the six status-line, identity and context directories. Never removes shared relay scripts or
   * files owned by any session or conversation in `knownRecords`.
   */
  async sweepStale(knownRecords: readonly SessionRecord[]): Promise<number> {
    const knownSessions = new Set<string>()
    const knownConversations = new Set<string>()
    for (const record of knownRecords) {
      knownSessions.add(record.sessionId)
      for (const conversationId of SessionPurge.conversationIdsOf(record))
        knownConversations.add(conversationId)
    }
    const cutoff = this.now() - this.maxAgeMilliseconds
    let removed = 0
    removed += await EphemeralSessionFiles.sweepDirectory(
      OrchestratorPaths.claudeStatusLineDirectory(this.configIdentity, this.channel),
      cutoff,
      (name) => {
        const match = EphemeralSessionFiles.settingsFilePatternConst.exec(name)
        return match !== null && !knownSessions.has(match[1])
      },
    )
    removed += await EphemeralSessionFiles.sweepDirectory(
      OrchestratorPaths.claudeIdentitiesDirectory(this.configIdentity, this.channel),
      cutoff,
      (name) => {
        const match = EphemeralSessionFiles.plainJsonFilePatternConst.exec(name)
        return match !== null && !knownSessions.has(match[1])
      },
    )
    removed += await EphemeralSessionFiles.sweepDirectory(
      OrchestratorPaths.claudeContextSnapshotsDirectory(this.configIdentity, this.channel),
      cutoff,
      (name) => {
        const match = EphemeralSessionFiles.plainJsonFilePatternConst.exec(name)
        return match !== null && !knownConversations.has(match[1])
      },
    )
    removed += await EphemeralSessionFiles.sweepDirectory(
      OrchestratorPaths.antigravityStatusLineDirectory(this.configIdentity, this.channel),
      cutoff,
      (name) => {
        const match = EphemeralSessionFiles.settingsFilePatternConst.exec(name)
        return match !== null && !knownSessions.has(match[1])
      },
    )
    removed += await EphemeralSessionFiles.sweepDirectory(
      OrchestratorPaths.antigravityIdentitiesDirectory(this.configIdentity, this.channel),
      cutoff,
      (name) => {
        const match = EphemeralSessionFiles.plainJsonFilePatternConst.exec(name)
        return match !== null && !knownSessions.has(match[1])
      },
    )
    removed += await EphemeralSessionFiles.sweepDirectory(
      OrchestratorPaths.antigravityContextSnapshotsDirectory(this.configIdentity, this.channel),
      cutoff,
      (name) => {
        const sessionMatch = EphemeralSessionFiles.antigravitySessionContextPatternConst.exec(name)
        if (sessionMatch !== null) return !knownSessions.has(sessionMatch[1])
        const conversationMatch = EphemeralSessionFiles.plainJsonFilePatternConst.exec(name)
        return conversationMatch !== null && !knownConversations.has(conversationMatch[1])
      },
    )
    return removed
  }

  private static async sweepDirectory(
    directory: string,
    cutoff: number,
    isOrphanName: (name: string) => boolean,
  ): Promise<number> {
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) }
    catch (error) {
      if (ErrnoCode.of(error) === 'ENOENT') return 0
      throw error
    }
    let removed = 0
    for (const entry of entries) {
      if (!entry.isFile() || !isOrphanName(entry.name)) continue
      const path = join(directory, entry.name)
      try {
        const info = await stat(path)
        if (info.mtimeMs > cutoff) continue
        await rm(path, { force: true })
        removed += 1
      } catch { /* A file can disappear between enumeration and stat/unlink. */ }
    }
    return removed
  }

  private static async unlinkExisting(path: string): Promise<boolean> {
    try {
      const info = await stat(path)
      if (!info.isFile()) return false
      await rm(path, { force: true })
      return true
    } catch { return false }
  }
}
