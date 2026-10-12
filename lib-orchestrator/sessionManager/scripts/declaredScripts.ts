import { join, posix, win32 } from 'node:path'

import { SetupPaths } from '../../projectSetup/setupPaths'
import type { SessionRecordScriptStep } from '../records/sessionRecord.types'
import { ScriptChain } from './scriptChain'

export type DeclaredScriptPhase = 'before' | 'after'

export interface DeclaredScript {
  name: string
  command: string
  /** Project-relative and forward-slashed; `''` is the project itself. */
  cwd: string
}

export interface DeclaredScriptsValue {
  before: readonly DeclaredScript[]
  after: readonly DeclaredScript[]
}

type Coerced<T> = { ok: true; value: T } | { ok: false; problem: string }

/**
 * The owner of the `scripts` key of `.worktree.json`: the named before and after scripts a project
 * runs in its worktree sessions. `WorktreeConfig` opens the file; this class decides the value.
 *
 * Strict: an unknown phase key (`befor`) or entry key (`comand`) is a refusal, never a silent skip,
 * because a skipped check would read as a passed one.
 */
export class DeclaredScripts {
  static readonly perPhaseMaxConst = 8
  static readonly nameCharactersMaxConst = 40
  static readonly commandCharactersMaxConst = 4_096
  private static readonly phasesConst: readonly string[] = ['before', 'after']
  private static readonly entryKeysConst: readonly string[] = ['name', 'command', 'cwd']
  private static readonly namePatternConst = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/
  /**
   * The rule inner runs keep. A second line would run unguarded by the `|| exit $?` after the first,
   * so a failed check could pass, and the agreement shows a line break as a space.
   */
  private static readonly controlCharactersConst = /[\0\r\n]/

  static coerce(value: unknown, file: string): Coerced<DeclaredScriptsValue> {
    if (!DeclaredScripts.isObject(value))
      return DeclaredScripts.refused(file, '"scripts" must be an object holding "before" and "after" lists')
    const unknownKey = Object.keys(value).find((key) => !DeclaredScripts.phasesConst.includes(key))
    if (unknownKey !== undefined)
      return DeclaredScripts.refused(
        file,
        `"scripts" has an unknown key ${JSON.stringify(unknownKey)}; it holds only "before" and "after"`,
      )
    const before = DeclaredScripts.phaseOf(value.before, 'before', file)
    if (!before.ok) return before
    const after = DeclaredScripts.phaseOf(value.after, 'after', file)
    if (!after.ok) return after
    return { ok: true, value: { before: before.value, after: after.value } }
  }

  /**
   * Steps inside a worktree: the project's place in the repository, then the entry's own `cwd`.
   * `projectRoot` and `repositoryRoot` are the main copy's, and the worktree mirrors the repository.
   */
  static stepsOf(
    scripts: readonly DeclaredScript[],
    place: { projectRoot: string; repositoryRoot: string; worktreePath: string },
  ): { ok: true; steps: SessionRecordScriptStep[] } | { ok: false; problem: string } {
    const projectCwd = SetupPaths.relativeOf(place.repositoryRoot, place.projectRoot)
    if (projectCwd === null)
      return {
        ok: false,
        problem: `${place.projectRoot} is not inside the repository ${place.repositoryRoot}, so there is`
          + ' no directory inside a worktree to run its scripts in',
      }
    const steps: SessionRecordScriptStep[] = []
    for (const script of scripts) {
      // `coerce` already refused this; a value that did not come through it must not reach a shell.
      const problem = DeclaredScripts.cwdProblem(script.cwd)
      if (problem)
        return {
          ok: false,
          problem: `the script ${JSON.stringify(script.name)} asks to run in ${JSON.stringify(script.cwd)}, which ${problem}`,
        }
      const commands = [{ command: script.command, cwd: join(place.worktreePath, projectCwd, script.cwd) }]
      steps.push({
        key: ScriptChain.keyOf({ scriptId: 'declared', name: script.name, commands }),
        scriptId: 'declared',
        name: script.name,
        commands,
      })
    }
    return { ok: true, steps }
  }

