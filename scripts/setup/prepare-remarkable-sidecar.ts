import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

type NodeArchiveFormat = 'tar.gz' | 'zip'

interface RemarkableSidecarRecipe {
  schemaVersion: 2
  /** electron-builder's `${os}-${arch}`: the seed directory name and the build FileSet path. */
  platformId: string
  /** `${process.platform}-${process.arch}`: what the resource manifest records for the client. */
  runtimePlatform: string
  node: {
    version: string
    archive: string
    sha256: string
  }
  cli: {
    package: string
    version: string
  }
  nativeFragments: readonly string[]
}

interface RemarkableSidecarFile {
  role: 'cli-entry' | 'cli-license' | 'cli-package' | 'native-module' | 'node' | 'node-license'
  path: string
  sha256: string
}

interface RemarkableSidecarResourceManifest {
  schemaVersion: 1
  bundleId: string
  platform: string
  node: {
    version: string
    executable: string
    archiveSha256: string
  }
  cli: {
    package: string
    version: string
    entry: string
  }
  recipe: {
    packageLockSha256: string
  }
  tree: {
    files: number
    sha256: string
  }
  files: readonly RemarkableSidecarFile[]
}

class PrepareRemarkableSidecar {
  private static readonly repoRootConst = resolve(import.meta.dirname, '..', '..')
  private static readonly recipeDirConst = join(
    PrepareRemarkableSidecar.repoRootConst,
    'configs',
    'remarkable-sidecar',
  )
  private static readonly sourceManifestFileConst = join(
    PrepareRemarkableSidecar.recipeDirConst,
    'manifest.json',
  )
  private static readonly packageLockFileConst = join(
    PrepareRemarkableSidecar.recipeDirConst,
    'package-lock.json',
  )
  private static readonly buildOsConst: Readonly<Partial<Record<NodeJS.Platform, string>>> = {
    darwin: 'mac',
    linux: 'linux',
    win32: 'win',
  }
  private static readonly isWindowsConst = process.platform === 'win32'

  static async run(): Promise<void> {
    const recipe = PrepareRemarkableSidecar.recipe()
    const sidecarRoot = join(PrepareRemarkableSidecar.repoRootConst, 'out', 'remarkable-sidecar')
    const platformRoot = join(sidecarRoot, recipe.platformId)
    mkdirSync(platformRoot, { recursive: true })
    const archive = await PrepareRemarkableSidecar.nodeArchive(recipe, sidecarRoot)
    const extraction = mkdtempSync(join(platformRoot, '.node-'))
    const staging = mkdtempSync(join(platformRoot, '.prepare-'))
    try {
      const nodeRoot = PrepareRemarkableSidecar.extractNode(archive, extraction, recipe)
      PrepareRemarkableSidecar.installProductionTree(staging, nodeRoot)
      const manifest = PrepareRemarkableSidecar.prepareResource(staging, nodeRoot, recipe)
      PrepareRemarkableSidecar.publish(staging, join(platformRoot, 'current'))
      const size = PrepareRemarkableSidecar.sizeOf(join(platformRoot, 'current'))
      console.log(`[setup:remarkable-sidecar] ${recipe.platformId}: ${manifest.bundleId}`)
      console.log(`[setup:remarkable-sidecar] ${size.files} files, ${size.bytes} bytes`)
    } finally {
      PrepareRemarkableSidecar.discard(extraction)
      PrepareRemarkableSidecar.discard(staging)
    }
  }

  /** electron-builder's `${os}-${arch}`, so one shared extraResources block resolves per build. */
  private static platformIdOf(platform: NodeJS.Platform, architecture: string): string {
    const os = PrepareRemarkableSidecar.buildOsConst[platform]
    if (os === undefined)
      throw new Error(`the reMarkable sidecar has no recipe for ${platform}-${architecture}`)
    return `${os}-${architecture}`
  }

