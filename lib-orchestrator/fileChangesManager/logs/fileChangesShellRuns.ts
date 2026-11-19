import { relative } from 'node:path'

import { PathCompare } from '../../shared/pathCompare'
import type { FileChangesShellRun } from './fileChangesLogSource.types'

/**
 * Which changed paths a session's own shell commands wrote. A path counts when a command names it
 * and the path was last written while that command ran. Both are needed: the name alone also takes
 * a file the command only read (`svn diff`, `cat`), and the time alone also takes a file another
 * session of the same main copy wrote at that moment. An agent that edits through a script of its
 * own leaves no Edit or Write in its transcript (session 135, 2026-11-18: 11 of its 13 files).
 */
export class FileChangesShellRuns {
  /** Some file systems keep whole seconds, and the transcript times are taken around the run. */
  static readonly slackMillisecondsConst = 2_000

  private readonly runs: readonly { text: string; startedAt: number; endedAt: number }[]

  constructor(runs: readonly FileChangesShellRun[]) {
    this.runs = runs.map((run) => ({ text: FileChangesShellRuns.normalized(run.command), startedAt: run.startedAt, endedAt: run.endedAt }))
  }

  get empty(): boolean {
    return this.runs.length === 0
  }

  /**
   * The runs that name `path`, absolute or relative to one of `bases` (the session directory and
   * the working copy root); a directory also counts when a command names a path inside it.
   */
  named(path: string, bases: readonly string[], directory: boolean): readonly { startedAt: number; endedAt: number }[] {
    const names = FileChangesShellRuns.namesOf(path, bases)
    return this.runs.filter((run) => names.some((name) => FileChangesShellRuns.mentions(run.text, name, directory)))
  }

  /** Whether one of `runs` was running when the path was last written. */
  static ranAt(runs: readonly { startedAt: number; endedAt: number }[], modifiedAt: number): boolean {
    const slack = FileChangesShellRuns.slackMillisecondsConst
    return runs.some((run) => modifiedAt >= run.startedAt - slack && modifiedAt <= run.endedAt + slack)
  }

  /** Lower case with one forward slash for any run of slashes, so `Q:\\a\\b` in a string literal is `q:/a/b`. */
  private static normalized(text: string): string {
    return text.toLowerCase().replace(/[\\/]+/g, '/')
  }

  /** Absolute names (`q:/a/b`, Git Bash `/q/a/b`) and relative ones, which must not follow a `/`. */
  private static namesOf(path: string, bases: readonly string[]): { text: string; relative: boolean }[] {
    const absolute = FileChangesShellRuns.normalized(path)
    const names = [{ text: absolute, relative: false }]
    const drive = /^([a-z]):\//.exec(absolute)
    if (drive !== null) names.push({ text: `/${drive[1]}/${absolute.slice(3)}`, relative: false })
    for (const base of bases)
      if (PathCompare.isInside(base, path) && PathCompare.comparable(base) !== PathCompare.comparable(path))
        names.push({ text: FileChangesShellRuns.normalized(relative(base, path)), relative: true })
    return names
  }

  private static mentions(text: string, name: { text: string; relative: boolean }, directory: boolean): boolean {
    for (let at = text.indexOf(name.text); at !== -1; at = text.indexOf(name.text, at + 1)) {
      const before = at === 0 ? '' : text[at - 1]
      if (/[a-z0-9_.-]/.test(before) || name.relative && before === '/') continue
      const after = text.slice(at + name.text.length, at + name.text.length + 2)
      if (after.startsWith('/')) {
        if (directory) return true
        continue
      }
      if (after === '' || !/^[a-z0-9_-]/.test(after) && !/^\.[a-z0-9]/.test(after)) return true
    }
    return false
  }
}
