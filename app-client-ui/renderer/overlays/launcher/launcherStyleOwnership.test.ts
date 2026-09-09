import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const hereConst = dirname(fileURLToPath(import.meta.url))

/** Which directory owns a `jamat-launcher-<name>__*` prefix. `manage` is the projects screen's strip. */
const ownersConst: Readonly<Record<string, string>> = {
  computers: 'computers',
  create: 'create',
  flows: 'flows',
  projects: 'projects',
  manage: 'projects',
}

class LauncherStyles {
  /** Every `jamat-launcher…__thing` this file names, whether it draws it or styles it. */
  static classesIn(path: string): Set<string> {
    return new Set(readFileSync(path, 'utf8').match(/jamat-launcher[a-z-]*__[a-z-]+/g) ?? [])
  }

  static sourcesOf(directory: string): string[] {
    return readdirSync(join(hereConst, directory), { withFileTypes: true })
      .filter((entry) => entry.isFile()
        && (entry.name.endsWith('.tsx') || entry.name.endsWith('.css'))
        && !entry.name.endsWith('.test.tsx'))
      .map((entry) => join(hereConst, directory, entry.name))
  }

  /** The owning directory of a class name, or null for one the overlay itself owns. */
  static ownerOf(className: string): string | null {
    const named = /^jamat-launcher-([a-z]+)__/.exec(className)
    if (named === null) return null
    const owner = ownersConst[named[1]]
    if (owner === undefined)
      throw new Error(`No directory owns the prefix in ${className}`)
    return owner
  }
}

describe('app-client-ui/renderer/overlays/launcher/style ownership', () => {
  /**
   * "Each screen carries its own stylesheet, so deleting a screen deletes its style with it" is what
   * the architecture document says, and it was only true of whichever screen happened to define a
   * class first: the removed history screen was drawn by nine of the projects screen's classes and
   * the flow screen by four of the create screen's. Deleting either owner would have silently
   * restyled a screen that has nothing to do with it.
   *
   * Anything two screens need lives in `launcher.css` under `jamat-launcher__*`. This is what stops
   * the borrowing from coming back the next time a screen needs a note or an error line.
   */
  for (const directory of ['computers', 'create', 'flows', 'projects'])
    it(`draws ${directory}/ with its own classes and the overlay's, and no other screen's`, () => {
      const borrowed: string[] = []
      for (const path of LauncherStyles.sourcesOf(directory))
        for (const className of LauncherStyles.classesIn(path)) {
          const owner = LauncherStyles.ownerOf(className)
          if (owner !== null && owner !== directory)
            borrowed.push(`${directory}/ borrows ${className} from ${owner}/`)
        }

      expect(borrowed).toEqual([])
    })

  // The other half of the same rule. `launcher.css` holds the overlay's own frame - the card, the
  // head, the footer - and everything MORE THAN ONE screen draws. A class there that only one screen
  // draws is neither, and belongs back in that screen's own sheet.
  it('gives every class in launcher.css the overlay itself, or two screens', () => {
    const shared = [...LauncherStyles.classesIn(join(hereConst, 'launcher.css'))]
      .filter((className) => LauncherStyles.ownerOf(className) === null)
    const readers = new Map<string, Set<string>>(shared.map((one) => [one, new Set()]))
    for (const directory of ['computers', 'create', 'flows', 'projects'])
      for (const path of LauncherStyles.sourcesOf(directory))
        for (const className of LauncherStyles.classesIn(path))
          readers.get(className)?.add(directory)
    const own = new Set<string>()
    for (const path of LauncherStyles.sourcesOf('.'))
      if (!path.endsWith('.css'))
        for (const className of LauncherStyles.classesIn(path)) own.add(className)

    // A modifier rides with its base: `--claude` is shared exactly when `__agent` is, and a screen
    // that builds one from a template literal never spells the whole name anywhere for this to find.
    const baseOf = (className: string): string => className.split('--')[0]
    const lonely = [...readers]
      .filter(([className, where]) =>
        !own.has(className)
        && where.size < 2
        && (baseOf(className) === className || (readers.get(baseOf(className))?.size ?? 0) < 2))
      .map(([className, where]) => `${className}: ${[...where].join(', ') || 'nobody'}`)

    expect(lonely).toEqual([])
  })
})
