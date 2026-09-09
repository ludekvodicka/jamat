import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path'

import { JsonShape } from '../../../../lib-orchestrator/shared/jsonShape'

export type RemarkableSidecarFileRole =
  | 'cli-entry'
  | 'cli-license'
  | 'cli-package'
  | 'native-module'
  | 'node'
  | 'node-license'

export interface RemarkableSidecarFile {
  role: RemarkableSidecarFileRole
  path: string
  sha256: string
}

export interface RemarkableSidecarTree {
  files: number
  sha256: string
}

export interface RemarkableSidecarManifestValue {
  schemaVersion: 1
  bundleId: string
  platform: 'win32-x64'
  node: {
    version: '22.23.2'
    executable: string
    archiveSha256: string
  }
  cli: {
    package: 'remarkable-cli'
    version: '0.3.0'
    entry: string
  }
  recipe: { packageLockSha256: string }
  tree: RemarkableSidecarTree
  files: readonly RemarkableSidecarFile[]
}

export class RemarkableSidecarManifest {
  static readonly nodeVersionConst: '22.23.2' = '22.23.2'
  static readonly cliVersionConst: '0.3.0' = '0.3.0'
  static readonly platformConst: 'win32-x64' = 'win32-x64'
  /** Measured on the shipped bundle: 8 concurrent readers hash it in a quarter of the serial time. */
  private static readonly hashWorkersConst = 8
  private static readonly nodeArchiveSha256Const =
    '1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97'
  private static readonly rolesConst: readonly RemarkableSidecarFileRole[] = [
    'cli-entry',
    'cli-license',
    'cli-package',
    'native-module',
    'node',
    'node-license',
  ]

  static async read(directory: string): Promise<RemarkableSidecarManifestValue> {
    return RemarkableSidecarManifest.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  }

  static parse(text: string): RemarkableSidecarManifestValue {
    let value: unknown
    try { value = JSON.parse(text) }
    catch { throw new Error('The reMarkable sidecar manifest is not one JSON value') }
    const root = RemarkableSidecarManifest.record(value, 'manifest', [
      'bundleId', 'cli', 'files', 'node', 'platform', 'recipe', 'schemaVersion', 'tree',
    ])
    const node = RemarkableSidecarManifest.record(root['node'], 'manifest node', [
      'archiveSha256', 'executable', 'version',
    ])
    const cli = RemarkableSidecarManifest.record(root['cli'], 'manifest CLI', [
      'entry', 'package', 'version',
    ])
    const recipe = RemarkableSidecarManifest.record(root['recipe'], 'manifest recipe', [
      'packageLockSha256',
    ])
    const tree = RemarkableSidecarManifest.record(root['tree'], 'manifest tree', [
      'files', 'sha256',
    ])
    if (root['schemaVersion'] !== 1 || root['platform'] !== RemarkableSidecarManifest.platformConst)
      throw new Error('The reMarkable sidecar manifest schema or platform is unsupported')
    if (node['version'] !== RemarkableSidecarManifest.nodeVersionConst
      || node['archiveSha256'] !== RemarkableSidecarManifest.nodeArchiveSha256Const
      || !RemarkableSidecarManifest.safePath(node['executable']))
      throw new Error('The reMarkable sidecar manifest Node fields are invalid')
    if (cli['package'] !== 'remarkable-cli'
      || cli['version'] !== RemarkableSidecarManifest.cliVersionConst
      || !RemarkableSidecarManifest.safePath(cli['entry']))
      throw new Error('The reMarkable sidecar manifest CLI fields are invalid')
    if (!RemarkableSidecarManifest.isSha256(recipe['packageLockSha256']))
      throw new Error('The reMarkable sidecar manifest recipe hash is invalid')
    if (!Number.isSafeInteger(tree['files'])
      || typeof tree['files'] !== 'number'
      || tree['files'] < 1
      || !RemarkableSidecarManifest.isSha256(tree['sha256']))
      throw new Error('The reMarkable sidecar manifest tree is invalid')
    if (!Array.isArray(root['files']) || root['files'].length === 0)
      throw new Error('The reMarkable sidecar manifest files are invalid')

    const files = root['files'].map((raw, index) => {
      const file = RemarkableSidecarManifest.record(raw, `manifest file ${index}`, [
        'path', 'role', 'sha256',
      ])
      if (!RemarkableSidecarManifest.isRole(file['role'])
        || !RemarkableSidecarManifest.safePath(file['path'])
        || !RemarkableSidecarManifest.isSha256(file['sha256']))
        throw new Error(`The reMarkable sidecar manifest file ${index} is invalid`)
      return { role: file['role'], path: file['path'], sha256: file['sha256'] }
    })
    const paths = files.map((file) => file.path)
    if (new Set(paths).size !== paths.length
      || [...paths].sort((left, right) => left.localeCompare(right)).some((path, index) => path !== paths[index]))
      throw new Error('The reMarkable sidecar manifest files must be unique and sorted')
    RemarkableSidecarManifest.requireRoles(files, node['executable'], cli['entry'])

    if (typeof root['bundleId'] !== 'string')
      throw new Error('The reMarkable sidecar manifest bundle ID is invalid')
    const candidate: RemarkableSidecarManifestValue = {
      schemaVersion: 1 as const,
      bundleId: root['bundleId'],
      platform: RemarkableSidecarManifest.platformConst,
      node: {
        version: RemarkableSidecarManifest.nodeVersionConst,
        executable: node['executable'],
        archiveSha256: node['archiveSha256'],
      },
      cli: {
        package: 'remarkable-cli' as const,
        version: RemarkableSidecarManifest.cliVersionConst,
        entry: cli['entry'],
      },
      recipe: { packageLockSha256: recipe['packageLockSha256'] },
      tree: { files: tree['files'], sha256: tree['sha256'] },
      files,
    }
    if (candidate.bundleId !== RemarkableSidecarManifest.bundleIdOf(candidate))
      throw new Error('The reMarkable sidecar manifest bundle ID is invalid')
    return candidate
  }

