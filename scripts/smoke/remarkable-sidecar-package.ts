import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { SmokeHarness, SmokeRun } from './smokeHarness.js'

interface ResourceFile {
  role: string
  path: string
  sha256: string
}

interface ResourceManifest {
  schemaVersion: 1
  bundleId: string
  platform: 'win32-x64'
  node: { version: string; executable: string; archiveSha256: string }
  cli: { package: string; version: string; entry: string }
  recipe: { packageLockSha256: string }
  tree: { files: number; sha256: string }
  files: readonly ResourceFile[]
}

interface SidecarRecipe {
  schemaVersion: 2
  /** electron-builder's `${os}-${arch}`: the recipe key and the seed directory name. */
  platformId: 'win-x64'
  /** `${process.platform}-${process.arch}`: what the resource manifest records. */
  runtimePlatform: 'win32-x64'
  node: { version: string; archive: string; sha256: string }
  cli: { package: string; version: string }
}

class RemarkableSidecarPackageSmoke extends SmokeHarness {
  private static readonly repoRootConst = resolve(import.meta.dirname, '..', '..')
  private static readonly packageRootConst = join(
    RemarkableSidecarPackageSmoke.repoRootConst,
    'app-client-ui',
    'dist',
    'win-unpacked',
  )
  private static readonly resourceRootConst = join(
    RemarkableSidecarPackageSmoke.packageRootConst,
    'resources',
    'remarkable-sidecar',
  )
  private static readonly packagedExecutableConst = join(
    RemarkableSidecarPackageSmoke.packageRootConst,
    'Jamat.exe',
  )
  private static readonly resvgBindingConst = join(
    RemarkableSidecarPackageSmoke.packageRootConst,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    '@resvg',
    'resvg-js-win32-x64-msvc',
    'resvgjs.win32-x64-msvc.node',
  )
  private static readonly mediaFileNameConst = 'protocol-range.gif'
  private static readonly mediaBytesConst = Uint8Array.from([
    71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 0, 0, 0,
    255, 255, 255, 33, 249, 4, 1, 0, 0, 0, 0, 44, 0, 0, 0, 0,
    1, 0, 1, 0, 0, 2, 2, 68, 1, 0, 59,
  ])
  private static readonly recipeRootConst = join(
    RemarkableSidecarPackageSmoke.repoRootConst,
    'configs',
    'remarkable-sidecar',
  )
  private static readonly recipeManifestFileConst = join(
    RemarkableSidecarPackageSmoke.recipeRootConst,
    'manifest.json',
  )
  private static readonly recipePackageLockFileConst = join(
    RemarkableSidecarPackageSmoke.recipeRootConst,
    'package-lock.json',
  )

  static run(): void {
    if (process.platform !== 'win32' || process.arch !== 'x64')
      throw new Error(`package smoke supports only win32-x64, received ${process.platform}-${process.arch}`)
    const smoke = new RemarkableSidecarPackageSmoke()
    smoke.verify()
    console.log(`[smoke:remarkable-sidecar-package] OK (${smoke.passed} checks)`)
  }