  private static recipe(): RemarkableSidecarRecipe {
    const platformId = PrepareRemarkableSidecar.platformIdOf(process.platform, process.arch)
    const runtimePlatform = `${process.platform}-${process.arch}`
    const value: unknown = JSON.parse(readFileSync(
      PrepareRemarkableSidecar.sourceManifestFileConst,
      'utf8',
    ))
    const root = PrepareRemarkableSidecar.recordOf(value, 'sidecar manifest')
    if (root.schemaVersion !== 2)
      throw new Error('sidecar manifest schema is unsupported')
    const cli = PrepareRemarkableSidecar.recordOf(root.cli, 'sidecar manifest cli')
    const platforms = PrepareRemarkableSidecar.recordOf(root.platforms, 'sidecar manifest platforms')
    if (platforms[platformId] === undefined)
      throw new Error(`the reMarkable sidecar has no recipe for ${platformId} (${runtimePlatform})`)
    const platform = PrepareRemarkableSidecar.recordOf(
      platforms[platformId],
      `sidecar manifest platform ${platformId}`,
    )
    const node = PrepareRemarkableSidecar.recordOf(
      platform.node,
      `sidecar manifest ${platformId} node`,
    )
    if (typeof node.version !== 'string' || typeof node.archive !== 'string'
      || !PrepareRemarkableSidecar.isSha256(node.sha256))
      throw new Error(`sidecar manifest ${platformId} Node fields are invalid`)
    if (typeof cli.package !== 'string' || typeof cli.version !== 'string')
      throw new Error('sidecar manifest CLI fields are invalid')
    return {
      schemaVersion: 2,
      platformId,
      runtimePlatform,
      node: { version: node.version, archive: node.archive, sha256: node.sha256 },
      cli: { package: cli.package, version: cli.version },
      nativeFragments: PrepareRemarkableSidecar.fragmentsOf(platform.nativeFragments, platformId),
    }
  }

  private static fragmentsOf(value: unknown, platformId: string): readonly string[] {
    if (!Array.isArray(value) || value.length === 0)
      throw new Error(`sidecar manifest ${platformId} native fragments are invalid`)
    const fragments: string[] = []
    for (const fragment of value) {
      if (typeof fragment !== 'string' || fragment.length === 0)
        throw new Error(`sidecar manifest ${platformId} native fragments are invalid`)
      fragments.push(fragment)
    }
    return fragments
  }

