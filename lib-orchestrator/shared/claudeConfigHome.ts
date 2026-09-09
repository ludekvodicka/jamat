import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Where Claude Code keeps its own state, by Claude Code's own rule: `CLAUDE_CONFIG_DIR` when it is
 * set, so an isolated or demo profile is read exactly where it is written.
 *
 * One answer for the whole library, because the things that need it do not share a subsystem: the
 * project manager's locator, migrator and delete all read the transcript store under this home, and
 * the rate monitor reads the credentials file beside it. A second copy of this rule is a directory
 * one of them would read while another wrote somewhere else.
 */
export class ClaudeConfigHome {
  static resolve(explicit?: string): string {
    const configured = (explicit ?? process.env['CLAUDE_CONFIG_DIR'] ?? '').trim()
    return configured.length > 0 ? configured : join(homedir(), '.claude')
  }
}