  private verify(): void {
    this.check('win-unpacked exists', existsSync(RemarkableSidecarPackageSmoke.packageRootConst))
    this.check(
      'sidecar is an extra resource outside app.asar',
      existsSync(join(RemarkableSidecarPackageSmoke.packageRootConst, 'resources', 'app.asar'))
        && existsSync(RemarkableSidecarPackageSmoke.resourceRootConst),
    )
    const recipe = RemarkableSidecarPackageSmoke.recipe()
    const packageLockSha256 = RemarkableSidecarPackageSmoke.hashOf(
      RemarkableSidecarPackageSmoke.recipePackageLockFileConst,
    )
    const manifest = RemarkableSidecarPackageSmoke.manifest()
    this.check('resource manifest uses schema 1', manifest.schemaVersion === 1)
    this.check('resource manifest targets win32-x64', manifest.platform === 'win32-x64')
    this.check('resource manifest pins Node 22.23.2', manifest.node.version === '22.23.2')
    this.check(
      'resource manifest pins remarkable-cli 0.3.0',
      manifest.cli.package === 'remarkable-cli' && manifest.cli.version === '0.3.0',
    )
    this.check('resource manifest has a bundle ID', manifest.bundleId.length > 0)
    this.check(
      'resource identity matches the committed recipe',
      manifest.platform === recipe.runtimePlatform
        && manifest.node.version === recipe.node.version
        && manifest.node.archiveSha256 === recipe.node.sha256
        && manifest.cli.package === recipe.cli.package
        && manifest.cli.version === recipe.cli.version,
    )
    this.check(
      'resource recipe hash matches the committed package lock',
      manifest.recipe.packageLockSha256 === packageLockSha256,
    )
    this.check('resource manifest records critical files', manifest.files.length >= 7)
    this.check(
      'resource manifest records native modules',
      manifest.files.filter((file) => file.role === 'native-module').length >= 2,
    )
    for (const file of manifest.files) {
      const path = RemarkableSidecarPackageSmoke.resourcePath(file.path)
      this.check(`critical file exists: ${file.path}`, existsSync(path))
      this.check(
        `critical file hash matches: ${file.path}`,
        RemarkableSidecarPackageSmoke.hashOf(path) === file.sha256,
      )
    }
    const tree = RemarkableSidecarPackageSmoke.treeOf(
      RemarkableSidecarPackageSmoke.resourceRootConst,
    )
    this.check('resource tree file count matches', manifest.tree.files === tree.files)
    this.check('resource tree hash matches every packaged runtime file', manifest.tree.sha256 === tree.sha256)
    this.check(
      'bundle ID matches the committed recipe, lock and packaged tree',
      manifest.bundleId === RemarkableSidecarPackageSmoke.bundleIdOf(
        recipe,
        packageLockSha256,
        tree,
        manifest.files,
      ),
    )
    const node = RemarkableSidecarPackageSmoke.resourcePath(manifest.node.executable)
    const cli = RemarkableSidecarPackageSmoke.resourcePath(manifest.cli.entry)
    const version = RemarkableSidecarPackageSmoke.runCaptured(node, ['--version']).trim()
    this.check('bundled Node runs with an empty PATH', version === `v${manifest.node.version}`)
    const help = RemarkableSidecarPackageSmoke.runCaptured(node, [cli, '--help'])
    this.check('bundled remarkable CLI help runs with an empty PATH', help.trim().length > 0)
    const sqlite = RemarkableSidecarPackageSmoke.sqliteProbe(node)
    this.check('bundled better-sqlite3 executes a query with an empty PATH', sqlite === '1')
    const sharpBytes = RemarkableSidecarPackageSmoke.sharpProbe(node)
    this.check(
      'bundled sharp renders a PNG with an empty PATH',
      Number.isSafeInteger(sharpBytes) && sharpBytes >= 8,
    )
    console.log(`[smoke:remarkable-sidecar-package] native probes: sqlite=${sqlite}, sharp=${sharpBytes} bytes`)
    this.check('packaged application contains the Windows resvg binding',
      existsSync(RemarkableSidecarPackageSmoke.resvgBindingConst))
    const applicationOutput = RemarkableSidecarPackageSmoke.packagedApplicationProbe()
    this.check('packaged application reaches the renderer smoke handshake',
      applicationOutput.includes('SMOKE OK'))
    console.log('[smoke:remarkable-sidecar-package] packaged application reached SMOKE OK')
    const resourceSize = RemarkableSidecarPackageSmoke.sizeOf(
      RemarkableSidecarPackageSmoke.resourceRootConst,
    )
    const packageSize = RemarkableSidecarPackageSmoke.sizeOf(
      RemarkableSidecarPackageSmoke.packageRootConst,
    )
    console.log(`[smoke:remarkable-sidecar-package] resource: ${resourceSize.files} files, ${resourceSize.bytes} bytes`)
    console.log(`[smoke:remarkable-sidecar-package] package: ${packageSize.files} files, ${packageSize.bytes} bytes`)
  }

