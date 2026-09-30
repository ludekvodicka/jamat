import { posix, win32 } from 'node:path'

import type { RuntimeCategory } from '../catalog/catalog.types'
import { ProjectContainers } from '../catalog/projectContainers'

export type ProjectNameCheck = { ok: true } | { ok: false; detail: string }

/**
 * What may be created, renamed to, or moved to under a category root. Every path this library builds
 * from a project name is `join(category.path, name)`, so the name is the only thing standing between
 * a caller and a write outside the category; V1 validated the menu path and left the CLI path open.
 */
export class ProjectNameRules {
  private static readonly reservedNamesConst: ReadonlySet<string> = new Set([
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
  ])
  // `C:name` is drive-relative, not absolute, so `isAbsolute` misses it while the OS still resolves
  // it against that drive's current directory.
  private static readonly driveLetterPatternConst = /^[A-Za-z]:/
  private static readonly containerSeparatorConst = '/'

  /**
   * A `/` names a project inside a container, and only there: the directory before it has to be one
   * of the category's subfolders, so a name cannot invent a level the scanner would never list.
   */
  static validate(name: string, category: RuntimeCategory): ProjectNameCheck {
    if (name.trim().length === 0)
      return { ok: false, detail: 'a project name cannot be empty' }
    if (ProjectNameRules.driveLetterPatternConst.test(name)
      || win32.isAbsolute(name) || posix.isAbsolute(name))
      return { ok: false, detail: `"${name}" is a path, not a name under the category root` }
    if (name.includes('\\'))
      return { ok: false, detail: `"${name}" contains a path separator` }
    const segments = name.split(ProjectNameRules.containerSeparatorConst)
    for (const segment of segments) {
      const problem = ProjectNameRules.segmentProblem(segment)
      if (problem) return { ok: false, detail: problem }
    }
    for (let length = 1; length < segments.length; length += 1) {
      const container = segments.slice(0, length)
      if (!ProjectContainers.isContainer(category, container))
        return {
          ok: false,
          detail: `"${container.join('/')}" is not a subfolder of category ${category.id}, `
            + `so "${name}" cannot contain "/"`,
        }
      if (ProjectContainers.isOwnedBy(segments[length]))
        return {
          ok: false,
          detail: `"${segments.slice(0, length + 1).join('/')}" belongs to its container and is not a project`,
        }
    }
    return { ok: true }
  }

  /**
   * A name carrying the separator names a project INSIDE a container - the one shape `validate`
   * accepts a `/` for. Such a project has no name of its own in the category root, so nothing
   * computed from the root's grouping can be spelled for it.
   */
  static isContainerChild(name: string): boolean {
    return name.includes(ProjectNameRules.containerSeparatorConst)
  }

  private static segmentProblem(segment: string): string | null {
    if (segment.length === 0) return 'a project name cannot contain an empty path segment'
    if (segment === '.' || segment === '..')
      return `"${segment}" walks the directory tree instead of naming a project`
    if (segment.endsWith('.') || segment.endsWith(' '))
      return `"${segment}" ends with a dot or a space, which Windows drops when it creates the directory`
    if (ProjectNameRules.reservedNamesConst.has(ProjectNameRules.deviceNameOf(segment)))
      return `"${segment}" is a reserved Windows device name`
    return null
  }

  /** `CON.txt` is the console device too, so the extension comes off before the lookup. */
  private static deviceNameOf(segment: string): string {
    return segment.split('.')[0].toUpperCase()
  }
}
