import assert from 'node:assert/strict'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { setTimeout } from 'node:timers/promises'

import { LocalClientPackage } from './localClientPackage.js'
import { LocalPackageInputs } from './localPackageInputs.js'

class FixturePackage extends LocalClientPackage {
  builds = 0
  onBuild: (snapshot: string, release: string) => Promise<void>

  constructor(root: string) {
    super(root)
    this.onBuild = async () => {}
  }

  protected override async packageSnapshot(snapshot: string, release: string): Promise<void> {
    this.builds++
    await this.onBuild(snapshot, release)
    for (const path of ['Jamat.exe', 'resources/app.asar', 'resources/host/start.cjs',
      'resources/remarkable-sidecar/manifest.json',
      ...['node.exe', 'launcher.cjs', 'install-launcher.ps1', 'package.json', 'README.md',
        'LICENSE', 'NODE-LICENSE.txt', 'WS-LICENSE.txt'].map(name => `resources/launcher/${name}`)])
      write(join(release, 'win-unpacked', path), `build-${this.builds}`)
  }
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'jamat local package '))
  for (const path of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json',
    'LICENSE', 'app-client-ui/app/app.ts', 'app-client-ui/preload/index.ts',
    'app-client-ui/renderer/index.html', 'app-client-ui/shared/types.ts',
    'app-client-ui/buildResources/icon.ico', 'app-client-ui/start.ts',
    'app-client-ui/package.json', 'app-client-ui/pnpm-lock.yaml',
    'app-client-ui/pnpm-workspace.yaml', 'app-client-ui/electron.vite.config.ts',
    'app-client-ui/tsconfig.json', 'app-client-ui/tsconfig.node.json',
    'app-client-ui/tsconfig.web.json', 'app-host/start.ts', 'app-host/pnpm-lock.yaml',
    'app-launcher/start.ts', 'app-launcher/app/app.ts', 'app-launcher/package.json',
    'app-launcher/README.md',
    'lib-orchestrator/index.ts', 'lib-orchestrator/pnpm-lock.yaml',
    'mdext-renderer/renderer/index.ts', 'configs/remarkable-sidecar/package-lock.json',
    'configs/remarkable-sidecar/manifest.json',
    'scripts/release/prepare-host-bundle.ts', 'scripts/release/prepare-launcher.ts',
    'scripts/release/start-packaged-client.ts', 'scripts/setup/prepare-remarkable-sidecar.ts',
    'scripts/setup/install-launcher.ps1'])
    write(join(root, path), path)
  for (const directory of ['', 'app-client-ui', 'app-host', 'lib-orchestrator'])
    write(join(root, directory, 'node_modules', 'sentinel'), 'installed dependency')
  write(join(root, 'app-client-ui', 'out', 'main', 'start.js'), 'live client')
  write(join(root, 'out', 'host-bundle', 'current', 'start.cjs'), 'live host')
  return root
}

