/**
 * Codex terminal file-path extraction. Codex prints absolute session paths WITHOUT a drive letter
 * (`\Users\<user>\.codex\sessions\YYYY\MM\DD\rollout-*.jsonl`). The renderer has no drive to prepend,
 * so the ONLY thing Codex changes is `resolve()`: a driveless path that runs through `\.codex\` is
 * rewritten to a `~`-rooted one, which main's `expandHome` resolves. Everything else falls through to
 * the universal base.
 */

import type { AgentId } from '../types/contracts.js'
import { TerminalFilePathExtractor, type PathCandidate, type ResolveContext } from './terminalFilePathExtractor.js'

export class CodexFilePathExtractor extends TerminalFilePathExtractor {
  readonly agent: AgentId = 'codex'

  resolve(token: string, ctx: ResolveContext): PathCandidate[] {
    const cleaned = this.clean(token).replace(/\//g, '\\')
    const i = cleaned.toLowerCase().indexOf('\\.codex\\')
    if (cleaned.startsWith('\\') && i !== -1) return [{ kind: 'direct', path: '~' + cleaned.slice(i) }]
    return super.resolve(token, ctx)
  }
}
