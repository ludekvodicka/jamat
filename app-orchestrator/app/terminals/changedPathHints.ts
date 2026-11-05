import type { FileChangesManager } from '../../../lib-orchestrator/fileChangesManager/fileChangesManager'
import type { FileChangesContext } from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import type { TerminalDetectorDeps } from '../../../lib-orchestrator/terminalDetector/terminalDetector'
type TerminalDetectorPathHints = Awaited<ReturnType<TerminalDetectorDeps['changedPaths']>>

export class ChangedPathHints {
  private static readonly ttlMillisecondsConst = 5_000

  private readonly fileChanges: Pick<FileChangesManager, 'list'>

  private readonly changedPathHintCache: Map<string, { expiresAt: number; hints: Promise<TerminalDetectorPathHints> }>

  constructor(fileChanges: Pick<FileChangesManager, 'list'>) {
    this.changedPathHintCache = new Map()
    this.fileChanges = fileChanges
  }

  async read(context: FileChangesContext): Promise<TerminalDetectorPathHints> {
    const now = Date.now()
    for (const [key, entry] of this.changedPathHintCache)
      if (entry.expiresAt <= now) this.changedPathHintCache.delete(key)
    const cacheKey = `${context.sessionId}\0${context.cwd}`
    const held = this.changedPathHintCache.get(cacheKey)
    if (held !== undefined) return await held.hints
    // The PROMISE is what is held, not its answer: a second right click while the first list is
    // still running would otherwise miss, call `list()` again and push a second snapshot into
    // the same bounded ring - the eviction this cache exists to prevent, from two clicks.
    const hints = this.readChangedPathHints(context)
    this.changedPathHintCache.set(cacheKey, { expiresAt: Number.POSITIVE_INFINITY, hints })
    // Dated when it settles rather than when it was asked for, or a slow list spends its whole
    // life before anyone can be handed it.
    void hints.then(
      () => this.dateChangedPathHints(cacheKey),
      () => this.changedPathHintCache.delete(cacheKey),
    )
    return await hints
  }

  private async readChangedPathHints(
    context: FileChangesContext,
  ): Promise<TerminalDetectorPathHints> {
    const snapshot = await this.fileChanges.list(context)
    if (!snapshot.ok) return []
    const historical = snapshot.value.history.groups.flatMap((group) => group.entries)
    return [...snapshot.value.entries, ...historical].map((entry) => ({ path: entry.path }))
  }

  private dateChangedPathHints(cacheKey: string): void {
    const entry = this.changedPathHintCache.get(cacheKey)
    if (entry === undefined) return
    entry.expiresAt = Date.now() + ChangedPathHints.ttlMillisecondsConst
  }
}
