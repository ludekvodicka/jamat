import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { VsCodeWorkspace } from './vsCodeWorkspace'

describe('app-client-ui/app/terminals/vsCodeWorkspace', () => {
  const roots: string[] = []
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

  /** A worktree root on disk holding the named files, and the paths VS Code was asked to open. */
  async function worktreeWith(names: readonly string[]): Promise<{ root: string; opens: (string | number | null)[][] }> {
    const root = await mkdtemp(join(tmpdir(), 'jamat-vscode-workspace-'))
    roots.push(root)
    for (const name of names) await writeFile(join(root, name), '{}')
    return { root, opens: [] }
  }

  async function opened(names: readonly string[]): Promise<{ root: string; target: string | number | null | undefined }> {
    const worktree = await worktreeWith(names)
    await VsCodeWorkspace.open({ open: (path, line) => { worktree.opens.push([path, line]) } }, worktree.root, 'Mirabia')
    expect(worktree.opens).toHaveLength(1)
    expect(worktree.opens[0]?.[1]).toBeNull()
    return { root: worktree.root, target: worktree.opens[0]?.[0] }
  }

  it('opens the one workspace file at the root, whatever it is named', async () => {
    const { root, target } = await opened(['Mirabia.code-workspace', 'README.md'])
    expect(target).toBe(join(root, 'Mirabia.code-workspace'))
    const other = await opened(['Product.code-workspace'])
    expect(other.target).toBe(join(other.root, 'Product.code-workspace'))
  })

  it('picks the workspace file named after the owner folder among several, else the folder', async () => {
    const named = await opened(['Mirabia.code-workspace', 'Old.code-workspace'])
    expect(named.target).toBe(join(named.root, 'Mirabia.code-workspace'))
    const neither = await opened(['One.code-workspace', 'Two.code-workspace'])
    expect(neither.target).toBe(neither.root)
  })

  it('opens the folder when the root holds no workspace file, only a directory named like one, or cannot be read', async () => {
    const none = await opened(['package.json'])
    expect(none.target).toBe(none.root)

    const worktree = await worktreeWith([])
    await mkdir(join(worktree.root, 'Mirabia.code-workspace'))
    await VsCodeWorkspace.open({ open: (path, line) => { worktree.opens.push([path, line]) } }, worktree.root, 'Mirabia')
    expect(worktree.opens).toEqual([[worktree.root, null]])

    const gone = join(worktree.root, 'gone')
    const opens: (string | number | null)[][] = []
    await VsCodeWorkspace.open({ open: (path, line) => { opens.push([path, line]) } }, gone, 'Mirabia')
    expect(opens).toEqual([[gone, null]])
  })

  it('chooses from names alone', () => {
    expect(VsCodeWorkspace.targetOf('Q:/w', 'Mirabia', ['a.code-workspace.bak', 'b.txt'])).toBe('Q:/w')
    expect(VsCodeWorkspace.targetOf('Q:/w', 'Mirabia', ['Mirabia.code-workspace', 'x.code-workspace']))
      .toBe(join('Q:/w', 'Mirabia.code-workspace'))
  })
})
