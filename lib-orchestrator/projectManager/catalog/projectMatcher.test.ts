import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { ProjectMatcher } from './projectMatcher'

describe('lib-orchestrator/projectManager/catalog/projectMatcher', () => {
  const nodejs = {
    id: 'nodejs',
    path: resolve('C:/Projects/NodeJs'),
    flattenFolders: new Set(['Plugins']),
  }
  const nested = { id: 'nested', path: resolve('C:/Projects/NodeJs/Sandbox'), flattenFolders: new Set<string>() }
  const applications = {
    id: 'applications',
    path: resolve('Q:/Projects'),
    flattenFolders: new Set(['AutomationBots', 'Atlas']),
  }
  const matcher = new ProjectMatcher([nodejs, nested, applications])

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

  // The scanner lists `Plugins/foo`, so a session inside it has to land on that same entry rather
  // than on `Plugins`, or the launcher and the sessions tree disagree about what the project is.
  it('binds a cwd inside a flattened container to the child the scanner lists', () => {
    expect(matcher.bind(resolve('C:/Projects/NodeJs/Plugins/foo/src'))).toEqual({
      kind: 'project',
      categoryId: 'nodejs',
      projectName: 'Plugins/foo',
      projectPath: join(nodejs.path, 'Plugins', 'foo'),
    })
  })

  it('binds a cwd inside a listed subfolder to the project one level below it', () => {
    expect(matcher.bind(resolve('Q:/Projects/AutomationBots/SrvTaskBot/app'))).toEqual({
      kind: 'project',
      categoryId: 'applications',
      projectName: 'AutomationBots/SrvTaskBot',
      projectPath: join(applications.path, 'AutomationBots', 'SrvTaskBot'),
    })
  })

  // SecretKeeper holds `.appgroup` on the disk, but only the Subfolders setting unfolds a directory,
  // so a session in one of its members works on the whole product.
  it('binds a cwd inside a product group the setting does not list to the group', () => {
    expect(matcher.bind(resolve('Q:/Projects/SecretKeeper/WebSecretKeeperAdmin/app'))).toEqual({
      kind: 'project',
      categoryId: 'applications',
      projectName: 'SecretKeeper',
      projectPath: join(applications.path, 'SecretKeeper'),
    })
  })

  it('unfolds a subfolder one level only', () => {
    expect(matcher.bind(resolve('Q:/Projects/Atlas/Complex/WebAdmin/app'))).toEqual({
      kind: 'project',
      categoryId: 'applications',
      projectName: 'Atlas/Complex',
      projectPath: join(applications.path, 'Atlas', 'Complex'),
    })
  })

  // A coordinated change across a subfolder's projects runs in the subfolder itself, and the tree
  // needs a place for it: the subfolder's own entry.
  it('binds the subfolder, and what it keeps for itself, to the subfolder', () => {
    const group = {
      kind: 'project',
      categoryId: 'applications',
      projectName: 'AutomationBots',
      projectPath: join(applications.path, 'AutomationBots'),
    }
    expect(matcher.bind(resolve('Q:/Projects/AutomationBots'))).toEqual(group)
    expect(matcher.bind(resolve('Q:/Projects/AutomationBots/components/logger'))).toEqual(group)
    expect(matcher.bind(resolve('Q:/Projects/AutomationBots/.private/notes'))).toEqual(group)
  })
})