  private static manifest(): ResourceManifest {
    const value: unknown = JSON.parse(readFileSync(
      join(RemarkableSidecarPackageSmoke.resourceRootConst, 'manifest.json'),
      'utf8',
    ))
    const root = RemarkableSidecarPackageSmoke.recordOf(value, 'resource manifest')
    const node = RemarkableSidecarPackageSmoke.recordOf(root.node, 'resource manifest node')
    const cli = RemarkableSidecarPackageSmoke.recordOf(root.cli, 'resource manifest cli')
    const recipe = RemarkableSidecarPackageSmoke.recordOf(root.recipe, 'resource manifest recipe')
    const tree = RemarkableSidecarPackageSmoke.recordOf(root.tree, 'resource manifest tree')
    if (!Array.isArray(root.files)) throw new Error('resource manifest files must be an array')
    const files = root.files.map((value, index) => {
      const file = RemarkableSidecarPackageSmoke.recordOf(value, `resource manifest file ${index}`)
      if (typeof file.role !== 'string' || typeof file.path !== 'string'
        || !RemarkableSidecarPackageSmoke.isSha256(file.sha256))
        throw new Error(`resource manifest file ${index} is invalid`)
      return { role: file.role, path: file.path, sha256: file.sha256 }
    })
    if (root.schemaVersion !== 1 || typeof root.bundleId !== 'string'
      || root.platform !== 'win32-x64' || typeof node.version !== 'string'
      || typeof node.executable !== 'string' || !RemarkableSidecarPackageSmoke.isSha256(node.archiveSha256)
      || typeof cli.package !== 'string' || typeof cli.version !== 'string'
      || typeof cli.entry !== 'string' || !RemarkableSidecarPackageSmoke.isSha256(recipe.packageLockSha256)
      || typeof tree.files !== 'number' || !Number.isSafeInteger(tree.files) || tree.files < 1
      || !RemarkableSidecarPackageSmoke.isSha256(tree.sha256))
      throw new Error('resource manifest fields are invalid')
    return {
      schemaVersion: 1,
      bundleId: root.bundleId,
      platform: 'win32-x64',
      node: {
        version: node.version,
        executable: node.executable,
        archiveSha256: node.archiveSha256,
      },
      cli: { package: cli.package, version: cli.version, entry: cli.entry },
      recipe: { packageLockSha256: recipe.packageLockSha256 },
      tree: { files: tree.files, sha256: tree.sha256 },
      files,
    }
  }

  private static recipe(): SidecarRecipe {
    const value: unknown = JSON.parse(readFileSync(
      RemarkableSidecarPackageSmoke.recipeManifestFileConst,
      'utf8',
    ))
    const root = RemarkableSidecarPackageSmoke.recordOf(value, 'committed sidecar recipe')
    const cli = RemarkableSidecarPackageSmoke.recordOf(root.cli, 'committed sidecar recipe cli')
    const platforms = RemarkableSidecarPackageSmoke.recordOf(
      root.platforms,
      'committed sidecar recipe platforms',
    )
    const platform = RemarkableSidecarPackageSmoke.recordOf(
      platforms['win-x64'],
      'committed sidecar recipe win-x64',
    )
    const node = RemarkableSidecarPackageSmoke.recordOf(
      platform.node,
      'committed sidecar recipe win-x64 node',
    )
    if (root.schemaVersion !== 2
      || typeof node.version !== 'string' || typeof node.archive !== 'string'
      || !RemarkableSidecarPackageSmoke.isSha256(node.sha256)
      || typeof cli.package !== 'string' || typeof cli.version !== 'string')
      throw new Error('committed sidecar recipe fields are invalid')
    return {
      schemaVersion: 2,
      platformId: 'win-x64',
      runtimePlatform: 'win32-x64',
      node: { version: node.version, archive: node.archive, sha256: node.sha256 },
      cli: { package: cli.package, version: cli.version },
    }
  }

  private static bundleIdOf(
    recipe: SidecarRecipe,
    packageLockSha256: string,
    tree: ResourceManifest['tree'],
    files: readonly ResourceFile[],
  ): string {
    const hash = RemarkableSidecarPackageSmoke.hashText(JSON.stringify({
      schemaVersion: 1,
      platform: recipe.runtimePlatform,
      nodeVersion: recipe.node.version,
      nodeArchiveSha256: recipe.node.sha256,
      cliPackage: recipe.cli.package,
      cliVersion: recipe.cli.version,
      packageLockSha256,
      tree,
      files,
    }))
    return `${recipe.runtimePlatform}-node-${recipe.node.version}-${recipe.cli.package}-${recipe.cli.version}-${hash.slice(0, 16)}`
  }

  private static runCaptured(command: string, args: readonly string[]): string {
    const result = spawnSync(command, args, {
      cwd: RemarkableSidecarPackageSmoke.resourceRootConst,
      encoding: 'utf8',
      env: RemarkableSidecarPackageSmoke.cleanRuntimeEnvironment(),
      maxBuffer: 2 * 1024 * 1024,
      timeout: 30_000,
      windowsHide: true,
    })
    if (result.error) throw result.error
    if (result.status !== 0)
      throw new Error(`${command} exited with ${result.status}: ${(result.stderr ?? '').trim()}`)
    return `${result.stdout ?? ''}${result.stderr ?? ''}`
  }

  private static sqliteProbe(node: string): string {
    return RemarkableSidecarPackageSmoke.runCaptured(node, [
      '--input-type=module',
      '--eval',
      "import Database from 'better-sqlite3'; const db = new Database(':memory:'); "
        + "const row = db.prepare('select 1 as value').get(); db.close(); console.log(row.value)",
    ]).trim()
  }

