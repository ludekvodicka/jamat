import { join } from 'node:path'

import type { CodexAppServerClient } from '../../rateMonitor/codexAppServerView'
import type { AgentConversation, AgentHistoryEraser, ErasureReport } from './agentHistoryEraser.types'
import { ErasureLedger } from './erasureLedger'

export interface CodexHistoryEraserOptions {
  /** The main Codex home: account profiles share its sessions, prompt history and databases. */
  home: string
  /** The sub-agent threads of a thread, from the rollouts written since `since`. */
  childrenOf: (threadId: string, since: number) => Promise<readonly string[]>
  /** A client of its own per erase, closed when the erase ends. */
  client: () => Pick<CodexAppServerClient, 'deleteThread' | 'close'>
}

/**
 * Codex deletes a thread itself through `thread/delete`: the rollout file and its rows in the state and
 * thread history databases (measured on 0.167.0). Its sub-agent threads are deleted the same way, and
 * a thread already gone answers "no rollout found", which is the outcome asked for. The prompt history
 * and the thread names stay in two JSONL files that the delete does not touch, so their lines are
 * dropped here.
 */
export class CodexHistoryEraser implements AgentHistoryEraser {
  private static readonly goneReasonPatternConst = /no rollout found/i

  private readonly home: string
  private readonly childrenOf: CodexHistoryEraserOptions['childrenOf']
  private readonly client: CodexHistoryEraserOptions['client']

  constructor(options: CodexHistoryEraserOptions) {
    this.home = options.home
    this.childrenOf = options.childrenOf
    this.client = options.client
  }

  async erase(conversation: AgentConversation): Promise<ErasureReport> {
    const ledger = new ErasureLedger()
    const ids = conversation.nativeSessionIds.filter((id) => {
      if (ErasureLedger.conversationId(id)) return true
      ledger.report.leftovers.push(`Codex thread ${JSON.stringify(id)}: not a thread id, so nothing was searched for it`)
      return false
    })
    if (ids.length === 0) return ledger.report
    const threads = new Set(ids)
    for (const id of ids)
      for (const child of await this.childrenOf(id, conversation.since))
        if (ErasureLedger.conversationId(child)) threads.add(child)
    const client = this.client()
    try {
      for (const thread of threads) {
        const answer = await client.deleteThread(thread)
        if (answer.ok) ledger.report.erased.push(`Codex thread ${thread}`)
        else if (!CodexHistoryEraser.goneReasonPatternConst.test(answer.reason))
          ledger.report.leftovers.push(`Codex thread ${thread}: ${answer.reason}`)
      }
    }
    finally { await client.close() }
    await ledger.dropLines(join(this.home, 'history.jsonl'), 'session_id', [...threads])
    await ledger.dropLines(join(this.home, 'session_index.jsonl'), 'id', [...threads])
    return ledger.report
  }
}
