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
 * `<projectRoot>/.worktree.json`, the project's own word on how a fresh worktree is prepared. It
 * travels with the repository, which is why it outranks both this machine's settings and anything a
 * detector concluded.
 *
 * Only `setup` is read and only `setup` is written. `dev`, `cleanup` and every key this build has
 * never heard of belong to whoever put them there: they are not validated on the way in and they
 * survive a save untouched.
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
    const file = WorktreeConfig.fileOf(projectRoot)
    const loaded = await WorktreeConfig.readIfPresent(file)
    if (!loaded.ok) return loaded
    if (loaded.raw === null) return { ok: true, value: null }
    const parsed = WorktreeConfig.parse(loaded.raw, file)
    if (!parsed.ok) return parsed
    const setup = parsed.document.setup
    if (setup === undefined) return { ok: true, value: null }
    const problem = WorktreeConfig.setupProblem(setup, file)
    if (problem) return { ok: false, problem }
    return { ok: true, value: { setup: setup as string[] } }
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
    const loaded = await WorktreeConfig.readIfPresent(file)
    if (!loaded.ok) return loaded
    let document: Record<string, unknown> = {}
    if (loaded.raw !== null) {
      const parsed = WorktreeConfig.parse(loaded.raw, file)
      // Writing over a file that failed to parse would drop the rest of what the user wrote in it.
      if (!parsed.ok) return parsed
      document = parsed.document
    }
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