  static async verify(
    directory: string,
    manifest: RemarkableSidecarManifestValue,
  ): Promise<{ node: string; entry: string }> {
    const tree = await RemarkableSidecarManifest.treeOf(directory)
    if (tree.value.files !== manifest.tree.files || tree.value.sha256 !== manifest.tree.sha256)
      throw new Error('The reMarkable sidecar runtime tree does not match its manifest')
    for (const file of manifest.files) {
      if (tree.hashes.get(file.path) !== file.sha256)
        throw new Error(`The reMarkable sidecar file hash does not match: ${file.path}`)
    }
    return {
      node: resolve(directory, ...manifest.node.executable.split('/')),
      entry: resolve(directory, ...manifest.cli.entry.split('/')),
    }
  }

  private static bundleIdOf(
    manifest: RemarkableSidecarManifestValue,
  ): string {
    const hash = createHash('sha256').update(JSON.stringify({
      schemaVersion: 1,
      platform: manifest.platform,
      nodeVersion: manifest.node.version,
      nodeArchiveSha256: manifest.node.archiveSha256,
      cliPackage: manifest.cli.package,
      cliVersion: manifest.cli.version,
      packageLockSha256: manifest.recipe.packageLockSha256,
      tree: manifest.tree,
      files: manifest.files,
    })).digest('hex')
    return `${manifest.platform}-node-${manifest.node.version}-${manifest.cli.package}-${manifest.cli.version}-${hash.slice(0, 16)}`
  }

  private static requireRoles(
    files: readonly RemarkableSidecarFile[],
    node: string,
    entry: string,
  ): void {
    for (const role of RemarkableSidecarManifest.rolesConst) {
      const count = files.filter((file) => file.role === role).length
      if (role === 'native-module' ? count < 1 : count !== 1)
        throw new Error(`The reMarkable sidecar manifest has an invalid ${role} count`)
    }
    if (!files.some((file) => file.role === 'node' && file.path === node)
      || !files.some((file) => file.role === 'cli-entry' && file.path === entry))
      throw new Error('The reMarkable sidecar executable paths do not match their file roles')
  }

