import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { PlatformSettingsValue } from './projectSetup.types'
import { ProjectSetupManager } from './projectSetupManager'
import { SetupFamilies } from './setupFamilies'

describe('lib-orchestrator/projectSetup/projectSetupManager', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function temporaryDirectory(prefix: string): string {
    const directory = mkdtempSync(join(tmpdir(), prefix))
    created.push(directory)
    return directory
  }

  /** Keys are repository-relative paths; a file whose content does not matter can be empty. */
  function repository(files: Record<string, string>): string {
    const root = temporaryDirectory('jamat-v3-setup-repo-')
    for (const [name, content] of Object.entries(files)) {
      const file = join(root, name)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, content, 'utf8')
    }
    return root
  }

  interface Harness {
    manager: ProjectSetupManager
    reports: string[]
    trustFile: string
  }

  function harness(settings?: PlatformSettingsValue): Harness {
    const reports: string[] = []
    const trustFile = join(temporaryDirectory('jamat-v3-setup-state-'), 'setup-trust.json')
    return {
      manager: new ProjectSetupManager({
        trustFile,
        platformSettingsOf: () => settings ?? SetupFamilies.defaultPlatformSettings(),
        report: (message) => reports.push(message),
      }),
      reports,
      trustFile,
    }
  }

  it('lets .worktree.json outrank everything the detectors would have said', async () => {
    const root = repository({
      'package.json': '{}',
      'pnpm-lock.yaml': '',
      '.worktree.json': JSON.stringify({ setup: ['./bootstrap.sh', 'pnpm install'] }),
    })
    expect(await harness().manager.resolve(root, root)).toEqual({
      kind: 'setup',
      origin: 'project',
      steps: [
        { command: './bootstrap.sh', cwd: '' },
        { command: 'pnpm install', cwd: '' },
      ],
    })
  })

  /*
   * `SetupStep.cwd` says it is repository-relative, and this is where that is decided. A project that
   * is not under the repository its worktree was cut from has no directory inside that worktree at
   * all: a bare `relative()` answers `../..`, and a step carrying it would be joined onto the worktree
   * and run in the real checkout instead.
   */
  it('refuses a project that sits outside the repository it is resolved against', async () => {
    const project = repository({ 'package.json': '{}' })
    const elsewhere = repository({})

    const resolution = await harness().manager.resolve(project, elsewhere)

    expect(resolution.kind).toBe('none')
    expect(resolution).toMatchObject({ reason: expect.stringContaining('is not inside the repository') })
  })

  it('reads an explicit empty setup as the project opting out', async () => {
    const root = repository({ 'package.json': '{}', '.worktree.json': JSON.stringify({ setup: [] }) })
    expect(await harness().manager.resolve(root, root)).toEqual({ kind: 'empty' })
  })

  it('refuses to detect past a .worktree.json it could not read', async () => {
    const root = repository({ 'package.json': '{}', '.worktree.json': '{ "setup": [' })
    const resolution = await harness().manager.resolve(root, root)
    expect(resolution.kind).toBe('none')
    expect(resolution).toMatchObject({ reason: expect.stringContaining('not valid JSON') })
  })

  it('composes one step per family, in the order the detectors are held in', async () => {
    const root = repository({ 'package.json': '{}', 'pyproject.toml': '[tool.uv]\n' })
    expect(await harness().manager.resolve(root, root)).toEqual({
      kind: 'setup',
      origin: 'machine',
      steps: [
        { command: 'npm install', cwd: '' },
        { command: 'uv sync', cwd: '' },
      ],
    })
  })

  // Half an install is a worktree that is broken quietly.
  it('lets one ambiguous family fail the whole resolution', async () => {
    const root = repository({
      'package.json': '{}',
      'pnpm-lock.yaml': '',
      'yarn.lock': '',
      'pyproject.toml': '[tool.uv]\n',
    })
    const resolution = await harness().manager.resolve(root, root)
    expect(resolution).toEqual({ kind: 'none', reason: expect.stringContaining('node: ') })
  })

  it('gives a project below the root its repository-relative directory', async () => {
    const root = repository({ 'apps/web/package.json': '{}' })
    expect(await harness().manager.resolve(join(root, 'apps', 'web'), root)).toEqual({
      kind: 'setup',
      origin: 'machine',
      steps: [{ command: 'npm install', cwd: 'apps/web' }],
    })
  })

  it('installs pnpm plainly until this machine says otherwise', async () => {
    const root = repository({ 'package.json': '{}', 'pnpm-lock.yaml': '' })
    expect(await harness().manager.resolve(root, root)).toMatchObject({
      steps: [{ command: 'pnpm install' }],
    })
  })

  it('switches the pnpm command over to the global virtual store on request', async () => {
    const root = repository({ 'package.json': '{}', 'pnpm-lock.yaml': '' })
    const { manager } = harness({ node: { pnpm: { globalVirtualStore: true } } })
    expect(await manager.resolve(root, root)).toMatchObject({
      steps: [{ command: 'pnpm install --config.enableGlobalVirtualStore=true' }],
    })
  })

  it('names .worktree.json when it recognised nothing at all', async () => {
    const root = repository({ 'readme.md': '# nothing to install\n' })
    const resolution = await harness().manager.resolve(root, root)
    expect(resolution.kind).toBe('none')
    expect(resolution).toMatchObject({ reason: expect.stringContaining('.worktree.json') })
  })

  it('reaches the same rust and go defaults through the manager', async () => {
    const rust = repository({ 'Cargo.toml': '[package]\nname = "x"\n' })
    const go = repository({ 'go.mod': 'module example.com/x\n' })
    expect(await harness().manager.resolve(rust, rust)).toMatchObject({
      steps: [{ command: 'cargo fetch' }],
    })
    expect(await harness().manager.resolve(go, go)).toMatchObject({
      steps: [{ command: 'go mod download' }],
    })
  })

  /* This class never writes: a detection is this build's opinion, and writing it back would turn it
     into the project's. Writing `setup` at all is `WorktreeConfig`'s, and only when somebody asks. */
  it('writes nothing into the project, whatever it concluded about it', async () => {
    const root = repository({ '.worktree.json': JSON.stringify({ dev: 'pnpm dev' }) })
    const { manager } = harness()

    expect(await manager.resolve(root, root)).toMatchObject({ kind: 'none' })
    expect(JSON.parse(readFileSync(join(root, '.worktree.json'), 'utf8')))
      .toEqual({ dev: 'pnpm dev' })
  })

  describe('what the project itself declares', () => {
    it('answers with the commands and a hash, unacknowledged until somebody says so', async () => {
      const root = repository({ '.worktree.json': JSON.stringify({ setup: ['./bootstrap.sh'] }) })
      const { manager } = harness()

      const declared = await manager.declaredSetup(root)
      expect(declared?.commands).toEqual(['./bootstrap.sh'])
      expect(declared?.acknowledged).toBe(false)

      manager.acknowledgeSetup(root, declared?.hash ?? '')
      expect((await manager.declaredSetup(root))?.acknowledged).toBe(true)
    })

    /* The whole point of hashing the commands rather than the file: a project that reformats its
       config has not changed what it runs, and being asked again would teach people to click through. */
    it('keeps an agreement across a reformat of the file', async () => {
      const root = repository({ '.worktree.json': JSON.stringify({ setup: ['a', 'b'] }) })
      const { manager } = harness()
      manager.acknowledgeSetup(root, (await manager.declaredSetup(root))?.hash ?? '')

      writeFileSync(
        join(root, '.worktree.json'),
        JSON.stringify({ dev: 'pnpm dev', setup: ['a', 'b'] }, null, 4),
        'utf8',
      )

      expect((await manager.declaredSetup(root))?.acknowledged).toBe(true)
    })

    // Order decides what runs when, so it is part of what was agreed to.
    it('withdraws the agreement when a command or its order moves', async () => {
      const root = repository({ '.worktree.json': JSON.stringify({ setup: ['a', 'b'] }) })
      const { manager } = harness()
      manager.acknowledgeSetup(root, (await manager.declaredSetup(root))?.hash ?? '')

      writeFileSync(join(root, '.worktree.json'), JSON.stringify({ setup: ['b', 'a'] }), 'utf8')

      expect((await manager.declaredSetup(root))?.acknowledged).toBe(false)
    })

    it('has nothing to ask about when the project declares no setup of its own', async () => {
      const { manager } = harness()
      expect(await manager.declaredSetup(repository({ 'package.json': '{}' }))).toBe(null)
      expect(await manager.declaredSetup(repository({
        '.worktree.json': JSON.stringify({ setup: [] }),
      }))).toBe(null)
      // A file that cannot be read cannot be agreed to either; `resolve` is where that refusal lives.
      expect(await manager.declaredSetup(repository({ '.worktree.json': '{ "setup": [' }))).toBe(null)
    })

    it('remembers an agreement in a file a second manager reads', async () => {
      const root = repository({ '.worktree.json': JSON.stringify({ setup: ['./bootstrap.sh'] }) })
      const first = harness()
      first.manager.acknowledgeSetup(root, (await first.manager.declaredSetup(root))?.hash ?? '')

      const second = new ProjectSetupManager({
        trustFile: first.trustFile,
        platformSettingsOf: () => SetupFamilies.defaultPlatformSettings(),
      })

      expect((await second.declaredSetup(root))?.acknowledged).toBe(true)
    })
  })
})