  private static phaseOf(value: unknown, phase: DeclaredScriptPhase, file: string): Coerced<DeclaredScript[]> {
    if (value === undefined) return { ok: true, value: [] }
    const where = `scripts.${phase}`
    if (!Array.isArray(value)) return DeclaredScripts.refused(file, `"${where}" must be an array of scripts`)
    if (value.length > DeclaredScripts.perPhaseMaxConst)
      return DeclaredScripts.refused(file, `"${where}" may hold at most ${DeclaredScripts.perPhaseMaxConst} scripts`)
    const scripts: DeclaredScript[] = []
    const names = new Set<string>()
    for (const [index, entry] of value.entries()) {
      const script = DeclaredScripts.entryOf(entry, `${where}[${index}]`, file)
      if (!script.ok) return script
      const name = script.value.name.toLowerCase()
      if (names.has(name))
        return DeclaredScripts.refused(
          file,
          `"${where}" names ${JSON.stringify(script.value.name)} more than once (names are compared ignoring case)`,
        )
      names.add(name)
      scripts.push(script.value)
    }
    return { ok: true, value: scripts }
  }

  private static entryOf(value: unknown, where: string, file: string): Coerced<DeclaredScript> {
    if (!DeclaredScripts.isObject(value))
      return DeclaredScripts.refused(file, `"${where}" must be an object with a "name" and a "command"`)
    const unknownKey = Object.keys(value).find((key) => !DeclaredScripts.entryKeysConst.includes(key))
    if (unknownKey !== undefined)
      return DeclaredScripts.refused(
        file,
        `"${where}" has an unknown key ${JSON.stringify(unknownKey)}; an entry holds "name", "command" and an optional "cwd"`,
      )
    const { name, command, cwd } = value
    if (typeof name !== 'string' || name.length > DeclaredScripts.nameCharactersMaxConst
      || !DeclaredScripts.namePatternConst.test(name))
      return DeclaredScripts.refused(
        file,
        `"${where}.name" must be 1 to ${DeclaredScripts.nameCharactersMaxConst} letters, digits, spaces, ".", "_" or "-", `
          + 'starting with a letter or a digit',
      )
    if (typeof command !== 'string' || command.trim().length === 0)
      return DeclaredScripts.refused(file, `"${where}.command" must be a non-empty command string`)
    if (DeclaredScripts.controlCharactersConst.test(command))
      return DeclaredScripts.refused(file, `"${where}.command" must be one line, without NUL, CR or LF`)
    if (command.length > DeclaredScripts.commandCharactersMaxConst)
      return DeclaredScripts.refused(
        file,
        `"${where}.command" may hold at most ${DeclaredScripts.commandCharactersMaxConst} characters`,
      )
    if (cwd === undefined) return { ok: true, value: { name, command, cwd: '' } }
    if (typeof cwd !== 'string') return DeclaredScripts.refused(file, `"${where}.cwd" must be a directory path`)
    const problem = DeclaredScripts.cwdProblem(cwd)
    if (problem) return DeclaredScripts.refused(file, `"${where}.cwd" ${JSON.stringify(cwd)} ${problem}`)
    const normalized = posix.normalize(cwd).replace(/\/+$/, '')
    return { ok: true, value: { name, command, cwd: normalized === '.' ? '' : normalized } }
  }

  /** The words after the path, or null for a directory inside the project. */
  private static cwdProblem(cwd: string): string | null {
    if (cwd.includes('\\')) return 'must use forward slashes'
    // `C:x` is not absolute to win32, but it is relative to that drive's own directory, never the project.
    if (posix.isAbsolute(cwd) || win32.isAbsolute(cwd) || /^[A-Za-z]:/.test(cwd))
      return 'must be relative to the project, never absolute'
    const normalized = posix.normalize(cwd)
    if (normalized === '..' || normalized.startsWith('../')) return 'climbs out of the project'
    return null
  }

  private static isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  }

  private static refused(file: string, problem: string): { ok: false; problem: string } {
    return { ok: false, problem: `${file}: ${problem}` }
  }
}
