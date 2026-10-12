import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

interface ExtraResource {
  from: string
  to: string
  filter: string[]
}

/**
 * electron-builder skips an `extraResources` source that does not exist without failing, so a
 * package built without one of the `release:*` steps still looks finished. The 3.9.0 and 3.10.0
 * releases shipped without `codex/` and `cli/` that way: Codex sessions and every Jamat CLI run
 * failed on the installed client only. This gate fails the build instead. It reads the sources
 * from `app-client-ui/package.json`, so a new `extraResources` entry is checked without an edit
 * here; `keyFilesOf` adds the files inside them that the installed client starts.
 */
class PackagedResources {
  private static readonly uiRootConst = resolve(import.meta.dirname, '..', '..', 'app-client-ui')
  private static readonly distRootConst = join(PackagedResources.uiRootConst, 'dist')
  /** electron-builder's `${os}` per Node platform; each build machine packages only its own. */
  private static readonly buildOsConst: Readonly<Partial<Record<NodeJS.Platform, string>>> = {
    darwin: 'mac',
    linux: 'linux',
    win32: 'win',
  }

  static resourcesDirectories(): string[] {
    const found: string[] = []
    for (const name of readdirSync(PackagedResources.distRootConst, { withFileTypes: true })) {
      if (!name.isDirectory()) continue
      const unpacked = join(PackagedResources.distRootConst, name.name)
      const app = readdirSync(unpacked).find(entry => entry.endsWith('.app'))
      const resources = app ? join(unpacked, app, 'Contents', 'Resources') : join(unpacked, 'resources')
      if (existsSync(join(resources, 'app.asar'))) found.push(resources)
    }
    return found
  }

  static extraResources(): ExtraResource[] {
    const build = JSON.parse(readFileSync(join(PackagedResources.uiRootConst, 'package.json'), 'utf8')).build
    const platformKey = PackagedResources.buildOs()
    return [...(build.extraResources ?? []), ...(build[platformKey]?.extraResources ?? [])]
  }

  /** Every source must exist with content, and each of its top-level entries must sit under `to`. */
  static missing(resources: string, entries: ExtraResource[]): string[] {
    const problems: string[] = []
    for (const entry of entries) {
      if (entry.filter.length !== 1 || entry.filter[0] !== '**/*')
        throw new Error(`extraResources ${entry.from} has filter ${entry.filter.join(', ')}; this check knows only **/*`)
      const source = PackagedResources.sourceOf(entry.from)
      if (!existsSync(source) || readdirSync(source).length === 0) {
        problems.push(`source ${entry.from} (run pnpm release:resources)`)
        continue
      }
      for (const child of readdirSync(source))
        if (!existsSync(join(resources, entry.to, child))) problems.push(join(entry.to, child))
    }
    for (const file of PackagedResources.keyFilesOf())
      if (!existsSync(join(resources, file))) problems.push(file)
    return [...new Set(problems)]
  }

  private static keyFilesOf(): string[] {
    const node = process.platform === 'win32' ? 'node.exe' : join('bin', 'node')
    return [
      join('host', 'start.cjs'), join('host', 'node_modules', 'node-pty'), join('host', 'manifest.json'),
      join('codex', 'start.cjs'), join('cli', 'jamat-v3.cjs'), join('launcher', node),
      join('launcher', 'launcher.cjs'), join('skills', 'claude'), join('skills', 'codex'),
      join('mdext-renderer', 'USAGE.md'), join('remarkable-sidecar', 'manifest.json'),
    ]
  }

  private static sourceOf(from: string): string {
    const expanded = from.replaceAll('${os}', PackagedResources.buildOs()).replaceAll('${arch}', process.arch)
    if (expanded.includes('${'))
      throw new Error(`extraResources ${from} uses a macro this check does not expand`)
    return resolve(PackagedResources.uiRootConst, expanded)
  }

  private static buildOs(): string {
    const os = PackagedResources.buildOsConst[process.platform]
    if (os === undefined) throw new Error(`no electron-builder platform for ${process.platform}`)
    return os
  }
}

const directories = PackagedResources.resourcesDirectories()
if (directories.length === 0) {
  console.error(`[check:packaged-resources] no packaged resources directory under app-client-ui/dist`)
  process.exitCode = 1
}
const entries = PackagedResources.extraResources()
for (const resources of directories) {
  const missing = PackagedResources.missing(resources, entries)
  if (missing.length === 0) console.log(`[check:packaged-resources] ${resources}: complete (${entries.length} extraResources)`)
  else {
    console.error(`[check:packaged-resources] ${resources} is missing: ${missing.join(', ')}`)
    process.exitCode = 1
  }
}