  private static sharpProbe(node: string): number {
    const output = RemarkableSidecarPackageSmoke.runCaptured(node, [
      '--input-type=module',
      '--eval',
      "import sharp from 'sharp'; const png = await sharp({ create: { width: 1, height: 1, "
        + "channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer(); "
        + 'const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]); '
        + "if (!png.subarray(0, 8).equals(signature)) throw new Error('invalid PNG signature'); "
        + 'console.log(png.length)',
    ]).trim()
    return Number(output)
  }

  private static packagedApplicationProbe(): string {
    const stateRoot = mkdtempSync(join(tmpdir(), 'jamat-v3-package-smoke-state-'))
    const configDir = mkdtempSync(join(tmpdir(), 'jamat-v3-package-smoke-config-'))
    try {
      const mediaFile = join(configDir, RemarkableSidecarPackageSmoke.mediaFileNameConst)
      writeFileSync(mediaFile, RemarkableSidecarPackageSmoke.mediaBytesConst)
      const result = spawnSync(RemarkableSidecarPackageSmoke.packagedExecutableConst, [
        '--config-dir', configDir,
        '--channel', 'production',
        '--smoke',
      ], {
        encoding: 'utf8',
        env: {
          ...process.env,
          JAMAT_V3_LOCAL_STATE_DIR: stateRoot,
          JAMAT_V3_HOST_STATE_DIR: join(stateRoot, 'host'),
          JAMAT_V3_SMOKE_MEDIA_PATH: mediaFile,
          CLAUDE_CONFIG_DIR: configDir,
          CODEX_HOME: configDir,
        },
        maxBuffer: 2 * 1024 * 1024,
        timeout: 90_000,
        windowsHide: true,
      })
      if (result.error) throw result.error
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
      if (result.status !== 0)
        throw new Error(`packaged application exited with ${result.status}: ${output.trim()}`)
      return output
    } finally {
      RemarkableSidecarPackageSmoke.discard(stateRoot)
      RemarkableSidecarPackageSmoke.discard(configDir)
    }
  }

  private static discard(directory: string): void {
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }) }
    catch (error) {
      console.warn(`[smoke:remarkable-sidecar-package] ${directory} could not be removed: ${
        error instanceof Error ? error.message : String(error)}`)
    }
  }

  private static cleanRuntimeEnvironment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(process.env)) {
      const normalized = key.toUpperCase()
      if (normalized !== 'PATH' && normalized !== 'NODE_OPTIONS') env[key] = value
    }
    env.PATH = ''
    return env
  }

  private static resourcePath(path: string): string {
    const candidate = resolve(RemarkableSidecarPackageSmoke.resourceRootConst, path)
    const child = relative(RemarkableSidecarPackageSmoke.resourceRootConst, candidate)
    if (child.length === 0 || child.startsWith(`..${sep}`) || child === '..' || isAbsolute(child))
      throw new Error(`resource path escapes its root: ${path}`)
    return candidate
  }

  private static hashOf(file: string): string {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  }

  private static hashText(value: string): string {
    return createHash('sha256').update(value).digest('hex')
  }

  private static treeOf(root: string): ResourceManifest['tree'] {
    const entries = RemarkableSidecarPackageSmoke.filesUnder(root)
      .map((file) => ({
        path: RemarkableSidecarPackageSmoke.relativePath(root, file),
        sha256: RemarkableSidecarPackageSmoke.hashOf(file),
      }))
      .filter((entry) => entry.path !== 'manifest.json')
      .sort((left, right) => Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8')))
    const hash = createHash('sha256')
    for (const entry of entries)
      hash.update(entry.path, 'utf8').update('\0').update(entry.sha256, 'ascii').update('\n')
    return { files: entries.length, sha256: hash.digest('hex') }
  }

  private static sizeOf(directory: string): { files: number; bytes: number } {
    const files = RemarkableSidecarPackageSmoke.filesUnder(directory)
    return {
      files: files.length,
      bytes: files.reduce((total, file) => total + statSync(file).size, 0),
    }
  }

  private static filesUnder(directory: string): string[] {
    const files: string[] = []
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) files.push(...RemarkableSidecarPackageSmoke.filesUnder(path))
      else if (entry.isFile()) files.push(path)
      else throw new Error(`resource tree contains an unsupported entry: ${path}`)
    }
    return files
  }

  private static relativePath(root: string, file: string): string {
    const path = relative(root, file)
    return path.split(sep).join('/')
  }

  private static isSha256(value: unknown): value is string {
    return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
  }

  private static recordOf(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error(`${label} must be an object`)
    return value as Record<string, unknown>
  }
}

try {
  RemarkableSidecarPackageSmoke.run()
} catch (error) {
  SmokeRun.failed('[smoke:remarkable-sidecar-package]', error)
}