function dispose(root: string): void {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

test('content hashes detect backdated edits, additions, deletions and dependency locks', () => {
  const root = fixture()
  try {
    const initial = LocalPackageInputs.read(root).hash
    const input = join(root, 'app-client-ui', 'app', 'app.ts')
    writeFileSync(input, 'edited source')
    utimesSync(input, 1, 1)
    assert.notEqual(LocalPackageInputs.read(root).hash, initial)
    writeFileSync(input, 'app-client-ui/app/app.ts')
    assert.equal(LocalPackageInputs.read(root).hash, initial)
    const added = join(root, 'lib-orchestrator', 'added.ts')
    write(added, 'new module')
    const withAdded = LocalPackageInputs.read(root).hash
    assert.notEqual(withAdded, initial)
    rmSync(added)
    assert.equal(LocalPackageInputs.read(root).hash, initial)
    for (const path of ['pnpm-lock.yaml', 'app-client-ui/pnpm-lock.yaml',
      'app-host/pnpm-lock.yaml', 'lib-orchestrator/pnpm-lock.yaml',
      'configs/remarkable-sidecar/package-lock.json']) {
      write(join(root, path), 'changed lock')
      assert.notEqual(LocalPackageInputs.read(root).hash, initial, path)
      write(join(root, path), path)
    }
    write(join(root, 'app-client-ui/app/app.test.ts'), 'test only')
    write(join(root, 'app-host/out/generated.js'), 'generated')
    write(join(root, 'app-client-ui/dist/local-releases/old/Jamat.exe'), 'older artifact')
    assert.equal(LocalPackageInputs.read(root).hash, initial)
  } finally { dispose(root) }
})

test('launcher source, runtime recipe, setup and documentation invalidate captured inputs', () => {
  const root = fixture()
  try {
    const initial = LocalPackageInputs.read(root).hash
    for (const path of ['app-launcher/start.ts', 'app-launcher/app/app.ts', 'app-launcher/package.json',
      'app-launcher/README.md', 'scripts/setup/install-launcher.ps1',
      'scripts/release/prepare-launcher.ts', 'scripts/release/start-packaged-client.ts',
      'configs/remarkable-sidecar/manifest.json']) {
      write(join(root, path), 'changed launcher input')
      assert.notEqual(LocalPackageInputs.read(root).hash, initial, path)
      write(join(root, path), path)
      assert.equal(LocalPackageInputs.read(root).hash, initial, path)
    }
    write(join(root, 'app-launcher/app/app.test.ts'), 'test only')
    assert.equal(LocalPackageInputs.read(root).hash, initial)
  } finally { dispose(root) }
})

test('builds from captured bytes and keeps live output and successful releases unchanged', async () => {
  const root = fixture()
  try {
    const builder = new FixturePackage(root)
    builder.onBuild = async (snapshot) => {
      assert.equal(readFileSync(join(snapshot, 'app-client-ui/app/app.ts'), 'utf8'),
        readFileSync(join(root, 'app-client-ui/app/app.ts'), 'utf8'))
      assert.equal(readFileSync(join(snapshot, 'scripts/setup/install-launcher.ps1'), 'utf8'),
        readFileSync(join(root, 'scripts/setup/install-launcher.ps1'), 'utf8'))
      assert.equal(readFileSync(join(snapshot, 'app-launcher/start.ts'), 'utf8'),
        readFileSync(join(root, 'app-launcher/start.ts'), 'utf8'))
      write(join(snapshot, 'app-client-ui/out/main/start.js'), 'new client')
      write(join(snapshot, 'out/host-bundle/current/start.cjs'), 'new host')
    }
    const first = await builder.ensure()
    assert.deepEqual(await builder.ensure(), first)
    assert.equal(builder.builds, 1)
    write(join(root, 'app-client-ui/app/app.ts'), 'new source')
    const second = await builder.ensure()
    assert.notEqual(second.executablePath, first.executablePath)
    assert.equal(readFileSync(first.executablePath, 'utf8'), 'build-1')
    assert.equal(readFileSync(second.executablePath, 'utf8'), 'build-2')
    assert.equal(readFileSync(join(root, 'app-client-ui/out/main/start.js'), 'utf8'), 'live client')
    assert.equal(readFileSync(join(root, 'out/host-bundle/current/start.cjs'), 'utf8'), 'live host')
    for (const directory of ['', 'app-client-ui', 'app-host', 'lib-orchestrator'])
      assert.equal(readFileSync(join(root, directory, 'node_modules/sentinel'), 'utf8'), 'installed dependency')
    assert.deepEqual(readdirSync(join(root, 'out')).filter((name) => name.startsWith('.pkg-')), [])
  } finally { dispose(root) }
})

test('a failed build preserves the previous manifest and artifact and reports failure', async () => {
  const root = fixture()
  try {
    const builder = new FixturePackage(root)
    const first = await builder.ensure()
    const currentFile = join(root, 'app-client-ui/dist/local-releases/current.json')
    const current = readFileSync(currentFile, 'utf8')
    write(join(root, 'app-client-ui/start.ts'), 'changed')
    builder.onBuild = async () => { throw new Error('compiler failed') }
    await assert.rejects(builder.ensure(), /compiler failed/)
    assert.equal(readFileSync(currentFile, 'utf8'), current)
    assert.equal(readFileSync(first.executablePath, 'utf8'), 'build-1')
    assert.equal(existsSync(join(root, 'app-client-ui/dist/local-releases/build.lock')), false)
    assert.deepEqual(readdirSync(join(root, 'out')).filter((name) => name.startsWith('.pkg-')), [])
  } finally { dispose(root) }
})

test('an edit during a build cannot publish a stale snapshot as current', async () => {
  const root = fixture()
  try {
    const builder = new FixturePackage(root)
    const first = await builder.ensure()
    write(join(root, 'app-client-ui/start.ts'), 'before build')
    builder.onBuild = async (snapshot) => {
      write(join(root, 'app-client-ui/start.ts'), 'during build')
      assert.equal(readFileSync(join(snapshot, 'app-client-ui/start.ts'), 'utf8'), 'before build')
    }
    await assert.rejects(builder.ensure(), /inputs changed during the build/)
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'app-client-ui/dist/local-releases/current.json'), 'utf8')), first)
    builder.onBuild = async () => {}
    const current = await builder.ensure()
    assert.equal(current.inputHash, LocalPackageInputs.read(root).hash)
  } finally { dispose(root) }
})

test('concurrent callers share the filesystem lock and only build once', async () => {
  const root = fixture()
  try {
    const first = new FixturePackage(root)
    const second = new FixturePackage(root)
    first.onBuild = async () => { await setTimeout(350) }
    const [left, right] = await Promise.all([first.ensure(), second.ensure()])
    assert.deepEqual(left, right)
    assert.equal(first.builds + second.builds, 1)
    assert.equal(existsSync(join(root, 'app-client-ui/dist/local-releases/build.lock')), false)
  } finally { dispose(root) }
})

test('missing packaged resources trigger a new immutable release', async () => {
  const root = fixture()
  try {
    const builder = new FixturePackage(root)
    const first = await builder.ensure()
    rmSync(join(dirname(first.executablePath), 'resources/host/start.cjs'))
    const second = await builder.ensure()
    assert.notEqual(second.executablePath, first.executablePath)
    assert.equal(builder.builds, 2)
  } finally { dispose(root) }
})

test('every missing launcher resource forces a new immutable release', async () => {
  const root = fixture()
  try {
    const builder = new FixturePackage(root)
    let current = await builder.ensure()
    for (const name of ['node.exe', 'launcher.cjs', 'install-launcher.ps1', 'package.json',
      'README.md', 'LICENSE', 'NODE-LICENSE.txt', 'WS-LICENSE.txt']) {
      rmSync(join(dirname(current.executablePath), 'resources/launcher', name))
      const next = await builder.ensure()
      assert.notEqual(next.executablePath, current.executablePath, name)
      assert.equal(existsSync(join(dirname(next.executablePath), 'resources/launcher', name)), true, name)
      current = next
    }
    assert.equal(builder.builds, 9)
  } finally { dispose(root) }
})
