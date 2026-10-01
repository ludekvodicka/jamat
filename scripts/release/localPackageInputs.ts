import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export class LocalPackageInputs {
  private static readonly pathsConst = [
    'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'LICENSE',
    'app-client-ui/app', 'app-client-ui/preload', 'app-client-ui/renderer',
    'app-client-ui/shared', 'app-client-ui/buildResources', 'app-client-ui/start.ts',
    'app-client-ui/package.json', 'app-client-ui/pnpm-lock.yaml',
    'app-client-ui/pnpm-workspace.yaml', 'app-client-ui/electron.vite.config.ts',
    'app-client-ui/tsconfig.json', 'app-client-ui/tsconfig.node.json',
    'app-client-ui/tsconfig.web.json', 'app-host', 'app-launcher', 'lib-orchestrator',
    'mdext-renderer/renderer', 'configs/remarkable-sidecar', 'scripts/release',
    'scripts/setup/prepare-remarkable-sidecar.ts', 'scripts/setup/install-launcher.ps1',
  ]
  private static readonly skippedDirectoriesConst = new Set([
    '.git', '.svn', '.checkpoints', 'node_modules', 'out', 'dist', 'data',
  ])
  private readonly files: ReadonlyMap<string, Buffer>
  readonly hash: string

  private constructor(files: ReadonlyMap<string, Buffer>) {
    this.files = files
    const hash = createHash('sha256').update(`local-package-v1\0${process.platform}\0${process.arch}\0${process.version}\0`)
    for (const [path, contents] of files)
      hash.update(path).update('\0').update(createHash('sha256').update(contents).digest()).update('\0')
    this.hash = hash.digest('hex')
  }

  static read(repositoryRoot: string): LocalPackageInputs {
    const files = new Map<string, Buffer>()
    for (const path of LocalPackageInputs.pathsConst)
      LocalPackageInputs.readUnder(repositoryRoot, path, files)
    for (const directory of ['', 'app-client-ui', 'app-host', 'lib-orchestrator'])
      for (const name of readdirSync(join(repositoryRoot, directory)))
        if (name === '.npmrc' || name === '.env' || name.startsWith('.env.'))
          LocalPackageInputs.readUnder(repositoryRoot, `${directory ? `${directory}/` : ''}${name}`, files)
    return new LocalPackageInputs(new Map([...files].sort(([left], [right]) => left.localeCompare(right, 'en'))))
  }

  writeTo(directory: string): void {
    for (const [path, contents] of this.files) {
      const target = join(directory, path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, contents)
    }
  }

  private static readUnder(root: string, path: string, files: Map<string, Buffer>): void {
    const absolute = join(root, path)
    if (!existsSync(absolute)) throw new Error(`missing package input: ${path}`)
    const stats = lstatSync(absolute)
    if (stats.isDirectory()) {
      for (const name of readdirSync(absolute))
        if (!LocalPackageInputs.skippedDirectoriesConst.has(name))
          LocalPackageInputs.readUnder(root, `${path}/${name}`, files)
    } else if (stats.isFile()) {
      if (!/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) && !path.endsWith('.tsbuildinfo'))
        files.set(path, readFileSync(absolute))
    } else throw new Error(`unsupported package input: ${path}`)
  }
}
