import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { ProjectMatcher } from './projectMatcher'

describe('lib-orchestrator/projectManager/catalog/projectMatcher', () => {
  const nodejs = { id: 'nodejs', label: 'NodeJs', path: resolve('C:/Projects/NodeJs') }
  const nested = { id: 'nested', label: 'Nested', path: resolve('C:/Projects/NodeJs/Sandbox') }
  const matcher = new ProjectMatcher([nodejs, nested])

  it('binds a cwd to the project directly under the category root', () => {
    expect(matcher.bind(resolve('C:/Projects/NodeJs/AppJamatV3/app-host'))).toEqual({
      kind: 'project',
      categoryId: 'nodejs',
      projectName: 'AppJamatV3',
      projectPath: join(nodejs.path, 'AppJamatV3'),
    })
  })

  // A category nested inside another must claim its own projects, not be swallowed by the outer root.
  it('lets the longest matching root win', () => {
    expect(matcher.bind(resolve('C:/Projects/NodeJs/Sandbox/Toy/src'))).toEqual({
      kind: 'project',
      categoryId: 'nested',
      projectName: 'Toy',
      projectPath: join(nested.path, 'Toy'),
    })
  })

  it('treats a directory outside every category as ad hoc', () => {
    const path = resolve('Q:/Elsewhere/Thing')
    expect(matcher.bind(path)).toEqual({ kind: 'adHoc', path: path.replace(/\\/g, '/') })
  })

  it('treats the category root itself as ad hoc', () => {
    expect(matcher.bind(nodejs.path).kind).toBe('adHoc')
  })

  it('reports no binding for an empty directory', () => {
    expect(matcher.bind('')).toEqual({ kind: 'none' })
  })

  // A session inside <project>/.worktrees/<slug> belongs to <project>, not to a project called
  // `.worktrees`.
  it('prefers the worktree repository root over the cwd', () => {
    const cwd = resolve('C:/Projects/NodeJs/AppJamatV3/.worktrees/feature')
    const repositoryRoot = resolve('C:/Projects/NodeJs/AppJamatV3')
    expect(matcher.bind(cwd, repositoryRoot)).toEqual({
      kind: 'project',
      categoryId: 'nodejs',
      projectName: 'AppJamatV3',
      projectPath: join(nodejs.path, 'AppJamatV3'),
    })
  })

  it('keeps the project name in its original case', () => {
    const binding = matcher.bind(resolve('C:/Projects/NodeJs/AppJamatV3'))
    expect(binding.kind === 'project' && binding.projectName).toBe('AppJamatV3')
  })

  it('compares roots the way the platform does', () => {
    const binding = matcher.bind(resolve('c:/projects/nodejs/AppJamatV3'))
    if (process.platform === 'win32') expect(binding.kind).toBe('project')
    else expect(binding.kind).toBe('adHoc')
  })
})
