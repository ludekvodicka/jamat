import { readdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  RelocationJournalDocument,
  RelocationJournalWriter,
  RelocationStep,
} from '../providers/providerContract.types'
import { AtomicJsonFile } from '../../shared/atomicJsonFile'
import { ErrorText } from '../../shared/errorText'

/**
 * One file per relocation, written before the first effect on disk and removed once the operation
 * finished. What survives a crash is that file: the next startup sweep reads it, sees which provider
 * files were already dealt with and resumes from there, with no rollback.
 *
 * Leftovers deliberately live in their own file instead of here - the journal dies with the operation
 * that wrote it, a leftover outlives it and waits for a sweep that may be days away.
 */
export class RelocationJournal implements RelocationJournalWriter {
  private static readonly fileSuffixConst = '.json'
  private static readonly kindsConst: ReadonlySet<RelocationJournalDocument['kind']> = new Set([
    'rename',
    'move-prefix',
    'archive',
  ])
  private static readonly stepStatesConst: ReadonlySet<RelocationStep['state']> = new Set([
    'done',
    'copied-pending-delete',
  ])

  constructor(
    private readonly directory: string,
    private readonly journalDocument: RelocationJournalDocument,
  ) {}

  /** The identity a migrator stamps its leftovers with, so a record names the operation that made it. */
  get operationId(): string {
    return this.journalDocument.operationId
  }

  /** Called before the caller's first effect on disk: there is no relocation without its journal. */
  static async open(
    directory: string,
    document: RelocationJournalDocument,
  ): Promise<RelocationJournal> {
    const journal = new RelocationJournal(directory, document)
    journal.persist()
    return journal
  }

  /**
   * The journals of operations that never finished. A damaged one is reported and skipped rather than
   * thrown: one broken relocation must not stop every later start from sweeping the others.
   */
  static async pending(
    directory: string,
    report: (message: string) => void,
  ): Promise<RelocationJournalDocument[]> {
    const documents: RelocationJournalDocument[] = []
    for (const name of await RelocationJournal.journalNames(directory)) {
      const file = join(directory, name)
      try {
        documents.push(RelocationJournal.coerce(JSON.parse(await readFile(file, 'utf8'))))
      } catch (error) {
        report(`Relocation journal ${file} is unusable (${ErrorText.of(error)}); skipping it`)
      }
    }
    return documents
  }

  static async discard(directory: string, operationId: string): Promise<void> {
    try {
      await unlink(RelocationJournal.fileOf(directory, operationId))
    } catch (error) {
      // Already gone is the state this asks for, not a failure to report.
      if (!RelocationJournal.isMissing(error)) throw error
    }
  }

  /**
   * Synchronous by contract, and the write is synchronous with it: a checkpoint that returned before
   * reaching the disk would describe progress a crash could not confirm, and one write path for a
   * few hundred bytes is worth more here than the awaited call.
   */
  checkpoint(step: RelocationStep): void {
    this.journalDocument.steps.push(step)
    this.persist()
  }

  markDirectoryRenamed(): void {
    this.journalDocument.directoryRenamed = true
    this.persist()
  }

  document(): RelocationJournalDocument {
    return { ...this.journalDocument, steps: [...this.journalDocument.steps] }
  }

  private persist(): void {
    AtomicJsonFile.ensureDirectory(this.directory)
    AtomicJsonFile.write(
      RelocationJournal.fileOf(this.directory, this.journalDocument.operationId),
      this.journalDocument,
    )
  }

  private static fileOf(directory: string, operationId: string): string {
    return join(directory, `${operationId}${RelocationJournal.fileSuffixConst}`)
  }

  private static async journalNames(directory: string): Promise<string[]> {
    try {
      return (await readdir(directory))
        .filter((name) => name.endsWith(RelocationJournal.fileSuffixConst))
        .sort()
    } catch (error) {
      // No directory at all means no operation ever ran here.
      if (RelocationJournal.isMissing(error)) return []
      throw error
    }
  }

  private static isMissing(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }

  private static coerce(parsed: unknown): RelocationJournalDocument {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('expected an object')
    const document = parsed as Partial<RelocationJournalDocument>
    if (document.schemaVersion !== 1)
      throw new Error(`unsupported schema version ${JSON.stringify(document.schemaVersion)}`)
    if (!RelocationJournal.isFilledString(document.operationId))
      throw new Error('operationId must be a non-empty string')
    if (typeof document.kind !== 'string' || !RelocationJournal.kindsConst.has(document.kind))
      throw new Error(`unknown relocation kind ${JSON.stringify(document.kind)}`)
    if (!RelocationJournal.isFilledString(document.oldPath)
      || !RelocationJournal.isFilledString(document.newPath))
      throw new Error('oldPath and newPath must be non-empty strings')
    if (typeof document.directoryRenamed !== 'boolean')
      throw new Error('directoryRenamed must be a boolean')
    if (!Array.isArray(document.steps))
      throw new Error('steps must be an array')
    return {
      schemaVersion: 1,
      operationId: document.operationId,
      kind: document.kind,
      oldPath: document.oldPath,
      newPath: document.newPath,
      directoryRenamed: document.directoryRenamed,
      steps: document.steps
        .map(RelocationJournal.coerceStep)
        .filter((step) => step !== null),
    }
  }

  /**
   * A damaged step costs itself and nothing else. The resume does not read the steps at all - it runs
   * the migration again and relies on its idempotence - so failing the whole journal over one of them
   * would throw away the record of work that really is unfinished, and the file would sit there being
   * reported at every start for good.
   */
  private static coerceStep(candidate: unknown): RelocationStep | null {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
    const step = candidate as Partial<RelocationStep>
    if (step.provider !== 'claude' && step.provider !== 'codex') return null
    if (!RelocationJournal.isFilledString(step.file)) return null
    if (typeof step.state !== 'string' || !RelocationJournal.stepStatesConst.has(step.state))
      return null
    return { provider: step.provider, file: step.file, state: step.state }
  }

  private static isFilledString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0
  }
}
