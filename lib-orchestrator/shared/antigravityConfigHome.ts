import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Where Antigravity CLI (`agy`) keeps its settings and conversation brains (`~/.gemini/antigravity-cli`).
 *
 * One resolver so the status line relay, transcript view, token usage scanner and history eraser all
 * look in the same place. `JAMAT_V3_GEMINI_DIR` stands in for `~/.gemini`, so a test or smoke client
 * reads a fixture instead of the user's data. `agy` itself has no such variable and follows only the
 * OS home, so the variable moves Jamat's readers, never the launched agent:
 * docs/architecture/antigravity-home.md.
 */
export class AntigravityConfigHome {
  static readonly variableConst = 'JAMAT_V3_GEMINI_DIR'

  static resolve(override?: string): string {
    return override ?? join(AntigravityConfigHome.geminiDirectory(), 'antigravity-cli')
  }

  /** Where Antigravity discovers global rules, skills and hooks (`~/.gemini/config`). */
  static globalConfigDirectory(override?: string): string {
    return override ?? join(AntigravityConfigHome.geminiDirectory(), 'config')
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

  private static geminiDirectory(): string {
    const configured = (process.env[AntigravityConfigHome.variableConst] ?? '').trim()
    return configured.length > 0 ? configured : join(homedir(), '.gemini')
  }
}
