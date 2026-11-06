import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommitPrefix } from './commitPrefix'

describe('CommitPrefix', () => {
  const roots: string[] = []
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

  async function layout() {
    const base = await mkdtemp(join(tmpdir(), 'jamat-commit-prefix-'))
    roots.push(base)
    const owner = join(base, 'ProductivityTools', 'Jamat')
    const worktree = join(base, '.worktrees', '014-fix')
    await mkdir(owner, { recursive: true })
    await mkdir(join(worktree, 'shared', 'library'), { recursive: true })
    return { base, owner, worktree }
  }

  it('reads the prefix of a worktree root before its review rows exist, by the rule the rows use (research 039 A3)', async () => {
    const { owner, worktree } = await layout()
    const location = { url: 'https://svn/applications/ProductivityTools/Jamat', relativeUrl: '^/ProductivityTools/Jamat' }
    expect(CommitPrefix.ofRoot({ worktreePath: worktree, repositoryRoot: owner }, worktree, location))
      .toEqual({ repositoryName: 'applications', expectedPrefix: '[Jamat]' })
    expect(CommitPrefix.ofRoot({ worktreePath: worktree, repositoryRoot: owner }, join(worktree, 'shared', 'library'),
      { url: 'https://svn/shared%20library/trunk', relativeUrl: '^/trunk' })).toEqual({ repositoryName: 'shared library', expectedPrefix: '[shared library]' })
    expect(CommitPrefix.ofRoot({ worktreePath: worktree, repositoryRoot: owner }, worktree, { url: 'https://svn/whole/', relativeUrl: '^/' }))
      .toEqual({ repositoryName: 'whole', expectedPrefix: '[whole]' })
  })

  it('names a product group by its repository, and answers nothing outside the worktree or for a foreign URL', async () => {
    const { base, owner, worktree } = await layout()
    await writeFile(join(owner, '.appgroup'), '{"kind":"product"}')
    const location = { url: 'https://svn/applications/ProductivityTools/Jamat', relativeUrl: '^/ProductivityTools/Jamat' }
    expect(CommitPrefix.ofRoot({ worktreePath: worktree, repositoryRoot: owner }, worktree, location)?.expectedPrefix).toBe('[applications]')
    expect(CommitPrefix.ofRoot({ worktreePath: worktree, repositoryRoot: owner }, base, location)).toBeNull()
    expect(CommitPrefix.ofRoot({ worktreePath: worktree, repositoryRoot: owner }, worktree, { url: 'https://svn/other/x', relativeUrl: '^/y' })).toBeNull()
  })
})
