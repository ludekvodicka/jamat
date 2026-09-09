/**
 * Proves the seed `setup:remarkable-sidecar` just produced for THIS platform actually runs: the
 * bundled Node reports the pinned version, the reMarkable CLI entry executes, and the tree the
 * resource manifest recorded is still the tree on disk. Platform-neutral on purpose - it is the
 * only check the macOS and Linux release runners have, where no packaged smoke can run.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

interface SeedManifest {
  schemaVersion: 1
  bundleId: string
  platform: string
  node: { version: string; executable: string }
  cli: { package: string; version: string; entry: string }
  tree: { files: number; sha256: string }
}

class RemarkableSidecarSeedCheck {
  private static readonly repositoryRootConst =
    join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  private static readonly buildOsConst: Readonly<Partial<Record<NodeJS.Platform, string>>> = {
    darwin: 'mac',
    linux: 'linux',
    win32: 'win',
  }

  static run(): number {
    try {
      RemarkableSidecarSeedCheck.verify()
      return 0
    } catch (error) {
      console.error(`[check:remarkable-sidecar-seed] ${
        error instanceof Error ? error.message : String(error)}`)
      return 1
    }
  }

  private static verify(): void {
    const platformId = RemarkableSidecarSeedCheck.platformId()
    const seed = join(
      RemarkableSidecarSeedCheck.repositoryRootConst,
      'out',
      'remarkable-sidecar',
      platformId,
      'current',
    )
    if (!existsSync(seed))
      throw new Error(`no seed at ${seed}; run \`pnpm setup:remarkable-sidecar\` on this machine first`)
    const manifest = RemarkableSidecarSeedCheck.manifest(seed)
    const node = join(seed, ...manifest.node.executable.split('/'))
    const entry = join(seed, ...manifest.cli.entry.split('/'))
    if (!existsSync(node)) throw new Error(`the seed has no Node executable at ${node}`)
    if (!existsSync(entry)) throw new Error(`the seed has no CLI entry at ${entry}`)

    const version = RemarkableSidecarSeedCheck.captured(node, ['--version'], seed).trim()
    if (version !== `v${manifest.node.version}`)
      throw new Error(`the seeded Node reports ${version}, expected v${manifest.node.version}`)

    const help = RemarkableSidecarSeedCheck.captured(node, [entry, '--help'], seed)
    if (help.trim().length === 0)
      throw new Error(`${manifest.cli.package} ${manifest.cli.version} --help produced no output`)

    const tree = RemarkableSidecarSeedCheck.treeOf(seed)
    if (tree.files !== manifest.tree.files || tree.sha256 !== manifest.tree.sha256)
      throw new Error(`seed tree mismatch: the manifest records ${manifest.tree.files}/`
        + `${manifest.tree.sha256}, the directory holds ${tree.files}/${tree.sha256}`)

    console.log(`[check:remarkable-sidecar-seed] ${platformId}: ${manifest.bundleId}`)
    console.log(`[check:remarkable-sidecar-seed] ${version}, ${manifest.cli.package} `
      + `${manifest.cli.version}, ${tree.files} files verified`)
  }

  /** electron-builder's `${os}-${arch}`, the name the seed directories carry. */
  private static platformId(): string {
    const os = RemarkableSidecarSeedCheck.buildOsConst[process.platform]
    if (os === undefined)
      throw new Error(`the reMarkable sidecar has no recipe for ${process.platform}-${process.arch}`)
    return `${os}-${process.arch}`
  }

  private static manifest(seed: string): SeedManifest {
    const value: unknown = JSON.parse(readFileSync(join(seed, 'manifest.json'), 'utf8'))
    const root = RemarkableSidecarSeedCheck.recordOf(value, 'seed manifest')
    const node = RemarkableSidecarSeedCheck.recordOf(root.node, 'seed manifest node')
    const cli = RemarkableSidecarSeedCheck.recordOf(root.cli, 'seed manifest cli')
    const tree = RemarkableSidecarSeedCheck.recordOf(root.tree, 'seed manifest tree')
    if (root.schemaVersion !== 1 || typeof root.bundleId !== 'string'
      || typeof root.platform !== 'string' || typeof node.version !== 'string'
      || typeof node.executable !== 'string' || typeof cli.package !== 'string'
      || typeof cli.version !== 'string' || typeof cli.entry !== 'string'
      || typeof tree.files !== 'number' || !Number.isSafeInteger(tree.files) || tree.files < 1
      || typeof tree.sha256 !== 'string')
      throw new Error('seed manifest fields are invalid')
    if (root.platform !== `${process.platform}-${process.arch}`)
      throw new Error(`the seed was built for ${root.platform}, this machine is `
        + `${process.platform}-${process.arch}`)
    return {
      schemaVersion: 1,
      bundleId: root.bundleId,
      platform: root.platform,
      node: { version: node.version, executable: node.executable },
      cli: { package: cli.package, version: cli.version, entry: cli.entry },
      tree: { files: tree.files, sha256: tree.sha256 },
    }
  }

  /** Empty PATH: the seed must run on a machine that has no Node and no npm of its own. */
  private static captured(command: string, args: readonly string[], cwd: string): string {
    const env: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(process.env)) {
      const normalized = key.toUpperCase()
      if (normalized !== 'PATH' && normalized !== 'NODE_OPTIONS') env[key] = value
    }
    env.PATH = ''
    const result = spawnSync(command, args, {
      cwd,
      encoding: 'utf8',
      env,
      maxBuffer: 2 * 1024 * 1024,
      timeout: 60_000,
      windowsHide: true,
    })
    if (result.error) throw result.error
    if (result.status !== 0)
      throw new Error(`${command} exited with ${result.status}: ${(result.stderr ?? '').trim()}`)
    return `${result.stdout ?? ''}${result.stderr ?? ''}`
  }

  private static treeOf(root: string): { files: number; sha256: string } {
    const entries = RemarkableSidecarSeedCheck.filesUnder(root)
      .map((file) => ({
        path: relative(root, file).split(sep).join('/'),
        sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
      }))
      .filter((entry) => entry.path !== 'manifest.json')
      .sort((left, right) => Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8')))
    const hash = createHash('sha256')
    for (const entry of entries)
      hash.update(entry.path, 'utf8').update('\0').update(entry.sha256, 'ascii').update('\n')
    return { files: entries.length, sha256: hash.digest('hex') }
  }

  private static filesUnder(directory: string): string[] {
    const files: string[] = []
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) files.push(...RemarkableSidecarSeedCheck.filesUnder(path))
      else if (entry.isFile()) files.push(path)
      else throw new Error(`the seed contains an unsupported entry: ${path}`)
    }
    return files
  }

  private static recordOf(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error(`${label} must be an object`)
    return value as Record<string, unknown>
  }
}

process.exitCode = RemarkableSidecarSeedCheck.run()
