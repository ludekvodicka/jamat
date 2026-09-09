/**
 * Packages the Windows client, but only when something it is built FROM has actually moved.
 *
 * A packaged-build launcher calls this before it starts the app, so a double-click runs the current
 * tree without paying for a package run that would produce the same bytes. A launch that changes
 * nothing costs one line and no time.
 *
 * Freshness is an mtime comparison against `resources\app.asar`, which the packer writes itself and
 * which therefore dates the package rather than the directory holding it. Nothing a package run
 * produces is an input, so a run cannot leave itself stale and rebuild forever.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

interface NewestInput {
  path: string
  modifiedAt: number
}

class PackageWhenStale {
  private static readonly repositoryRootConst =
    join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  private static readonly markerConst = join(
    'app-client-ui',
    'dist',
    'win-unpacked',
    'resources',
    'app.asar',
  )
  private static readonly packageCommandConst = 'pnpm package:ui:win:dir'

  /** What electron-vite, the host bundle and the sidecar seed read; nothing else ships. */
  private static readonly inputsConst: readonly string[] = [
    join('app-client-ui', 'app'),
    join('app-client-ui', 'preload'),
    join('app-client-ui', 'renderer'),
    join('app-client-ui', 'shared'),
    join('app-client-ui', 'start.ts'),
    join('app-client-ui', 'package.json'),
    join('app-client-ui', 'electron.vite.config.ts'),
    'app-host',
    'lib-orchestrator',
    join('mdext-renderer', 'renderer'),
    join('configs', 'remarkable-sidecar'),
  ]

  /** Build output, dependency trees and local runtime state. A package run writes into these. */
  private static readonly skippedDirectoriesConst: readonly string[] = [
    '.git',
    '.svn',
    'data',
    'dist',
    'node_modules',
    'out',
  ]

  /**
   * Neither ends up in a bundle: no shipped module imports a test, and markdown beside the code is
   * read by people. Counting them would spend minutes packaging bytes that did not change.
   */
  private static readonly skippedSuffixesConst: readonly string[] = [
    '.test.ts',
    '.test.tsx',
    '.md',
  ]

  static run(): number {
    try {
      return PackageWhenStale.packageIfStale()
    } catch (error) {
      console.error(`[package-when-stale] ${
        error instanceof Error ? error.message : String(error)}`)
      return 1
    }
  }

  private static packageIfStale(): number {
    const newest = PackageWhenStale.newestInput()
    const marker = join(PackageWhenStale.repositoryRootConst, PackageWhenStale.markerConst)
    if (!existsSync(marker)) {
      console.log(`[package-when-stale] nothing packaged yet at ${PackageWhenStale.markerConst}`)
      return PackageWhenStale.build()
    }
    const packagedAt = statSync(marker).mtimeMs
    if (packagedAt >= newest.modifiedAt) {
      console.log(`[package-when-stale] up to date; newest source is ${newest.path}`)
      return 0
    }
    console.log(`[package-when-stale] ${newest.path} is newer than the package`)
    return PackageWhenStale.build()
  }

  private static build(): number {
    console.log(`[package-when-stale] ${PackageWhenStale.packageCommandConst}`)
    // One shell string rather than a command plus arguments: pnpm is a `.cmd` shim on Windows and
    // Node refuses to spawn one directly. Nothing here comes from outside this file.
    const built = spawnSync(PackageWhenStale.packageCommandConst, {
      cwd: PackageWhenStale.repositoryRootConst,
      shell: true,
      stdio: 'inherit',
    })
    if (built.error !== undefined) throw built.error
    if (built.status !== 0)
      throw new Error(`${PackageWhenStale.packageCommandConst} exited with ${String(built.status)}`)
    return 0
  }

  private static newestInput(): NewestInput {
    let newest: NewestInput | null = null
    for (const input of PackageWhenStale.inputsConst) {
      const path = join(PackageWhenStale.repositoryRootConst, input)
      if (!existsSync(path)) throw new Error(`missing build input ${input}`)
      newest = PackageWhenStale.newerOf(newest, PackageWhenStale.newestUnder(path))
    }
    // Every input above exists and none of them is empty, so a null here is this walker skipping
    // everything it found - a silent "nothing changed" that would never package again.
    if (newest === null) throw new Error('no source file was found under the build inputs')
    return newest
  }

  private static newestUnder(path: string): NewestInput | null {
    const stats = statSync(path)
    if (stats.isFile())
      return PackageWhenStale.isSkipped(path)
        ? null
        : {
          path: relative(PackageWhenStale.repositoryRootConst, path),
          modifiedAt: stats.mtimeMs,
        }
    if (!stats.isDirectory()) return null
    let newest: NewestInput | null = null
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isDirectory() && PackageWhenStale.skippedDirectoriesConst.includes(entry.name))
        continue
      newest = PackageWhenStale.newerOf(
        newest,
        PackageWhenStale.newestUnder(join(path, entry.name)),
      )
    }
    return newest
  }

  private static newerOf(left: NewestInput | null, right: NewestInput | null): NewestInput | null {
    if (left === null) return right
    if (right === null) return left
    return right.modifiedAt > left.modifiedAt ? right : left
  }

  private static isSkipped(path: string): boolean {
    return PackageWhenStale.skippedSuffixesConst.some((suffix) => path.endsWith(suffix))
  }
}

process.exitCode = PackageWhenStale.run()
