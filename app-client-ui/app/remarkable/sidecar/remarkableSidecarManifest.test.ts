import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  RemarkableSidecarManifest,
  type RemarkableSidecarFile,
  type RemarkableSidecarManifestValue,
} from './remarkableSidecarManifest'
import { RemarkableSidecarSource } from './remarkableSidecarSource'

describe('app-client-ui/app/remarkable/sidecar/remarkableSidecarManifest', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('accepts the generated U1 shape and rejects trailing or unexpected JSON', () => {
    const manifest = fixture()

    expect(RemarkableSidecarManifest.parse(JSON.stringify(manifest))).toEqual(manifest)
    expect(() => RemarkableSidecarManifest.parse(`${JSON.stringify(manifest)} trailing`))
      .toThrow('not one JSON value')
    expect(() => RemarkableSidecarManifest.parse(JSON.stringify({ ...manifest, extra: true })))
      .toThrow('unexpected fields')
  })

  it('rejects escaped paths, duplicate files and a forged bundle ID', () => {
    const manifest = fixture()
    const escaped = withBundleId({
      ...manifest,
      files: manifest.files.map((file) => file.role === 'cli-entry'
        ? { ...file, path: '../cli.js' }
        : file),
    })
    expect(() => RemarkableSidecarManifest.parse(JSON.stringify(escaped))).toThrow('file 1 is invalid')

    const duplicate = withBundleId({ ...manifest, files: [...manifest.files, manifest.files[0]] })
    expect(() => RemarkableSidecarManifest.parse(JSON.stringify(duplicate))).toThrow('unique and sorted')
    expect(() => RemarkableSidecarManifest.parse(JSON.stringify({
      ...manifest,
      bundleId: `${manifest.bundleId}-forged`,
    }))).toThrow('bundle ID is invalid')
  })

  it('verifies the complete runtime tree and rejects extra or missing files', async () => {
    const root = temporary('verified-tree')
    const manifest = fixture()
    for (const file of manifest.files) {
      const path = join(root, ...file.path.split('/'))
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, file.path)
    }
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest))

    await expect(RemarkableSidecarManifest.verify(root, manifest)).resolves.toEqual({
      node: join(root, 'node.exe'),
      entry: join(root, 'node_modules', 'remarkable-cli', 'dist', 'cli.js'),
    })
    writeFileSync(join(root, 'extra.txt'), 'extra')
    await expect(RemarkableSidecarManifest.verify(root, manifest)).rejects.toThrow('runtime tree')
    rmSync(join(root, 'extra.txt'))
    rmSync(join(root, 'node.exe'))
    await expect(RemarkableSidecarManifest.verify(root, manifest)).rejects.toThrow('runtime tree')
    writeFileSync(join(root, 'node.exe'), 'node.exe')
    const outside = join(temporary('tree-link-target'), 'outside.txt')
    writeFileSync(outside, 'outside')
    symlinkSync(outside, join(root, 'linked.txt'), 'file')
    await expect(RemarkableSidecarManifest.verify(root, manifest)).rejects.toThrow('contains a link')
  })

  it('resolves only the packaged resource or the development out root', () => {
    const root = temporary('source-root')
    const resources = temporary('source-resources')

    expect(RemarkableSidecarSource.resolve(false, root, resources)).toBe(
      join(root, 'out', 'remarkable-sidecar', 'win-x64', 'current'),
    )
    expect(RemarkableSidecarSource.resolve(true, root, resources)).toBe(
      join(resources, 'remarkable-sidecar'),
    )
  })

  function temporary(name: string): string {
    // This subsystem proves a path by realpath(p) === p, and os.tmpdir() is an 8.3 short
    // name on the Windows CI runner. Only the NATIVE call expands one, so a plain
    // realpathSync here would leave the root short and every such proof would refuse.
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), `jamat-v3-remarkable-${name}-`)))
    roots.push(root)
    return root
  }
})

function fixture(): RemarkableSidecarManifestValue {
  const files: RemarkableSidecarFile[] = [
    file('NODE-LICENSE.txt', 'node-license'),
    file('node.exe', 'node'),
    file('node_modules/better-sqlite3/build/Release/better_sqlite3.node', 'native-module'),
    file('node_modules/remarkable-cli/LICENSE', 'cli-license'),
    file('node_modules/remarkable-cli/dist/cli.js', 'cli-entry'),
    file('node_modules/remarkable-cli/package.json', 'cli-package'),
  ].sort((left, right) => left.path.localeCompare(right.path))
  return withBundleId({
    schemaVersion: 1,
    platform: 'win32-x64',
    node: {
      version: '22.23.2',
      executable: 'node.exe',
      archiveSha256: '1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97',
    },
    cli: {
      package: 'remarkable-cli',
      version: '0.3.0',
      entry: 'node_modules/remarkable-cli/dist/cli.js',
    },
    recipe: { packageLockSha256: 'a'.repeat(64) },
    tree: treeOf(files),
    files,
  })
}

function file(path: string, role: RemarkableSidecarFile['role']): RemarkableSidecarFile {
  return { role, path, sha256: createHash('sha256').update(path).digest('hex') }
}

function withBundleId(
  manifest: Omit<RemarkableSidecarManifestValue, 'bundleId'>,
): RemarkableSidecarManifestValue {
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
  return {
    ...manifest,
    bundleId: `${manifest.platform}-node-${manifest.node.version}-${manifest.cli.package}-${manifest.cli.version}-${hash.slice(0, 16)}`,
  }
}

function treeOf(files: readonly RemarkableSidecarFile[]): RemarkableSidecarManifestValue['tree'] {
  const entries = [...files].sort((left, right) =>
    Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8')))
  const hash = createHash('sha256')
  for (const file of entries)
    hash.update(file.path, 'utf8').update('\0').update(file.sha256, 'ascii').update('\n')
  return { files: entries.length, sha256: hash.digest('hex') }
}
