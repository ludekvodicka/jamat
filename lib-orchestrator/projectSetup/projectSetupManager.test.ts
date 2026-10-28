import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { PlatformSettingsValue } from './projectSetup.types'
import { ProjectSetupManager } from './projectSetupManager'
import { SetupFamilies } from './setupFamilies'
import { WorktreeConfig } from './worktreeConfig'

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

  function harness(settings?: PlatformSettingsValue): { manager: ProjectSetupManager } {
    return {
      manager: new ProjectSetupManager({
        platformSettingsOf: () => settings ?? SetupFamilies.defaultPlatformSettings(),
      }),
    }
  }

  async function resolved(manager: ProjectSetupManager, projectRoot: string, repositoryRoot: string) {
    return manager.resolve(projectRoot, repositoryRoot, await WorktreeConfig.read(projectRoot))
  }

  it('lets .worktree.json outrank everything the detectors would have said', async () => {
    const root = repository({
      'package.json': '{}',
      'pnpm-lock.yaml': '',
      '.worktree.json': JSON.stringify({ setup: ['./bootstrap.sh', 'pnpm install'] }),
    })
    expect(await resolved(harness().manager, root, root)).toEqual({
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

    const resolution = await resolved(harness().manager, project, elsewhere)

    expect(resolution.kind).toBe('none')
    expect(resolution).toMatchObject({ reason: expect.stringContaining('is not inside the repository') })
  })

  it('reads an explicit empty setup as the project opting out', async () => {
    const root = repository({ 'package.json': '{}', '.worktree.json': JSON.stringify({ setup: [] }) })
    expect(await resolved(harness().manager, root, root)).toEqual({ kind: 'empty' })
  })

  it('refuses to detect past a .worktree.json it could not read', async () => {
    const root = repository({ 'package.json': '{}', '.worktree.json': '{ "setup": [' })
    const resolution = await resolved(harness().manager, root, root)
    expect(resolution.kind).toBe('none')
    expect(resolution).toMatchObject({ reason: expect.stringContaining('not valid JSON') })
  })

  it('composes one step per family, in the order the detectors are held in', async () => {
    const root = repository({ 'package.json': '{}', 'pyproject.toml': '[tool.uv]\n' })
    expect(await resolved(harness().manager, root, root)).toEqual({
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
    const resolution = await resolved(harness().manager, root, root)
    expect(resolution).toEqual({ kind: 'none', reason: expect.stringContaining('node: ') })
  })

  it('gives a project below the root its repository-relative directory', async () => {
    const root = repository({ 'apps/web/package.json': '{}' })
    expect(await resolved(harness().manager, join(root, 'apps', 'web'), root)).toEqual({
      kind: 'setup',
      origin: 'machine',
      steps: [{ command: 'npm install', cwd: 'apps/web' }],
    })
  })

  it('installs pnpm plainly until this machine says otherwise', async () => {
    const root = repository({ 'package.json': '{}', 'pnpm-lock.yaml': '' })
    expect(await resolved(harness().manager, root, root)).toMatchObject({
      steps: [{ command: 'pnpm install' }],
    })
  })

  it('switches the pnpm command over to the global virtual store on request', async () => {
    const root = repository({ 'package.json': '{}', 'pnpm-lock.yaml': '' })
    const { manager } = harness({ node: { pnpm: { globalVirtualStore: true } } })
    expect(await resolved(manager, root, root)).toMatchObject({
      steps: [{ command: 'pnpm install --config.enableGlobalVirtualStore=true' }],
    })
  })

  it('names .worktree.json when it recognised nothing at all', async () => {
    const root = repository({ 'readme.md': '# nothing to install\n' })
    const resolution = await resolved(harness().manager, root, root)
    expect(resolution.kind).toBe('none')
    expect(resolution).toMatchObject({ reason: expect.stringContaining('.worktree.json') })
  })

  it('reaches the same rust and go defaults through the manager', async () => {
    const rust = repository({ 'Cargo.toml': '[package]\nname = "x"\n' })
    const go = repository({ 'go.mod': 'module example.com/x\n' })
    expect(await resolved(harness().manager, rust, rust)).toMatchObject({
      steps: [{ command: 'cargo fetch' }],
    })
    expect(await resolved(harness().manager, go, go)).toMatchObject({
      steps: [{ command: 'go mod download' }],
    })
  })

  /*
   * An SVN worktree of a product group checks out the whole group, whose root is no project of its
   * own. Found on session 045 of the Mirabia group: `setup skipped`, and no member had node_modules.
   */
  describe('a product group root', () => {
    const pnpmMember = { 'package.json': '{}', 'pnpm-lock.yaml': '' }

    function group(members: Record<string, Record<string, string>>, own: Record<string, string> = {}): string {
      const files: Record<string, string> = { '.appgroup': '{"kind":"product"}', ...own }
      for (const [member, memberFiles] of Object.entries(members))
        for (const [name, content] of Object.entries(memberFiles))
          files[`${member}/${name}`] = content
      return repository(files)
    }

    it('installs each member that has a manifest, in name order', async () => {
      const root = group({ B: pnpmMember, A: pnpmMember, docs: { 'readme.md': '# no manifest\n' } })
      expect(await resolved(harness().manager, root, root)).toEqual({
        kind: 'setup',
        origin: 'machine',
        steps: [
          { command: 'pnpm install', cwd: 'A' },
          { command: 'pnpm install', cwd: 'B' },
        ],
      })
    })

    it('keeps the group directory in each member path when the group sits below the repository root', async () => {
      const root = repository({ 'Group/.appgroup': '{"kind":"product"}', 'Group/A/package.json': '{}', 'Group/A/pnpm-lock.yaml': '' })
      expect(await resolved(harness().manager, join(root, 'Group'), root)).toMatchObject({
        steps: [{ command: 'pnpm install', cwd: 'Group/A' }],
      })
    })

    it('installs only a root that has a manifest of its own, members unscanned', async () => {
      const root = group({ A: pnpmMember }, { 'package.json': '{}', 'pnpm-lock.yaml': '' })
      expect(await resolved(harness().manager, root, root)).toEqual({
        kind: 'setup',
        origin: 'machine',
        steps: [{ command: 'pnpm install', cwd: '' }],
      })
    })

    it('runs the setup its .worktree.json declares instead of the members', async () => {
      const root = group({ A: pnpmMember }, { '.worktree.json': JSON.stringify({ setup: ['./install-all.sh'] }) })
      expect(await resolved(harness().manager, root, root)).toEqual({
        kind: 'setup',
        origin: 'project',
        steps: [{ command: './install-all.sh', cwd: '' }],
      })
    })

    it('scans no members of a directory without the group marker', async () => {
      const root = repository({ 'A/package.json': '{}', 'A/pnpm-lock.yaml': '' })
      const resolution = await resolved(harness().manager, root, root)
      expect(resolution.kind).toBe('none')
      expect(resolution).toMatchObject({ reason: expect.stringContaining('no known project family detected') })
    })

    it('lets one ambiguous member fail the whole group, naming that member', async () => {
      const root = group({ A: pnpmMember, B: { 'package.json': '{}', 'pnpm-lock.yaml': '', 'yarn.lock': '' } })
      const resolution = await resolved(harness().manager, root, root)
      expect(resolution).toEqual({ kind: 'none', reason: expect.stringContaining('member B: node: ') })
    })

    it('scans no dot directory and no node_modules', async () => {
      const root = group({
        '.private': pnpmMember,
        '.worktrees': pnpmMember,
        node_modules: pnpmMember,
        A: pnpmMember,
      })
      expect(await resolved(harness().manager, root, root)).toMatchObject({
        steps: [{ command: 'pnpm install', cwd: 'A' }],
      })
    })

    it('says nothing was detected when no member has a manifest', async () => {
      const root = group({ data: { 'readme.md': '# no manifest\n' } })
      const resolution = await resolved(harness().manager, root, root)
      expect(resolution).toEqual({ kind: 'none', reason: expect.stringContaining('.worktree.json') })
    })

    it('installs a workspace two members share once, from its root', async () => {
      const root = group({ A: { 'package.json': '{}' }, B: { 'package.json': '{}' } }, {
        'pnpm-workspace.yaml': 'packages:\n  - A\n  - B\n',
      })
      expect(await resolved(harness().manager, root, root)).toEqual({
        kind: 'setup',
        origin: 'machine',
        steps: [{ command: 'pnpm install', cwd: '' }],
      })
    })
  })

  /* This class never writes: a detection is this build's opinion, and writing it back would turn it
     into the project's. Writing `setup` at all is `WorktreeConfig`'s, and only when somebody asks. */
  it('writes nothing into the project, whatever it concluded about it', async () => {
    const root = repository({ '.worktree.json': JSON.stringify({ dev: 'pnpm dev' }) })
    const { manager } = harness()

    expect(await resolved(manager, root, root)).toMatchObject({ kind: 'none' })
    expect(JSON.parse(readFileSync(join(root, '.worktree.json'), 'utf8')))
      .toEqual({ dev: 'pnpm dev' })
  })

  it.each(['', '{"kind":"collection"}'])('never installs sibling apps for a collection marker %j', async (marker) => {
    const root = repository({ '.appgroup': marker, 'A/package.json': '{}', 'B/package.json': '{}' })
    const manager = harness().manager
    expect(await resolved(manager, root, root)).toMatchObject({ kind: 'none' })
    expect(await resolved(manager, join(root, 'A'), join(root, 'A')))
      .toMatchObject({ steps: [{ command: 'npm install', cwd: '' }] })
  })

  it('keeps a recorded member setup after migration and a recorded project setup after reclassification', async () => {
    const root = repository({ '.appgroup': '{"kind":"collection"}', 'A/package.json': '{}' })
    const manager = harness().manager
    expect(await manager.resolve(root, root, await WorktreeConfig.read(root), 'members'))
      .toMatchObject({ steps: [{ command: 'npm install', cwd: 'A' }] })
    writeFileSync(join(root, '.appgroup'), '{"kind":"product"}')
    expect(await manager.resolve(root, root, await WorktreeConfig.read(root), 'project')).toMatchObject({ kind: 'none' })
  })

  it('refuses malformed group metadata before any automatic setup', async () => {
    const root = repository({ '.appgroup': '{', 'package.json': '{}', 'A/package.json': '{}' })
    expect(await resolved(harness().manager, root, root))
      .toMatchObject({ kind: 'none', reason: expect.stringContaining('not valid JSON') })
  })
})
