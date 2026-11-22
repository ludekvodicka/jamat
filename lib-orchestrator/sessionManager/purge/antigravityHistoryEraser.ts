import { AntigravityConfigHome } from '../../shared/antigravityConfigHome'
import type { AgentConversation, AgentHistoryEraser, ErasureReport } from './agentHistoryEraser.types'
import { ErasureLedger } from './erasureLedger'

export interface AntigravityHistoryEraserOptions {
  /** Antigravity CLI home directory (`~/.gemini/antigravity-cli`). */
  home?: string
}

/**
 * What Antigravity CLI (`agy`) keeps of one conversation by its id: its brain directory
 * (`<home>/brain/<conversationId>`), containing `.system_generated/logs/transcript.jsonl`,
 * step outputs, artifacts and scratch files.
 */
export class AntigravityHistoryEraser implements AgentHistoryEraser {
  private readonly home: string

  constructor(options?: AntigravityHistoryEraserOptions) {
    this.home = AntigravityConfigHome.resolve(options?.home)
  }

  async erase(conversation: AgentConversation): Promise<ErasureReport> {
    const ledger = new ErasureLedger()
    const ids = conversation.nativeSessionIds.filter((id) => {
      if (ErasureLedger.conversationId(id)) return true
      ledger.report.leftovers.push(`Antigravity conversation ${JSON.stringify(id)}: not a conversation id, so nothing was searched for it`)
      return false
    })
    for (const id of ids)
      await ledger.remove(AntigravityConfigHome.conversationDirectory(this.home, id))
    return ledger.report
  }
}
