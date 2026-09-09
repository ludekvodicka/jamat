import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ErrorText } from '../../shared/errorText'
import type { SetupDetection, SetupDetector } from '../projectSetup.types'
import { SetupPaths } from '../setupPaths'

/**
 * python: a lockfile or a `[tool.*]` section names the installer, and both naming one each is a
 * refusal rather than a preference - a project half migrated from poetry to uv installs into two
 * different environments depending on which one was picked.
 *
 * The header scan is a line scan, deliberately: reading `pyproject.toml` for two section names does
 * not justify a TOML parser in a library every client links against, and a subsection such as
 * `[tool.uv.sources]` counts for its parent because that is what it configures.
 */
export class PythonSetupDetector implements SetupDetector {
  readonly familyId = 'python' as const

  private static readonly projectFileConst = 'pyproject.toml'
  private static readonly uvLockFileConst = 'uv.lock'
  private static readonly poetryLockFileConst = 'poetry.lock'
  private static readonly toolHeaderConst = /^\[tool\.(uv|poetry)[\].]/

  async detect(projectRoot: string): Promise<SetupDetection | null> {
    const projectFile = join(projectRoot, PythonSetupDetector.projectFileConst)
    const headers = await PythonSetupDetector.toolHeadersOf(projectFile)
    // A project file that is there but unreadable is not "no python project here": saying so would
    // send the resolution off to another family while every installer would have failed on it too.
    if (!headers.ok)
      return {
        kind: 'ambiguous',
        reason: `${projectFile} could not be read (${headers.problem});`
          + ' repair it or add a .worktree.json with a "setup" array',
      }
    const uv = headers.tools.has('uv')
      || await SetupPaths.isFile(join(projectRoot, PythonSetupDetector.uvLockFileConst))
    const poetry = headers.tools.has('poetry')
      || await SetupPaths.isFile(join(projectRoot, PythonSetupDetector.poetryLockFileConst))
    if (uv && poetry)
      return {
        kind: 'ambiguous',
        reason: 'both uv and poetry are declared here; leave one of them'
          + ' or add a .worktree.json with a "setup" array',
      }
    if (uv) return { kind: 'tool', toolId: 'python-uv' }
    if (poetry) return { kind: 'tool', toolId: 'python-poetry' }
    return null
  }

  /** An absent file is an absence and answers with no headers; every other failure is a refusal. */
  private static async toolHeadersOf(
    file: string,
  ): Promise<{ ok: true; tools: Set<string> } | { ok: false; problem: string }> {
    let raw: string
    try { raw = await readFile(file, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, tools: new Set() }
      return { ok: false, problem: ErrorText.of(error) }
    }
    const tools = new Set<string>()
    for (const line of raw.split(/\r?\n/)) {
      const match = PythonSetupDetector.toolHeaderConst.exec(line.trim())
      if (match) tools.add(match[1])
    }
    return { ok: true, tools }
  }
}
