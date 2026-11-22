import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Where Antigravity CLI (`agy`) keeps its settings and conversation brains (`~/.gemini/antigravity-cli`).
 *
 * One resolver so the status line relay, transcript view, token usage scanner and history eraser all
 * look in the same place and take an explicit override in tests without touching the user's home.
 */
export class AntigravityConfigHome {
  static resolve(override?: string): string {
    return override ?? join(homedir(), '.gemini', 'antigravity-cli')
  }

  /** Where Antigravity discovers global rules, skills and hooks (`~/.gemini/config`). */
  static globalConfigDirectory(override?: string): string {
    return override ?? join(homedir(), '.gemini', 'config')
  }

  static brainDirectory(home?: string): string {
    return join(AntigravityConfigHome.resolve(home), 'brain')
  }

  static conversationDirectory(home: string | undefined, nativeSessionId: string): string {
    return join(AntigravityConfigHome.brainDirectory(home), nativeSessionId)
  }

  static transcriptFile(home: string | undefined, nativeSessionId: string): string {
    return join(
      AntigravityConfigHome.conversationDirectory(home, nativeSessionId),
      '.system_generated',
      'logs',
      'transcript.jsonl',
    )
  }
}
