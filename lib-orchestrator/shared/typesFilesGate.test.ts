import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * A `*.types.ts` erases. That is the one thing its suffix tells a reader, and it is what lets the
 * renderer import a subsystem's wire types without pulling the subsystem in behind them.
 *
 * Two of them stopped erasing: `remoteControlApi.types.ts` and `remoteControlPeerApi.types.ts` each
 * grew a `*Const` class, so seventeen files were importing the protocol name, the operation lists,
 * the error codes and the wire limits out of a module whose name says it carries no runtime. The
 * classes live in `remoteControlProtocol.ts` and `remoteControlPeerProtocol.ts` now, and this is
 * what keeps them there.
 *
 * The repository, not this package: the rule is the tree's, and three packages write these files.
 */
describe('lib-orchestrator/shared/typesFilesGate', () => {
  const repositoryRootConst = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const packagesConst = ['app-host', 'app-client-ui', 'app-client-cli', 'lib-orchestrator', 'scripts']
  const runtimeExportConst = /^export\s+(class|const|let|var|function|enum)\b/m

  function typesFilesIn(directory: string): string[] {
    const found: string[] = []
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) found.push(...typesFilesIn(path))
      else if (entry.name.endsWith('.types.ts')) found.push(path)
    }
    return found
  }

  it('has a types file to check, in more than one package', () => {
    const packages = packagesConst.filter((name) =>
      typesFilesIn(join(repositoryRootConst, name)).length > 0)

    // Without this the walk could silently find nothing and the gate below would pass over an empty
    // set, which is exactly how a package-resolution check went green while checking nothing.
    expect(packages.length).toBeGreaterThan(1)
  })

  it('holds no runtime export in any *.types.ts', () => {
    const offenders: string[] = []
    for (const name of packagesConst)
      for (const file of typesFilesIn(join(repositoryRootConst, name))) {
        const source = readFileSync(file, 'utf8')
        if (runtimeExportConst.test(source))
          offenders.push(relative(repositoryRootConst, file).replaceAll('\\', '/'))
      }

    expect(offenders).toEqual([])
  })
})
