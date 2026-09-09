import { TerminalPathExtractor, type PathCandidate, type PathResolveContext } from './terminalPathExtractor'

/**
 * Codex prints its own session files without a drive letter (`\Users\<user>\.codex\sessions\...`),
 * so the base extractor would hand the disk a path that cannot exist. Rewriting it under the home
 * directory is the only per-agent delta Codex has.
 */
export class CodexPathExtractor extends TerminalPathExtractor {
  override resolve(token: string, context: PathResolveContext): PathCandidate[] {
    const { path, line, column } = this.parse(token)
    const normalized = path.replace(/\//g, '\\')
    const index = normalized.toLowerCase().indexOf('\\.codex\\')
    if (!normalized.startsWith('\\') || index === -1) return super.resolve(token, context)
    const rewritten = this.directPath(`~${normalized.slice(index)}`, null)
    return rewritten === null ? [] : [{ kind: 'direct', path: rewritten, line, column }]
  }
}
