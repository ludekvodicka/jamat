import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * What Claude Code's settings say about one project: the effort the next turn will be asked for, and
 * the model it will be asked of.
 *
 * Both are CONFIGURATION, not the live state of a running agent, and they keep saying what they say
 * after the session has ended. They share a class because they share the cascade: one pass over the
 * three files answers both, and the precedence is resolved per key, the way Claude Code merges them
 * - a project file naming only `model` must not hide the home file's `effortLevel`.
 */
export interface ClaudeSettingsReading {
  effortLevel: string | null
  /**
   * The model AS CONFIGURED - an alias (`opus[1m]`) or a full id (`claude-opus-5[1m]`), and the only
   * place the `[1m]` tier is written down: the transcript records the bare id the API answered with,
   * so a million-token session is indistinguishable from a two-hundred-thousand one without this.
   */
  model: string | null
}

export class ClaudeSettingsCascade {
  /** Claude Code's own precedence order, most specific first. */
  private static filesOf(cwd: string, claudeHome: string): string[] {
    return [
      join(cwd, '.claude', 'settings.local.json'),
      join(cwd, '.claude', 'settings.json'),
      join(claudeHome, 'settings.json'),
    ]
  }

  static async readingOf(cwd: string, claudeHome: string): Promise<ClaudeSettingsReading> {
    const reading: ClaudeSettingsReading = { effortLevel: null, model: null }
    for (const file of ClaudeSettingsCascade.filesOf(cwd, claudeHome)) {
      const settings = await ClaudeSettingsCascade.recordIn(file)
      if (settings === null) continue
      reading.effortLevel ??= ClaudeSettingsCascade.stringIn(settings, 'effortLevel')
      reading.model ??= ClaudeSettingsCascade.stringIn(settings, 'model')
      if (reading.effortLevel !== null && reading.model !== null) break
    }
    return reading
  }

  /** A missing file and unreadable JSON are both "this one does not say". */
  private static async recordIn(file: string): Promise<Record<string, unknown> | null> {
    let parsed: unknown
    try { parsed = JSON.parse(await readFile(file, 'utf8')) }
    catch { return null }
    if (parsed === null || typeof parsed !== 'object') return null
    return parsed as Record<string, unknown>
  }

  /** An empty string does not say either: the cascade walks past it to the next file. */
  private static stringIn(settings: Record<string, unknown>, key: string): string | null {
    const value = settings[key]
    return typeof value === 'string' && value.length > 0 ? value : null
  }
}
