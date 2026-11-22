import { stat } from 'node:fs/promises'
import { join } from 'node:path'

import { AntigravityConfigHome } from '../../../shared/antigravityConfigHome'
import type { ProviderOutcome } from '../../projectManagerApi.types'
import type {
  MigrationPreflight,
  ProviderHistoryMigrator,
  RelocationJournalWriter,
  RelocationLeftoversWriter,
} from '../providerContract.types'
import { AntigravitySummariesDb } from './antigravitySummariesDb'

export interface AntigravityHistoryMigratorOptions {
  antigravityHome?: string
}

/**
 * Antigravity history lifecycle for project relocation and deletion.
 *
 * Antigravity keys conversations by UUID (never by encoded directory name), so relocating a project
 * never conflicts with an existing store directory. Its conversation metadata lives in binary SQLite
 * and protobuf stores (`conversation_summaries.db` and `conversations/<id>.db`), which cannot be
 * safely plain-text rewritten while the CLI daemon holds them open, so relocation leaves those
 * stores untouched and deletion enumerates only the conversation's own `brain/<id>` and
 * `conversations/<id>.db` files (never the shared `conversation_summaries.db`).
 */
export class AntigravityHistoryMigrator implements ProviderHistoryMigrator {
  readonly agentId = 'antigravity' as const

  private readonly antigravityHome: string

  constructor(options?: AntigravityHistoryMigratorOptions) {
    this.antigravityHome = AntigravityConfigHome.resolve(options?.antigravityHome)
  }

  async preflight(_oldDir: string, _newDir: string): Promise<MigrationPreflight> {
    return { ok: true }
  }

  async relocate(
    _oldDir: string,
    _newDir: string,
    _journal: RelocationJournalWriter,
    _leftovers: RelocationLeftoversWriter,
  ): Promise<ProviderOutcome> {
    return 'done'
  }

  async enumerateProjectFiles(projectDir: string): Promise<string[]> {
    const conversations = AntigravitySummariesDb.conversationsForProject(this.antigravityHome, projectDir)
    const brainRoot = AntigravityConfigHome.brainDirectory(this.antigravityHome)
    const conversationsRoot = join(this.antigravityHome, 'conversations')
    const found: string[] = []
    for (const conversation of conversations) {
      for (const candidate of [
        join(brainRoot, conversation.conversationId),
        join(conversationsRoot, `${conversation.conversationId}.db`),
      ]) {
        try {
          await stat(candidate)
          found.push(candidate)
        }
        catch { /* absent */ }
      }
    }
    return found.sort()
  }
}