  private static async nodeArchive(
    recipe: RemarkableSidecarRecipe,
    sidecarRoot: string,
  ): Promise<string> {
    const cache = join(sidecarRoot, '.cache')
    const archive = join(cache, recipe.node.archive)
    mkdirSync(cache, { recursive: true })
    if (existsSync(archive)) {
      PrepareRemarkableSidecar.assertHash(archive, recipe.node.sha256, 'cached Node archive')
      return archive
    }
    const temporary = `${archive}.download-${process.pid}-${randomUUID()}`
    try {
      const url = `https://nodejs.org/dist/v${recipe.node.version}/${recipe.node.archive}`
      console.log(`[setup:remarkable-sidecar] downloading ${url}`)
      const response = await fetch(url)
      if (!response.ok)
        throw new Error(`Node download failed with HTTP ${response.status}`)
      writeFileSync(temporary, Buffer.from(await response.arrayBuffer()))
      PrepareRemarkableSidecar.assertHash(temporary, recipe.node.sha256, 'downloaded Node archive')
      renameSync(temporary, archive)
      return archive
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary)
    }
  }

  private static archiveOf(archive: string): { format: NodeArchiveFormat; root: string } {
    const name = archive.toLowerCase()
    if (name.endsWith('.zip')) return { format: 'zip', root: archive.slice(0, -'.zip'.length) }
    if (name.endsWith('.tar.gz')) return { format: 'tar.gz', root: archive.slice(0, -'.tar.gz'.length) }
    throw new Error(`unsupported Node archive format: ${archive}`)
  }

  private static extractNode(
    archive: string,
    extraction: string,
    recipe: RemarkableSidecarRecipe,
  ): string {
    const layout = PrepareRemarkableSidecar.archiveOf(recipe.node.archive)
    if (layout.format === 'zip') {
      const command = '& { param([string]$source, [string]$destination) '
        + 'Expand-Archive -LiteralPath $source -DestinationPath $destination -Force }'
      PrepareRemarkableSidecar.runInherited(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command, archive, extraction],
        PrepareRemarkableSidecar.repoRootConst,
        'Node archive extraction',
      )
    } else if (layout.format === 'tar.gz') {
      // tar keeps the +x bit on bin/node, which copyFileSync would not carry over on its own.
      PrepareRemarkableSidecar.runInherited(
        'tar',
        ['-xzf', archive, '-C', extraction],
        PrepareRemarkableSidecar.repoRootConst,
        'Node archive extraction',
      )
    } else throw new Error(`unsupported Node archive format: ${recipe.node.archive}`)
    const nodeRoot = join(extraction, layout.root)
    for (const file of PrepareRemarkableSidecar.requiredNodeFiles()) {
      if (!existsSync(join(nodeRoot, file)))
        throw new Error(`Node archive is missing ${file}`)
    }
    return nodeRoot
  }

  private static requiredNodeFiles(): readonly string[] {
    if (PrepareRemarkableSidecar.isWindowsConst) return ['node.exe', 'npm.cmd', 'LICENSE']
    return ['bin/node', 'lib/node_modules/npm/bin/npm-cli.js', 'LICENSE']
  }

  private static installProductionTree(staging: string, nodeRoot: string): void {
    copyFileSync(join(PrepareRemarkableSidecar.recipeDirConst, 'package.json'), join(staging, 'package.json'))
    copyFileSync(PrepareRemarkableSidecar.packageLockFileConst, join(staging, 'package-lock.json'))
    const environment: NodeJS.ProcessEnv = { ...process.env, npm_config_update_notifier: 'false' }
    // `--no-bin-links` because this tree is a shipped RESOURCE, not a place anything is run from.
    // npm fills node_modules/.bin with real files on Windows and with SYMLINKS on macOS and Linux,
    // and the resource walk below accepts a directory or a file and refuses everything else - so
    // the first three-OS build died on both posix legs at
    // `resource tree contains an unsupported entry: .../node_modules/.bin/node-which` while Windows
    // sailed through. Refusing a symlink in a tree that gets hashed, copied and shipped is the
    // right rule; creating one and then arguing about it is not.
    //
    // Nothing needs .bin: the CLI is resolved through its own package's `bin.rmcli` and run as
    // `node <package>/<entry>`, the recipe manifest names no .bin path, and on Windows this only
    // drops .cmd and .ps1 shims nothing ever called.
    const flags = ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--no-bin-links']
    const result = PrepareRemarkableSidecar.isWindowsConst
      ? spawnSync(
        process.env.ComSpec ?? 'cmd.exe',
        ['/d', '/s', '/c', `"${join(nodeRoot, 'npm.cmd')}" ${flags.join(' ')}`],
        { cwd: staging, env: environment, stdio: 'inherit', windowsVerbatimArguments: true },
      )
      : spawnSync(
        join(nodeRoot, 'bin', 'node'),
        [join(nodeRoot, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), ...flags],
        { cwd: staging, env: environment, stdio: 'inherit' },
      )
    if (result.error) throw result.error
    if (result.status !== 0)
      throw new Error(`bundled npm ci failed with status ${result.status}`)
    unlinkSync(join(staging, 'package.json'))
    unlinkSync(join(staging, 'package-lock.json'))
  }

  private static copyNodeRuntime(staging: string, nodeRoot: string): string {
    copyFileSync(join(nodeRoot, 'LICENSE'), join(staging, 'NODE-LICENSE.txt'))
    if (PrepareRemarkableSidecar.isWindowsConst) {
      const executable = join(staging, 'node.exe')
      copyFileSync(join(nodeRoot, 'node.exe'), executable)
      return executable
    }
    const executable = join(staging, 'bin', 'node')
    mkdirSync(dirname(executable), { recursive: true })
    copyFileSync(join(nodeRoot, 'bin', 'node'), executable)
    chmodSync(executable, 0o755)
    return executable
  }

  private static prepareResource(
    staging: string,
    nodeRoot: string,
    recipe: RemarkableSidecarRecipe,
  ): RemarkableSidecarResourceManifest {
    const nodeExecutable = PrepareRemarkableSidecar.copyNodeRuntime(staging, nodeRoot)
    const cliPackageDir = join(staging, 'node_modules', ...recipe.cli.package.split('/'))
    const cliPackageFile = join(cliPackageDir, 'package.json')
    const cliPackage = PrepareRemarkableSidecar.recordOf(
      JSON.parse(readFileSync(cliPackageFile, 'utf8')) as unknown,
      'installed CLI package',
    )
    if (cliPackage.name !== recipe.cli.package || cliPackage.version !== recipe.cli.version)
      throw new Error('installed CLI package name or version does not match the recipe')
    const bin = PrepareRemarkableSidecar.recordOf(cliPackage.bin, 'installed CLI bin')
    if (typeof bin.rmcli !== 'string')
      throw new Error('installed CLI package has no bin.rmcli entry')
    const cliEntryFile = resolve(cliPackageDir, bin.rmcli)
    PrepareRemarkableSidecar.assertInside(cliPackageDir, cliEntryFile, 'CLI entry')
    if (!existsSync(cliEntryFile))
      throw new Error(`installed CLI entry does not exist: ${cliEntryFile}`)
    const cliLicenseFile = join(cliPackageDir, 'LICENSE')
    if (!existsSync(cliLicenseFile))
      throw new Error('installed CLI package has no LICENSE')
    const nativeCandidates = PrepareRemarkableSidecar.filesUnder(join(staging, 'node_modules'))
      .filter((file) => extname(file).toLowerCase() === '.node')
      .sort((left, right) => left.localeCompare(right))
    const nativePaths = nativeCandidates.map((file) => PrepareRemarkableSidecar.relativePath(staging, file))
    for (const fragment of recipe.nativeFragments) {
      if (!nativePaths.some((file) => file.includes(fragment)))
        throw new Error(`production install is missing a native module under ${fragment}`)
    }
    const nativeFiles = nativeCandidates.filter((file) => {
      const path = PrepareRemarkableSidecar.relativePath(staging, file)
      return recipe.nativeFragments.some((fragment) => path.includes(fragment))
    })
    const nodeVersion = PrepareRemarkableSidecar.runCaptured(
      nodeExecutable,
      ['--version'],
      staging,
      'bundled Node version',
    ).trim()
    if (nodeVersion !== `v${recipe.node.version}`)
      throw new Error(`bundled Node reports ${nodeVersion}, expected v${recipe.node.version}`)
    const help = PrepareRemarkableSidecar.runCaptured(
      nodeExecutable,
      [cliEntryFile, '--help'],
      staging,
      'remarkable CLI help',
    )
    if (help.trim().length === 0)
      throw new Error('remarkable CLI help returned no output')
    PrepareRemarkableSidecar.verifyNativeModules(nodeExecutable, staging)
    const files: RemarkableSidecarFile[] = [
      PrepareRemarkableSidecar.fileOf(staging, nodeExecutable, 'node'),
      PrepareRemarkableSidecar.fileOf(staging, join(staging, 'NODE-LICENSE.txt'), 'node-license'),
      PrepareRemarkableSidecar.fileOf(staging, cliPackageFile, 'cli-package'),
      PrepareRemarkableSidecar.fileOf(staging, cliEntryFile, 'cli-entry'),
      PrepareRemarkableSidecar.fileOf(staging, cliLicenseFile, 'cli-license'),
      ...nativeFiles.map((file) => PrepareRemarkableSidecar.fileOf(staging, file, 'native-module')),
    ].sort((left, right) => left.path.localeCompare(right.path))
    const packageLockSha256 = PrepareRemarkableSidecar.hashOf(
      PrepareRemarkableSidecar.packageLockFileConst,
    )
    const tree = PrepareRemarkableSidecar.treeOf(staging)
    const bundleId = PrepareRemarkableSidecar.bundleIdOf(recipe, packageLockSha256, tree, files)
    const manifest: RemarkableSidecarResourceManifest = {
      schemaVersion: 1,
      bundleId,
      platform: recipe.runtimePlatform,
      node: {
        version: recipe.node.version,
        executable: PrepareRemarkableSidecar.relativePath(staging, nodeExecutable),
        archiveSha256: recipe.node.sha256,
      },
      cli: {
        package: recipe.cli.package,
        version: recipe.cli.version,
        entry: PrepareRemarkableSidecar.relativePath(staging, cliEntryFile),
      },
      recipe: { packageLockSha256 },
      tree,
      files,
    }
    writeFileSync(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    PrepareRemarkableSidecar.assertTree(staging, manifest.tree)
    return manifest
  }

  private static bundleIdOf(
    recipe: RemarkableSidecarRecipe,
    packageLockSha256: string,
    tree: RemarkableSidecarResourceManifest['tree'],
    files: readonly RemarkableSidecarFile[],
  ): string {
    const hash = PrepareRemarkableSidecar.hashText(JSON.stringify({
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

  private static fileOf(
    root: string,
    file: string,
    role: RemarkableSidecarFile['role'],
  ): RemarkableSidecarFile {
    return { role, path: PrepareRemarkableSidecar.relativePath(root, file), sha256: PrepareRemarkableSidecar.hashOf(file) }
  }

  private static treeOf(root: string): RemarkableSidecarResourceManifest['tree'] {
    const entries = PrepareRemarkableSidecar.filesUnder(root)
      .map((file) => ({
        path: PrepareRemarkableSidecar.relativePath(root, file),
        sha256: PrepareRemarkableSidecar.hashOf(file),
      }))
      .filter((entry) => entry.path !== 'manifest.json')
      .sort((left, right) => Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8')))
    const hash = createHash('sha256')
    for (const entry of entries)
      hash.update(entry.path, 'utf8').update('\0').update(entry.sha256, 'ascii').update('\n')
    return { files: entries.length, sha256: hash.digest('hex') }
  }

  private static assertTree(
    root: string,
    expected: RemarkableSidecarResourceManifest['tree'],
  ): void {
    const actual = PrepareRemarkableSidecar.treeOf(root)
    if (actual.files !== expected.files || actual.sha256 !== expected.sha256)
      throw new Error(`resource tree mismatch: expected ${expected.files}/${expected.sha256}, received ${actual.files}/${actual.sha256}`)
  }

  private static publish(staging: string, current: string): void {
    const backup = `${current}.previous-${process.pid}-${randomUUID()}`
    let previousMoved = false
    if (existsSync(current)) {
      renameSync(current, backup)
      previousMoved = true
    }
    try {
      renameSync(staging, current)
    } catch (error) {
      if (previousMoved) renameSync(backup, current)
      throw error
    }
    if (previousMoved) {
      try { rmSync(backup, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
      catch (error) {
        console.warn(`[setup:remarkable-sidecar] old seed remains at ${backup}: ${PrepareRemarkableSidecar.errorOf(error)}`)
      }
    }
  }

  private static runInherited(
    command: string,
    args: readonly string[],
    cwd: string,
    label: string,
  ): void {
    const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0)
      throw new Error(`${label} failed with status ${result.status}`)
  }

  private static runCaptured(
    command: string,
    args: readonly string[],
    cwd: string,
    label: string,
  ): string {
    const result = spawnSync(command, args, {
      cwd,
      encoding: 'utf8',
      env: PrepareRemarkableSidecar.cleanRuntimeEnvironment(),
      maxBuffer: 2 * 1024 * 1024,
      timeout: 30_000,
      windowsHide: true,
    })
    if (result.error) throw result.error
    if (result.status !== 0)
      throw new Error(`${label} failed with status ${result.status}: ${(result.stderr ?? '').trim()}`)
    return `${result.stdout ?? ''}${result.stderr ?? ''}`
  }

  private static verifyNativeModules(node: string, cwd: string): void {
    const sqlite = PrepareRemarkableSidecar.runCaptured(
      node,
      [
        '--input-type=module',
        '--eval',
        "import Database from 'better-sqlite3'; const db = new Database(':memory:'); "
          + "const row = db.prepare('select 1 as value').get(); db.close(); console.log(row.value)",
      ],
      cwd,
      'better-sqlite3 native probe',
    ).trim()
    if (sqlite !== '1')
      throw new Error(`better-sqlite3 native probe returned ${JSON.stringify(sqlite)}`)
    const sharp = PrepareRemarkableSidecar.runCaptured(
      node,
      [
        '--input-type=module',
        '--eval',
        "import sharp from 'sharp'; const png = await sharp({ create: { width: 1, height: 1, "
          + "channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer(); "
          + 'const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]); '
          + "if (!png.subarray(0, 8).equals(signature)) throw new Error('invalid PNG signature'); "
          + 'console.log(png.length)',
      ],
      cwd,
      'sharp native probe',
    ).trim()
    const sharpBytes = Number(sharp)
    if (!Number.isSafeInteger(sharpBytes) || sharpBytes < 8)
      throw new Error(`sharp native probe returned ${JSON.stringify(sharp)}`)
    console.log(`[setup:remarkable-sidecar] native probes: sqlite=${sqlite}, sharp=${sharpBytes} bytes`)
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

  private static filesUnder(directory: string): string[] {
    const files: string[] = []
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) files.push(...PrepareRemarkableSidecar.filesUnder(path))
      else if (entry.isFile()) files.push(path)
      else throw new Error(`resource tree contains an unsupported entry: ${path}`)
    }
    return files
  }

  private static sizeOf(directory: string): { files: number; bytes: number } {
    let bytes = 0
    const files = PrepareRemarkableSidecar.filesUnder(directory)
    for (const file of files) bytes += statSync(file).size
    return { files: files.length, bytes }
  }

  private static relativePath(root: string, file: string): string {
    PrepareRemarkableSidecar.assertInside(root, file, 'resource file')
    return relative(root, file).split(sep).join('/')
  }

  private static assertInside(root: string, file: string, label: string): void {
    const child = relative(resolve(root), resolve(file))
    if (child.length === 0 || child.startsWith(`..${sep}`) || child === '..' || isAbsolute(child))
      throw new Error(`${label} escapes its root`)
  }

  private static assertHash(file: string, expected: string, label: string): void {
    const actual = PrepareRemarkableSidecar.hashOf(file)
    if (actual !== expected)
      throw new Error(`${label} SHA256 mismatch: expected ${expected}, received ${actual}`)
  }

  private static hashOf(file: string): string {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  }

  private static hashText(value: string): string {
    return createHash('sha256').update(value).digest('hex')
  }

  private static isSha256(value: unknown): value is string {
    return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
  }

  private static recordOf(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error(`${label} must be an object`)
    return value as Record<string, unknown>
  }

  private static discard(directory: string): void {
    if (!existsSync(directory)) return
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }

  private static errorOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}

void PrepareRemarkableSidecar.run().catch((error: unknown) => {
  console.error(`[setup:remarkable-sidecar] ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exit(1)
})
