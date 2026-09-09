import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { NodeSetupDetector } from './nodeSetupDetector'

describe('lib-orchestrator/projectSetup/detectors/nodeSetupDetector', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function temporaryRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-node-setup-'))
    created.push(root)
    return root
  }

  /** Keys are repository-relative paths; a file whose content does not matter can be empty. */
  function repository(files: Record<string, string>): string {
    const root = temporaryRoot()
    for (const [name, content] of Object.entries(files)) {
      const file = join(root, name)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, content, 'utf8')
    }
    return root
  }

  const detector = new NodeSetupDetector()

  it('lets the packageManager field decide over every lockfile', async () => {
    const root = repository({
      'package.json': JSON.stringify({ packageManager: 'pnpm@11.15.1' }),
      'package-lock.json': '{}',
      'yarn.lock': '',
    })
    expect(await detector.detect(root, root)).toEqual({ kind: 'tool', toolId: 'node-pnpm' })
  })

  it('maps a lone lockfile to the tool that wrote it', async () => {
    const pnpm = repository({ 'package.json': '{}', 'pnpm-lock.yaml': '' })
    const npm = repository({ 'package.json': '{}', 'package-lock.json': '{}' })
    const yarn = repository({ 'package.json': '{}', 'yarn.lock': '' })
    expect(await detector.detect(pnpm, pnpm)).toEqual({ kind: 'tool', toolId: 'node-pnpm' })
    expect(await detector.detect(npm, npm)).toEqual({ kind: 'tool', toolId: 'node-npm' })
    expect(await detector.detect(yarn, yarn)).toEqual({ kind: 'tool', toolId: 'node-yarn' })
  })

  // Installing with the wrong one writes a second lockfile and resolves a different tree.
  it('refuses to choose between two lockfiles nothing declared', async () => {
    const root = repository({ 'package.json': '{}', 'pnpm-lock.yaml': '', 'yarn.lock': '' })
    const detection = await detector.detect(root, root)
    expect(detection?.kind).toBe('ambiguous')
    expect(detection).toMatchObject({ reason: expect.stringContaining('pnpm-lock.yaml + yarn.lock') })
    expect(detection).toMatchObject({ reason: expect.stringContaining('.worktree.json') })
  })

  it('falls back to npm when neither a field nor a lockfile says anything', async () => {
    const root = repository({ 'package.json': '{}' })
    expect(await detector.detect(root, root)).toEqual({ kind: 'tool', toolId: 'node-npm' })
  })

  it('has nothing to say without a package.json, lockfile or not', async () => {
    const empty = temporaryRoot()
    const stray = repository({ 'pnpm-lock.yaml': '' })
    expect(await detector.detect(empty, empty)).toBeNull()
    expect(await detector.detect(stray, stray)).toBeNull()
  })

  /**
   * The member carries neither the field nor a lockfile, because a real one does not: both sit at
   * the workspace root. Decide without reading the workspace file and this is an `npm install` in a
   * directory pnpm owns - which fails outright on the `workspace:` dependency, and on a package
   * without one writes a `package-lock.json` and a `node_modules` the project never resolved.
   */
  it('installs a pnpm workspace member from the workspace root above it', async () => {
    const root = repository({
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
      'pnpm-lock.yaml': '',
      'package.json': JSON.stringify({ packageManager: 'pnpm@11.15.1' }),
      'packages/api/package.json': JSON.stringify({ dependencies: { shared: 'workspace:*' } }),
    })
    expect(await detector.detect(join(root, 'packages', 'api'), root))
      .toEqual({ kind: 'tool', toolId: 'node-pnpm', installCwd: '' })
  })

  it('reports the workspace root as a repository-relative directory', async () => {
    const root = repository({
      'apps/pnpm-workspace.yaml': 'packages:\n  - web\n',
      'apps/web/package.json': '{}',
    })
    expect(await detector.detect(join(root, 'apps', 'web'), root))
      .toEqual({ kind: 'tool', toolId: 'node-pnpm', installCwd: 'apps' })
  })

  // Two answers, neither of them declared: installing with either one is a guess against the other.
  it('refuses a lockfile that contradicts the workspace it sits in', async () => {
    const root = repository({
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
      'packages/api/package.json': '{}',
      'packages/api/package-lock.json': '{}',
    })
    const detection = await detector.detect(join(root, 'packages', 'api'), root)
    expect(detection?.kind).toBe('ambiguous')
    expect(detection).toMatchObject({ reason: expect.stringContaining('package-lock.json') })
    expect(detection).toMatchObject({ reason: expect.stringContaining('pnpm-workspace.yaml') })
  })

  // A workspace outside the repository belongs to a tree this worktree will never contain.
  it('stops the workspace walk at the repository root', async () => {
    const outer = temporaryRoot()
    writeFileSync(join(outer, 'pnpm-workspace.yaml'), 'packages:\n  - repo/*\n', 'utf8')
    const root = join(outer, 'repo')
    mkdirSync(root)
    writeFileSync(join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@11' }), 'utf8')
    expect(await detector.detect(root, root)).toEqual({ kind: 'tool', toolId: 'node-pnpm' })
  })

  /*
   * npm and yarn declare a workspace in the root manifest, so their members carry no marker at all:
   * no field, no lockfile and no file above them this detector used to look for. Asking only about
   * `pnpm-workspace.yaml` answered `npm` in the member's own directory for every one of them - the
   * same bug the pnpm rule exists to prevent, in a second family.
   */
  it('installs an npm workspace member from the root that declares it', async () => {
    const root = repository({
      'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
      'package-lock.json': '{}',
      'packages/api/package.json': '{}',
    })
    expect(await detector.detect(join(root, 'packages', 'api'), root))
      .toEqual({ kind: 'tool', toolId: 'node-npm', installCwd: '' })
  })

  it('reads the yarn spelling of the same field, object form included', async () => {
    const root = repository({
      'package.json': JSON.stringify({ workspaces: { packages: ['apps/*'] } }),
      'yarn.lock': '',
      'apps/web/package.json': '{}',
    })
    expect(await detector.detect(join(root, 'apps', 'web'), root))
      .toEqual({ kind: 'tool', toolId: 'node-yarn', installCwd: '' })
  })

  it('lets the workspace root declare its own package manager', async () => {
    const root = repository({
      'package.json': JSON.stringify({ workspaces: ['packages/*'], packageManager: 'yarn@4.9.2' }),
      'packages/api/package.json': '{}',
    })
    expect(await detector.detect(join(root, 'packages', 'api'), root))
      .toEqual({ kind: 'tool', toolId: 'node-yarn', installCwd: '' })
  })

  // The same refusal the pnpm workspace gets, for the same reason: two answers, neither declared.
  it('refuses a member lockfile that contradicts the manifest workspace above it', async () => {
    const root = repository({
      'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
      'package-lock.json': '{}',
      'packages/api/package.json': '{}',
      'packages/api/yarn.lock': '',
    })
    const detection = await detector.detect(join(root, 'packages', 'api'), root)
    expect(detection?.kind).toBe('ambiguous')
    expect(detection).toMatchObject({ reason: expect.stringContaining('yarn.lock') })
    expect(detection).toMatchObject({ reason: expect.stringContaining('package.json') })
  })

  it('refuses a workspace root that contradicts itself', async () => {
    const root = repository({
      'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
      'package-lock.json': '{}',
      'yarn.lock': '',
      'packages/api/package.json': '{}',
    })
    const detection = await detector.detect(join(root, 'packages', 'api'), root)
    expect(detection?.kind).toBe('ambiguous')
    expect(detection).toMatchObject({
      reason: expect.stringContaining('does not say which package manager'),
    })
  })

  // A repository carrying both is a pnpm repository whose manifest still says what npm would do.
  it('lets pnpm-workspace.yaml win over a workspaces field in the same directory', async () => {
    const root = repository({
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
      'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
      'packages/api/package.json': '{}',
    })
    expect(await detector.detect(join(root, 'packages', 'api'), root))
      .toEqual({ kind: 'tool', toolId: 'node-pnpm', installCwd: '' })
  })

  it('is not a workspace member just because a manifest sits above it', async () => {
    const root = repository({
      'package.json': JSON.stringify({ name: 'root' }),
      'packages/api/package.json': '{}',
    })
    expect(await detector.detect(join(root, 'packages', 'api'), root))
      .toEqual({ kind: 'tool', toolId: 'node-npm' })
  })

  /* A neighbour's damaged manifest is not this project's ambiguity: it is simply not a marker. The
     project's own unreadable manifest is refused, which is a different rule and a different file. */
  it('walks past an ancestor manifest it cannot parse', async () => {
    const root = repository({
      'package.json': '{ "workspaces": [',
      'packages/api/package.json': '{}',
    })
    expect(await detector.detect(join(root, 'packages', 'api'), root))
      .toEqual({ kind: 'tool', toolId: 'node-npm' })
  })

  it('leaves the workspace file alone for the tools that do not use it', async () => {
    const root = repository({
      'pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
      'apps/web/package.json': JSON.stringify({ packageManager: 'yarn@4.9.2' }),
    })
    expect(await detector.detect(join(root, 'apps', 'web'), root))
      .toEqual({ kind: 'tool', toolId: 'node-yarn' })
  })

  it('refuses a declared package manager it cannot install with', async () => {
    const root = repository({ 'package.json': JSON.stringify({ packageManager: 'bun@1.2.3' }) })
    const detection = await detector.detect(root, root)
    expect(detection?.kind).toBe('ambiguous')
    expect(detection).toMatchObject({ reason: expect.stringContaining('bun@1.2.3') })
  })

  it('refuses a package.json it cannot read instead of passing it by', async () => {
    const root = repository({ 'package.json': '{ "name":' })
    const detection = await detector.detect(root, root)
    expect(detection?.kind).toBe('ambiguous')
    expect(detection).toMatchObject({ reason: expect.stringContaining('could not be read') })
  })

  it('ignores a directory that carries a manifest name', async () => {
    const root = temporaryRoot()
    mkdirSync(join(root, 'package.json'))
    expect(await detector.detect(root, root)).toBeNull()
  })
})
