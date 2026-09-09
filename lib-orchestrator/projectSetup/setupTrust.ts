import { createHash } from 'node:crypto'

import { type JsonDocumentReading, JsonDocumentStore } from '../shared/jsonDocumentStore'
import { PathCompare } from '../shared/pathCompare'

interface SetupTrustDocument {
  schemaVersion: 1
  /** Comparable project path -> the hash of the command list this machine agreed to run there. */
  projects?: Record<string, string>
}

/**
 * Which repository-authored setups this machine has agreed to run, and the hashing that decides when
 * an agreement still holds.
 *
 * The whole store exists because `.worktree.json` arrives with a clone: its `setup` array is the one
 * input this library executes that nobody here wrote. An agreement is therefore per project AND per
 * command list - moving the commands withdraws it, and the person is asked again.
 *
 * Read leniently like the other stores here: a missing file, a damaged document and an unknown shape
 * all answer "nothing is acknowledged", because the failure mode of forgetting an agreement is one
 * extra question, while the failure mode of inventing one is running somebody else's shell.
 *
 * **A damaged read latches the WRITE, which is the other half of that sentence.** Reading nothing is
 * one extra question; writing over a document this store could not read replaces every OTHER
 * project's agreement with the single one being recorded, and those are answers a person already
 * gave. Every store in this library latches for the same reason, from the 2026-06-11 incident.
 */
export class SetupTrustStore extends JsonDocumentStore<SetupTrustDocument> {
  private document: SetupTrustDocument = { schemaVersion: 1 }

  private constructor(file: string, report: (message: string) => void) {
    super(file, report)
  }

  static load(file: string, report?: (message: string) => void): SetupTrustStore {
    const store = new SetupTrustStore(file, report ?? ((message) => console.warn(message)))
    store.document = store.readDocumentSync()
    return store
  }

  protected get subject(): string {
    return 'The setup agreements'
  }

  protected get refusalConsequence(): string {
    return 'nothing is recorded there until it is repaired or removed, '
      + 'and this setup will be asked about again'
  }

  protected get readFailureConsequence(): string {
    return 'nothing is acknowledged until it is repaired or removed'
  }

  protected emptyDocument(): SetupTrustDocument {
    return { schemaVersion: 1 }
  }

  protected writeFailureMessage(detail: string): string {
    return `Could not record the setup agreement in ${this.file}: ${detail}`
  }

  /**
   * The commands and nothing else. Re-indenting the file or adding a key beside `setup` keeps the
   * agreement; changing a command, or their order, which changes what runs when, withdraws it.
   */
  static hashOf(commands: readonly string[]): string {
    return createHash('sha256').update(JSON.stringify(commands)).digest('hex')
  }

  acknowledgedHashOf(projectRoot: string): string | null {
    return this.document.projects?.[PathCompare.comparable(projectRoot)] ?? null
  }

  /**
   * Best effort on purpose: a write that fails costs the person the same question next time, which is
   * the safe direction, and refusing the session over it would turn a bookkeeping failure into a
   * refusal to work.
   *
   * The file is re-read before the merge rather than merged into whatever this instance last saw. A
   * whole-document writer that trusts its own picture is how a second one silently drops the first
   * one's answers, and an agreement that disappears is a question asked again about something the
   * person already decided.
   */
  acknowledge(projectRoot: string, hash: string): void {
    // Re-read first: the latch it may set is what stops the merge below, and a second store's
    // agreements written since this one loaded are answers a person already gave.
    const current = this.readDocumentSync()
    const projects = { ...current.projects, [PathCompare.comparable(projectRoot)]: hash }
    const next: SetupTrustDocument = { schemaVersion: 1, projects }
    if (this.writeDocumentSync(next)) this.document = next
  }

  /**
   * A document with no `projects` key is the ordinary empty one and reads clean. A document that
   * is not an object, or whose `projects` is not one, is a file holding agreements this store
   * cannot see - which is exactly what must not be written over.
   */
  protected coerce(parsed: unknown): JsonDocumentReading<SetupTrustDocument> {
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      return { document: { schemaVersion: 1 }, damaged: true }
    const projects = (parsed as { projects?: unknown }).projects
    if (projects === undefined) return { document: { schemaVersion: 1 }, damaged: false }
    if (typeof projects !== 'object' || projects === null || Array.isArray(projects))
      return { document: { schemaVersion: 1 }, damaged: true }
    const kept: Record<string, string> = {}
    let damaged = false
    for (const [path, hash] of Object.entries(projects)) {
      if (typeof hash === 'string') kept[path] = hash
      // An entry this store drops is an agreement it would erase on the next write.
      else damaged = true
    }
    return { document: { schemaVersion: 1, projects: kept }, damaged }
  }
}
