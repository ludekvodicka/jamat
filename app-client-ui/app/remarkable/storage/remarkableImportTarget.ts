import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { PathCompare } from '../../../../lib-orchestrator/shared/pathCompare'
import type { SessionWorkingContextResult } from '../../../../lib-orchestrator/sessionManager/sessionManager'
import type { RemarkableResult } from '../../../shared/remarkableApi.types'
import type { RemarkableStorageSettingsValue } from '../../../shared/remarkableStorageSettings'

export type RemarkableImportDestination =
  | { kind: 'global' }
  | { kind: 'project'; root: string; directory: string }

export interface RemarkableImportResolution {
  destination: RemarkableImportDestination
  /** Why the configured destination is not the one being used, or null when it is. */
  note: string | null
}

export interface RemarkableImportPlacement {
  /** The file that exists on disk. */
  outputPath: string
  /** What the terminal receives: relative to the session directory when there is one. */
  insertText: string
}

/**
 * Where a finished page belongs, and putting it there.
 *
 * The renderer never names a path. It names a SESSION, the working directory of that session is
 * asked of the session manager, and the relative folder comes from settings that refuse anything
 * that could leave it. So the two halves of a destination come from two places the window cannot
 * reach, and neither of them alone points anywhere.
 */
export class RemarkableImportTarget {
  private static readonly collisionAttemptsConst = 20

  /**
   * Resolved once per operation rather than per page: a session that ends between the download and
   * the import must not move the file, and a fallback the user was told about must not silently
   * become something else on the next page.
   */
  static async resolve(
    storage: RemarkableStorageSettingsValue,
    workingContext: SessionWorkingContextResult,
  ): Promise<RemarkableImportResolution> {
    if (storage.scope === 'global') return { destination: { kind: 'global' }, note: null }
    else if (storage.scope !== 'project') {
      const unhandled: never = storage.scope
      throw new Error(`Unknown reMarkable storage scope: ${JSON.stringify(unhandled)}`)
    }
    if (!workingContext.ok)
      return RemarkableImportTarget.fallback('this terminal has no session the app still knows')
    const root = workingContext.value.cwd
    if (!root || !isAbsolute(root))
      return RemarkableImportTarget.fallback('this terminal has no project directory')
    const resolvedRoot = resolve(root)
    const directory = resolve(join(resolvedRoot, storage.projectDirectory))
    // The settings refuse every fragment that could escape; this proves the join actually stayed in.
    if (!PathCompare.isInside(resolvedRoot, directory) || directory === resolvedRoot)
      return RemarkableImportTarget.fallback('the configured folder is not inside the project')
    return { destination: { kind: 'project', root: resolvedRoot, directory }, note: null }
  }

  /**
   * Takes the file `RemarkableRunStore` has already verified and puts it where the destination says.
   *
   * A project usually sits on a different volume from the machine-local runs, where `rename` fails
   * with EXDEV, so this copies and checks the copy rather than moving and checking the inode. The
   * caller drops the machine-local original afterwards, so one page still means one file.
   */
  static async place(
    promotedPath: string,
    destination: RemarkableImportDestination,
  ): Promise<RemarkableResult<RemarkableImportPlacement>> {
    if (destination.kind === 'global')
      return { ok: true, value: { outputPath: promotedPath, insertText: promotedPath } }
    else if (destination.kind !== 'project') {
      const unhandled: never = destination
      throw new Error(`Unknown reMarkable import destination: ${JSON.stringify(unhandled)}`)
    }
    try {
      const source = await lstat(promotedPath)
      if (!source.isFile() || source.isSymbolicLink() || source.size <= 0)
        return RemarkableImportTarget.failure('The imported reMarkable page could not be read')
      const resolvedDirectory = await RemarkableImportTarget.prepareDirectory(destination)
      if (resolvedDirectory === null)
        return RemarkableImportTarget.failure(
          `The reMarkable folder ${destination.directory} could not be used`,
        )
      const copied = await RemarkableImportTarget.copyInto(resolvedDirectory, promotedPath, source.size)
      if (copied === null)
        return RemarkableImportTarget.failure(
          `The reMarkable page could not be written into ${destination.directory}`,
        )
      return {
        ok: true,
        value: {
          outputPath: join(destination.directory, basename(copied)),
          insertText: relative(destination.root, join(destination.directory, basename(copied))),
        },
      }
    } catch {
      return RemarkableImportTarget.failure(
        `The reMarkable page could not be written into ${destination.directory}`,
      )
    }
  }

  /**
   * Creates the folder and answers its real path, or null when something that is not a plain
   * directory of this project stands where it should be. A symlink is refused rather than followed:
   * it is the one way a folder inside the project can write outside it.
   */
  private static async prepareDirectory(
    destination: { root: string; directory: string },
  ): Promise<string | null> {
    await mkdir(destination.directory, { recursive: true })
    const info = await lstat(destination.directory)
    if (!info.isDirectory() || info.isSymbolicLink()) return null
    const resolvedDirectory = await realpath(destination.directory)
    const resolvedRoot = await realpath(destination.root)
    return PathCompare.isInside(resolvedRoot, resolvedDirectory) ? resolvedDirectory : null
  }

  private static async copyInto(
    directory: string,
    source: string,
    bytes: number,
  ): Promise<string | null> {
    const stamp = RemarkableImportTarget.stamp(new Date())
    for (let attempt = 1; attempt <= RemarkableImportTarget.collisionAttemptsConst; attempt += 1) {
      const name = attempt === 1
        ? `remarkable-${stamp}.png`
        : `remarkable-${stamp}-${attempt}.png`
      const target = join(directory, name)
      try {
        // EXCL rather than a prior existence check: two imports in the same second would both pass
        // the check and the second would overwrite the first.
        await copyFile(source, target, constants.COPYFILE_EXCL)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw error
      }
      const written = await lstat(target)
      const resolvedTarget = await realpath(target)
      if (!written.isFile()
        || written.isSymbolicLink()
        || written.size !== bytes
        || dirname(resolvedTarget) !== directory)
        return null
      return target
    }
    return null
  }

  /** Local time, because the name is read by a person looking at their own project. */
  private static stamp(now: Date): string {
    const pad = (value: number): string => String(value).padStart(2, '0')
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
      + `_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
  }

  private static fallback(reason: string): RemarkableImportResolution {
    return {
      destination: { kind: 'global' },
      note: `Saved outside the project, because ${reason}.`,
    }
  }

  private static failure(detail: string): RemarkableResult<never> {
    return { ok: false, code: 'import-failed', detail, retryable: false }
  }
}
