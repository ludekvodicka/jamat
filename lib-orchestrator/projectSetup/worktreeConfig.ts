import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { AtomicJsonFile } from '../shared/atomicJsonFile'
import { ErrorText } from '../shared/errorText'

export type WorktreeConfigRead =
  /** Null: nothing here declares a setup - no file at all, or a file carrying only other keys. */
  | { ok: true; value: { setup: string[] } | null }
  | { ok: false; problem: string }

export type WorktreeConfigWrite = { ok: true } | { ok: false; problem: string }

/**
 * The keys of this file that are owned outside `projectSetup/`, and so the register of those owners:
 * a new owner adds its key here and reads through `sectionOf`, never by opening the file.
 * `scripts`: the named before and after scripts of a worktree session, owned by the session manager.
 */
export type WorktreeConfigSectionKey = 'scripts'

/**
 * One read of the file. Every value one decision takes from it comes from the same load, so what runs
 * is never assembled from two reads a writer could have changed the file between.
 */
export type WorktreeConfigLoad =
  /** `document` null: there is no file. */
  | { ok: true; file: string; document: Record<string, unknown> | null }
  | { ok: false; problem: string }

export type WorktreeConfigSectionRead<T> =
  /** Null: the key is absent, or there is no file at all. */
  | { ok: true; value: T | null }
  | { ok: false; problem: string }

/**
 * `<projectRoot>/.worktree.json`, the project's own word on how a fresh worktree is prepared. It
 * travels with the repository, which is why it outranks both this machine's settings and anything a
 * detector concluded.
 *
 * Only `setup` is read and only `setup` is written by this class itself. A key with an owner elsewhere
 * (`WorktreeConfigSectionKey`) is read through `sectionOf` over a `load`, where this class opens the file
 * and the owner's coerce decides the value. `dev`, `cleanup` and every key this build has never heard of belong
 * to whoever put them there: they are not validated on the way in and they survive a save untouched.
 *
 * **This class is the file's custodian, and the decision is made here rather than when the second key
 * arrives.** `save` is a whole-document read-modify-write, so a second class writing the same file
 * would lose whatever the first one meant to keep - the failure the architecture avoids for
 * `config.json` versus `platforms.json` by splitting them, which cannot be done here because the file
 * travels with the repository under a name its other tools already use. When `dev` or `cleanup` gets
 * an owner, that owner hands its key to this class and never opens the file itself; the alternative
 * is either a second writer racing this one, or `projectSetup/` quietly growing the concerns its own
 * fence says are not its. It costs a sentence today and a redesign later.
 */
export class WorktreeConfig {
  static readonly setupCommandsMaxConst = 32
  static readonly setupCommandCharactersMaxConst = 4_096
  private static readonly fileNameConst = '.worktree.json'

  /** A broken file is a refusal, never a fallback: reading past it would run somebody else's install. */
  static async read(projectRoot: string): Promise<WorktreeConfigRead> {
    return WorktreeConfig.setupOf(await WorktreeConfig.load(projectRoot))
  }

  static async load(projectRoot: string): Promise<WorktreeConfigLoad> {
    const file = WorktreeConfig.fileOf(projectRoot)
    const loaded = await WorktreeConfig.documentOf(file)
    return loaded.ok ? { ok: true, file, document: loaded.document } : loaded
  }

  /** What `setup` says in one load. */
  static setupOf(loaded: WorktreeConfigLoad): WorktreeConfigRead {
    if (!loaded.ok) return loaded
    const setup = loaded.document?.setup
    if (setup === undefined) return { ok: true, value: null }
    const problem = WorktreeConfig.setupProblem(setup, loaded.file)
    if (problem) return { ok: false, problem }
    return { ok: true, value: { setup: setup as string[] } }
  }

  /**
   * The value of a key owned elsewhere, in one load. The file itself (missing, unreadable, broken JSON,
   * not an object) is judged by `load`, so every owner refuses a broken file in the same words; the
   * owner's coerce judges only its own value and names the file in its problem.
   */
  static sectionOf<T>(
    loaded: WorktreeConfigLoad,
    key: WorktreeConfigSectionKey,
    coerce: (value: unknown, file: string) => { ok: true; value: T } | { ok: false; problem: string },
  ): WorktreeConfigSectionRead<T> {
    if (!loaded.ok) return loaded
    const value = loaded.document?.[key]
    if (value === undefined) return { ok: true, value: null }
    return coerce(value, loaded.file)
  }

  /**
   * Dormant until the project settings UI calls it; the trigger is registered in
   * `docs/architecture/lib-orchestrator.md`. It is never called after a detection: a detected setup
   * is this build's opinion, and writing it into the repository would turn it into the project's.
   */
  static async save(projectRoot: string, setup: string[]): Promise<WorktreeConfigWrite> {
    const file = WorktreeConfig.fileOf(projectRoot)
    const invalid = WorktreeConfig.setupProblem(setup, file)
    if (invalid) return { ok: false, problem: invalid }
    const loaded = await WorktreeConfig.documentOf(file)
    // Writing over a file that failed to parse would drop the rest of what the user wrote in it.
    if (!loaded.ok) return loaded
    const document = loaded.document ?? {}
    // Not the owner-only mode the rest of this library writes with: this file sits in the user's
    // checkout and is meant to be committed, so a save must not tighten it to 0600 behind their back.
    try { AtomicJsonFile.write(file, { ...document, setup }, AtomicJsonFile.checkedInFileConst) }
    catch (error) {
      return { ok: false, problem: `${file} could not be written: ${ErrorText.of(error)}` }
    }
    return { ok: true }
  }

  private static fileOf(projectRoot: string): string {
    return join(projectRoot, WorktreeConfig.fileNameConst)
  }

  /** Null: there is no file. */
  private static async documentOf(
    file: string,
  ): Promise<{ ok: true; document: Record<string, unknown> | null } | { ok: false; problem: string }> {
    const loaded = await WorktreeConfig.readIfPresent(file)
    if (!loaded.ok) return loaded
    if (loaded.raw === null) return { ok: true, document: null }
    return WorktreeConfig.parse(loaded.raw, file)
  }

  private static async readIfPresent(
    file: string,
  ): Promise<{ ok: true; raw: string | null } | { ok: false; problem: string }> {
    try { return { ok: true, raw: await readFile(file, 'utf8') } }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, raw: null }
      return { ok: false, problem: `${file} could not be read: ${ErrorText.of(error)}` }
    }
  }

  private static parse(
    raw: string,
    file: string,
  ): { ok: true; document: Record<string, unknown> } | { ok: false; problem: string } {
    let parsed: unknown
    try { parsed = JSON.parse(raw) }
    catch (error) {
      return { ok: false, problem: `${file} is not valid JSON: ${ErrorText.of(error)}` }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return { ok: false, problem: `${file} must hold a JSON object` }
    return { ok: true, document: parsed as Record<string, unknown> }
  }

  private static setupProblem(value: unknown, file: string): string | null {
    if (!Array.isArray(value)) return `${file}: "setup" must be an array of commands`
    if (value.length > WorktreeConfig.setupCommandsMaxConst)
      return `${file}: "setup" may hold at most ${WorktreeConfig.setupCommandsMaxConst} commands`
    if (value.some((command) => typeof command !== 'string' || command.trim().length === 0))
      return `${file}: every "setup" entry must be a non-empty command string`
    if (value.some((command) => command.length > WorktreeConfig.setupCommandCharactersMaxConst))
      return `${file}: every "setup" command may hold at most ${WorktreeConfig.setupCommandCharactersMaxConst} characters`
    return null
  }
}
