import type { ProviderOutcome, ProviderSessionSummary } from '../projectManagerApi.types'

export type ProviderAgentId = 'claude' | 'codex'

/**
 * Deliberately narrow. Claude finds a project's history by transforming the path into a directory
 * name; Codex has no such mapping and must build an index over its own store. Anything wider than
 * list/latest/invalidate would force one of the two to pretend it works like the other.
 */
export interface ProviderSessionSource {
  readonly agentId: ProviderAgentId
  /**
   * An aborted listing hands back what it has read so far instead of rejecting. The two drivers run
   * side by side in one `Promise.all`, so a rejection from either would throw away the other's work
   * as well - and nobody is waiting for an abandoned listing anyway.
   */
  listProjectSessions(
    projectDir: string,
    options: { limit: number; signal?: AbortSignal },
  ): Promise<ProviderSessionSummary[]>
  /** Cheap enough to call for every project in a listing: no transcript is parsed for it. */
  latestActivity(projectDir: string): Promise<number | null>
  invalidate(): void
}

export interface MigrationPreflight {
  ok: boolean
  /** Set when the move cannot start, e.g. both the old and the new store directory already exist. */
  conflict?: string
}

export interface ProviderHistoryMigrator {
  readonly agentId: ProviderAgentId
  preflight(oldDir: string, newDir: string): Promise<MigrationPreflight>
  /** Checkpoints every file it touches; a locked file becomes a leftover and does not stop the run. */
  relocate(
    oldDir: string,
    newDir: string,
    journal: RelocationJournalWriter,
    leftovers: RelocationLeftoversWriter,
  ): Promise<ProviderOutcome>
  /** Exactly the files belonging to this project, for the delete preview and the delete itself. */
  enumerateProjectFiles(projectDir: string): Promise<string[]>
}

export interface RelocationStep {
  provider: ProviderAgentId
  file: string
  state: 'done' | 'copied-pending-delete'
}

export interface RelocationJournalDocument {
  schemaVersion: 1
  operationId: string
  kind: 'rename' | 'move-prefix' | 'archive'
  oldPath: string
  newPath: string
  directoryRenamed: boolean
  steps: RelocationStep[]
}

/**
 * What a relocation or a delete could not finish with. Both kinds outlive the operation that
 * produced them: the journal is removed once the operation finishes, the leftovers wait for the next
 * startup sweep.
 *
 * A union rather than one shape with optional fields, because the two replays need different facts.
 * Removing a path needs only the path; replaying a rewrite needs the two paths and the provider, so
 * the sweep knows whether the replacement includes the encoded shape. A `delete` record carries no
 * provider at all: the project directory belongs to neither store, and a field filled in with
 * whichever value passed validation is a stored untruth.
 */
export type LeftoverEntry =
  | {
    kind: 'delete'
    path: string
    operationId: string
    recordedAt: number
  }
  | {
    kind: 'rewrite'
    provider: ProviderAgentId
    path: string
    operationId: string
    oldPath: string
    newPath: string
    recordedAt: number
  }

export interface RelocationJournalWriter {
  /** The operation these steps belong to: a migrator stamps the leftovers it records with it. */
  readonly operationId: string
  checkpoint(step: RelocationStep): void
}

export interface RelocationLeftoversWriter {
  /**
   * False when the record could not be stored - a latched file is never overwritten. The caller has
   * already left the copy or the unrewritten transcript on disk, so a refusal is something it must
   * say out loud rather than count as one more leftover on the list.
   */
  record(entry: LeftoverEntry): boolean
}
