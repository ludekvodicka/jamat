import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { PathCompare } from '../../shared/pathCompare'
import type { SvnResult } from '../../svn/svn.types'
import { WorktreeOwner, type WorktreeOwnerDeps } from './worktreeOwner'

describe('lib-orchestrator/sessionManager/lifecycle/worktreeOwner', () => {
  const zone = join('Q:', 'Applications')
  const group = join(zone, 'Mirabia')
  const member = join(group, 'WebMirabiaAdmin')
  const solo = join(zone, 'AccountingTool')
  const docker = join('Q:', 'Docker')

  /** A zone working copy with one category at its root, the group Mirabia and the project AccountingTool. */
  function deps(overrides: Partial<WorktreeOwnerDeps> = {}): WorktreeOwnerDeps & { asked: string[] } {
    const asked: string[] = []
    const inside = (root: string, dir: string): boolean => PathCompare.isInside(root, dir)
    return {
      asked,
      groupRootOf: (dir) => inside(group, dir) ? group : null,
      catalogProjectOf: (dir) => inside(member, dir) ? member : inside(solo, dir) ? solo : inside(group, dir) ? group : null,
      holdsCatalogProject: (dir) => inside(dir, zone),
      workingCopyRootOf: async (dir): Promise<SvnResult<string>> => {
        asked.push(dir)
        if (inside(zone, dir)) return { ok: true, value: zone.replaceAll('\\', '/') }
        if (inside(docker, dir)) return { ok: true, value: docker }
        return { ok: false, code: 'not-a-working-copy', detail: `svn: E155007: '${dir}' is not a working copy` }
      },
      ...overrides,
    }
  }

  it('gives a directory in a group member to the whole group, the session starting at its place below', async () => {
    expect(await WorktreeOwner.of(join(member, 'src'), deps()))
      .toEqual({ ok: true, ownerDir: group, cwdSubpath: 'WebMirabiaAdmin/src', catalogProject: member })
    expect(await WorktreeOwner.of(group, deps())).toEqual({ ok: true, ownerDir: group, cwdSubpath: '', catalogProject: group })
  })

  it('gives a subdirectory of a catalog project without a group to the project, keeping the subpath', async () => {
    expect(await WorktreeOwner.of(join(solo, 'docs', 'architecture'), deps()))
      .toEqual({ ok: true, ownerDir: solo, cwdSubpath: 'docs/architecture', catalogProject: solo })
  })

  it('gives a directory outside the catalog to itself, never to anything wider', async () => {
    expect(await WorktreeOwner.of(join(docker, 'traefik'), deps()))
      .toEqual({ ok: true, ownerDir: join(docker, 'traefik'), cwdSubpath: '', catalogProject: null })
    // A whole standalone repository only when it is the directory chosen, and it holds no catalog project.
    expect(await WorktreeOwner.of(docker, deps())).toEqual({ ok: true, ownerDir: docker, cwdSubpath: '', catalogProject: null })
  })

  it('refuses a working-copy root that holds catalog projects', async () => {
    expect(await WorktreeOwner.of(zone, deps())).toEqual({
      ok: false,
      code: 'invalid-spec',
      detail: `${zone} is a working-copy root that holds other projects, not a project`,
    })
  })

  it('refuses a directory inside a worktree before it asks svn anything', async () => {
    const context = deps()
    expect(await WorktreeOwner.of(join(group, '.worktrees', '014-fix', 'WebMirabiaAdmin'), context))
      .toMatchObject({ ok: false, code: 'invalid-spec', detail: expect.stringMatching(/inside a worktree/) })
    expect(context.asked).toEqual([])
  })

  it('refuses a directory in no SVN working copy, an unversioned one, and answers a missing svn by name', async () => {
    const outside = join('D:', 'scratch')
    expect(await WorktreeOwner.of(outside, deps())).toEqual({
      ok: false,
      code: 'invalid-spec',
      detail: `checkpoints mode makes SVN worktrees and ${outside} is in no SVN working copy`,
    })
    const unversioned = deps({ workingCopyRootOf: async () => ({ ok: false, code: 'svn-failed', detail: 'svn: W155010: The node was not found' }) })
    expect(await WorktreeOwner.of(join(solo, 'new'), unversioned))
      .toMatchObject({ ok: false, code: 'invalid-spec', detail: expect.stringMatching(/is not a versioned SVN directory: .*W155010/) })
    const missing = deps({ workingCopyRootOf: async () => ({ ok: false, code: 'svn-missing', detail: 'spawn svn ENOENT' }) })
    expect(await WorktreeOwner.of(solo, missing)).toEqual({ ok: false, code: 'svn-failed', detail: 'svn is not installed: spawn svn ENOENT' })
  })
})
