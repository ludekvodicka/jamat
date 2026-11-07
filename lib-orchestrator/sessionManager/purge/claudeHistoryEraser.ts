import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ClaudeMemoryWrites } from '../../agentMemory/claudeMemoryWrites'
import { JsonShape } from '../../shared/jsonShape'
import type { AgentConversation, AgentHistoryEraser, ErasureReport } from './agentHistoryEraser.types'
import { ErasureLedger } from './erasureLedger'

export interface ClaudeHistoryEraserOptions {
  /** The main config home and every account profile's. A folder the profiles share is reached through any of them. */
  homes: () => readonly string[]
  /** Claude Code's temporary root: `CLAUDE_CODE_TMPDIR`, else the system one. */
  temporaryRoot: string
}

/**
 * What Claude Code 2.1.x keeps of one conversation, by its id: the transcript with its sub-agents and
 * tool results, file checkpoints, the session environment, tasks, todos, the debug log, the entry of
 * a running process, the prompts in `history.jsonl` and the temporary folder of its shells.
 *
 * Every project folder is searched rather than the one the session's directory encodes to: the id is
 * unique, and a session that was moved or renamed since would otherwise keep its transcript.
 *
 * Auto-memory files are not deleted. They are written by many conversations, and a file this one
 * wrote may hold what later ones added, so each one the transcript shows it writing is named instead.
 */
export class ClaudeHistoryEraser implements AgentHistoryEraser {
  private static readonly perIdFoldersConst: readonly string[] = ['file-history', 'session-env', 'tasks']

  private readonly homes: () => readonly string[]
  private readonly temporaryRoot: string

  constructor(options: ClaudeHistoryEraserOptions) {
    this.homes = options.homes
    this.temporaryRoot = options.temporaryRoot
  }

  async erase(conversation: AgentConversation): Promise<ErasureReport> {
    const ledger = new ErasureLedger()
    const ids = conversation.nativeSessionIds.filter((id) => {
      if (ErasureLedger.conversationId(id)) return true
      ledger.report.leftovers.push(`Claude conversation ${JSON.stringify(id)}: not a conversation id, so nothing was searched for it`)
      return false
    })
    if (ids.length === 0) return ledger.report
    const homes = [...new Set(this.homes())]
    // Read before anything goes: the transcript is the only account of what the conversation wrote.
    ledger.report.notes.push(...(await ClaudeMemoryWrites.of(homes, ids))
      .map((path) => `Memory file ${path} was written by this conversation and stays; check what it holds`))
    for (const home of homes) {
      for (const project of await ErasureLedger.entries(join(home, 'projects'))) {
        if (!project.isDirectory()) continue
        for (const id of ids) {
          await ledger.remove(join(home, 'projects', project.name, `${id}.jsonl`))
          await ledger.remove(join(home, 'projects', project.name, id))
        }
      }
      for (const id of ids) {
        for (const folder of ClaudeHistoryEraser.perIdFoldersConst) await ledger.remove(join(home, folder, id))
        await ledger.remove(join(home, 'debug', `${id}.txt`))
      }
      for (const todo of await ErasureLedger.entries(join(home, 'todos')))
        if (ids.some((id) => todo.name.startsWith(`${id}-`))) await ledger.remove(join(home, 'todos', todo.name))
      for (const entry of await ErasureLedger.entries(join(home, 'sessions')))
        if (entry.name.endsWith('.json') && ids.includes(await ClaudeHistoryEraser.sessionIdOf(join(home, 'sessions', entry.name)) ?? ''))
          await ledger.remove(join(home, 'sessions', entry.name))
      await ledger.dropLines(join(home, 'history.jsonl'), 'sessionId', ids)
    }
    const temporary = join(this.temporaryRoot, 'claude')
    for (const project of await ErasureLedger.entries(temporary))
      if (project.isDirectory())
        for (const id of ids) await ledger.remove(join(temporary, project.name, id))
    return ledger.report
  }

  private static async sessionIdOf(file: string): Promise<string | null> {
    try {
      const value = JsonShape.record(JSON.parse(await readFile(file, 'utf8')))?.sessionId
      return typeof value === 'string' ? value : null
    }
    catch { return null }
  }
}