  private static record(
    value: unknown,
    label: string,
    keys: readonly string[],
  ): Record<string, unknown> {
    if (!JsonShape.isRecord(value)) throw new Error(`The reMarkable sidecar ${label} is not an object`)
    const actual = Object.keys(value).sort((left, right) => left.localeCompare(right))
    const expected = [...keys].sort((left, right) => left.localeCompare(right))
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
      throw new Error(`The reMarkable sidecar ${label} has unexpected fields`)
    return value
  }

  private static safePath(value: unknown): value is string {
    return typeof value === 'string'
      && value.length > 0
      && !value.includes('\\')
      && !value.includes('\0')
      && !isAbsolute(value)
      && !posix.isAbsolute(value)
      && posix.normalize(value) === value
      && value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
  }

  private static isSha256(value: unknown): value is string {
    return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
  }

  private static isRole(value: unknown): value is RemarkableSidecarFileRole {
    return typeof value === 'string'
      && RemarkableSidecarManifest.rolesConst.includes(value as RemarkableSidecarFileRole)
  }

  private static assertInside(root: string, child: string, label: string): void {
    const local = relative(resolve(root), resolve(child))
    if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local))
      throw new Error(`${label} escapes the reMarkable sidecar root`)
  }

  private static async treeOf(
    directory: string,
  ): Promise<{ value: RemarkableSidecarTree; hashes: ReadonlyMap<string, string> }> {
    const root = await realpath(directory)
    const paths: string[] = []
    await RemarkableSidecarManifest.collectTree(directory, directory, root, paths)
    const hashes = await RemarkableSidecarManifest.hashAll(directory, paths)
    const entries = [...hashes].sort(([left], [right]) =>
      Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')))
    const hash = createHash('sha256')
    for (const [path, sha256] of entries)
      hash.update(path, 'utf8').update('\0').update(sha256, 'ascii').update('\n')
    return { value: { files: entries.length, sha256: hash.digest('hex') }, hashes }
  }

  /**
   * The type comes from the directory entry rather than a second `lstat`, and only a directory is
   * resolved to its real path: a file that redirects anywhere is a link, and links are refused here.
   * The pair of extra syscalls per file cost more than hashing the whole 178 MB bundle.
   */
  private static async collectTree(
    directory: string,
    sourceRoot: string,
    realRoot: string,
    paths: string[],
  ): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = join(directory, entry.name)
      if (entry.isSymbolicLink())
        throw new Error(`The reMarkable sidecar tree contains a link: ${entry.name}`)
      if (entry.isDirectory()) {
        const actual = await realpath(candidate)
        RemarkableSidecarManifest.assertInside(realRoot, actual, 'Sidecar tree entry')
        await RemarkableSidecarManifest.collectTree(candidate, sourceRoot, realRoot, paths)
      } else if (entry.isFile()) {
        const path = relative(sourceRoot, candidate).split(sep).join('/')
        if (path !== 'manifest.json') paths.push(path)
      } else throw new Error(`The reMarkable sidecar tree contains a non-file entry: ${entry.name}`)
    }
  }

  private static async hashAll(
    directory: string,
    paths: readonly string[],
  ): Promise<Map<string, string>> {
    const hashes = new Map<string, string>()
    let next = 0
    const workers = Math.min(RemarkableSidecarManifest.hashWorkersConst, paths.length)
    await Promise.all(Array.from({ length: workers }, async () => {
      for (let index = next++; index < paths.length; index = next++) {
        const path = paths[index]
        if (path === undefined) throw new Error('The reMarkable sidecar tree lost a file')
        hashes.set(path, await RemarkableSidecarManifest.hashOf(resolve(directory, ...path.split('/'))))
      }
    }))
    return hashes
  }

  /** Streamed rather than read whole: one file of this bundle is an 87 MB `node.exe`. */
  private static async hashOf(file: string): Promise<string> {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(file)) hash.update(chunk)
    return hash.digest('hex')
  }
}
