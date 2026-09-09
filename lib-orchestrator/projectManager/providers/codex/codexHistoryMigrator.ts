import type { ProviderOutcome } from '../../projectManagerApi.types'
import { ErrorText } from '../../../shared/errorText'
import type { RewriterIo } from '../core/transcriptRewriter'
import { TranscriptRewriter } from '../core/transcriptRewriter'
import type {
  MigrationPreflight,
  ProviderAgentId,
  ProviderHistoryMigrator,
  RelocationJournalWriter,
  RelocationLeftoversWriter,
} from '../providerContract.types'
import type { CodexRolloutIndex } from './codexRolloutIndex'

export interface CodexHistoryMigratorDeps {
  index: CodexRolloutIndex
  report: (message: string) => void
  io?: RewriterIo
}

/**
 * Moves a project's Codex history to where the project went - without moving a single file.
 *
 * Codex files a rollout under the date it started and records the project directory inside the file,
 * so nothing about its location depends on the project path: the whole migration is a rewrite of the
 * paths held in the rollouts that belong to this project, and only those.
 */
export class CodexHistoryMigrator implements ProviderHistoryMigrator {
  readonly agentId: ProviderAgentId = 'codex'
  private readonly index: CodexRolloutIndex
  private readonly report: (message: string) => void
  private readonly io: RewriterIo | undefined

  constructor(deps: CodexHistoryMigratorDeps) {
    this.index = deps.index
    this.report = deps.report
    this.io = deps.io
  }

  /** Nothing to collide with: Codex has no directory named after the project. */
  async preflight(_oldDir: string, _newDir: string): Promise<MigrationPreflight> {
    return { ok: true }
  }

  async relocate(
    oldDir: string,
    newDir: string,
    journal: RelocationJournalWriter,
    leftovers: RelocationLeftoversWriter,
  ): Promise<ProviderOutcome> {
    // No encoder: Codex derives no name from the path, and replacing a shape its format never holds
    // could only corrupt unrelated text that happens to look like one.
    const replacements = TranscriptRewriter.replacementsOf(oldDir, newDir)
    let recorded = 0
    try {
      // Every rollout, not the windowed listing: one older than the window would keep a path that
      // this rename is about to make untrue, and nothing would ever come back to it.
      for (const rollout of await this.index.allFilesForProject(oldDir)) {
        const outcome = await TranscriptRewriter.rewriteInPlace(
          rollout.file,
          replacements,
          this.io,
        )
        if (outcome === 'rewritten' || outcome === 'unchanged')
          journal.checkpoint({ provider: this.agentId, file: rollout.file, state: 'done' })
        else if (outcome === 'left-locked') {
          // A session that is open right now stops this file and nothing else: the rest of the
          // project's history still moves, and the sweep retries this one at the next start.
          const stored = leftovers.record({
            kind: 'rewrite',
            provider: this.agentId,
            path: rollout.file,
            operationId: journal.operationId,
            oldPath: oldDir,
            newPath: newDir,
            recordedAt: Date.now(),
          })
          // A refused record is the one case where nothing else will ever name this file again, so
          // the path itself goes into the log rather than a count nobody can act on.
          if (!stored)
            this.report(
              `Codex rollout ${rollout.file} still names ${oldDir} and could not be registered for`
              + ' the cleanup sweep; rewrite it by hand',
            )
          recorded += 1
        }
        else
          throw new Error(`Unknown rewrite outcome: ${JSON.stringify(outcome)}`)
      }
      return recorded === 0 ? 'done' : 'done-with-leftovers'
    } catch (error) {
      // Reported and turned into an outcome, never swallowed: on 'failed' the caller keeps the journal
      // and the next startup sweep replays what is left.
      this.report(`Codex history migration ${oldDir} -> ${newDir} failed: ${ErrorText.of(error)}`)
      return 'failed'
    } finally {
      // A throw half way through the loop leaves the rollouts it already rewrote naming the new path,
      // so the forget belongs to the attempt and not to its outcome. Said before invalidate() so that
      // an index rebuilt by anything in between reads these headers instead of the old answers.
      this.index.forgetProject(oldDir)
      this.index.invalidate()
    }
  }

  /**
   * The rollouts of this project, and never `session_index.jsonl`: that file is shared by every
   * session of the store, is appended to by a program that is not this one, and an orphaned name in
   * it is harmless where a rewritten or deleted one is not.
   */
  async enumerateProjectFiles(projectDir: string): Promise<string[]> {
    return (await this.index.allFilesForProject(projectDir)).map((rollout) => rollout.file)
  }
}
