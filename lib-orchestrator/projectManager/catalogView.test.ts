import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { CatalogView } from './catalogView'

describe('lib-orchestrator/projectManager/catalogView', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  const nodejs = { id: 'nodejs', label: 'NodeJs', path: 'C:/Projects/NodeJs' }
  const web = { id: 'web', label: 'Web', path: 'C:/Projects/Web' }

  interface Harness {
    configFile: string
    view: CatalogView
    write: (...categories: Record<string, unknown>[]) => void
  }

  function harness(...categories: Record<string, unknown>[]): Harness {
    const configDir = mkdtempSync(join(tmpdir(), 'jamat-v3-catalog-view-'))
    created.push(configDir)
    const configFile = join(configDir, 'config.json')
    const write = (...next: Record<string, unknown>[]): void => {
      writeFileSync(configFile, JSON.stringify({ schemaVersion: 1, categories: next }), 'utf8')
      // The store re-reads on mtime, and two writes inside one millisecond would look unchanged.
      const future = new Date(Date.now() + 5_000)
      utimesSync(configFile, future, future)
    }
    if (categories.length) write(...categories)
    return { configFile, view: CatalogView.load(configDir), write }
  }

  it('reads a machine with no config at all as an empty catalog', () => {
    const reports: string[] = []
    const directory = mkdtempSync(join(tmpdir(), 'jamat-v3-catalog-view-'))
    created.push(directory)
    expect(CatalogView.load(directory, { report: (m) => reports.push(m) }).read().categories)
      .toEqual([])
    expect(reports).toEqual([])
  })

  it('hands back the id, label and path of every category', () => {
    expect(harness(nodejs, web).view.read().categories).toEqual([nodejs, web])
  })

  it('binds a directory inside a category to its project', () => {
    expect(harness(nodejs).view.read().bind('C:/Projects/NodeJs/AppJamatV3/lib-orchestrator'))
      .toEqual({
        kind: 'project',
        categoryId: 'nodejs',
        projectName: 'AppJamatV3',
        projectPath: join('C:/Projects/NodeJs', 'AppJamatV3'),
      })
  })

  // The behaviour the session manager depends on: a session running in a worktree belongs to the
  // project, not to a project called `.worktrees`.
  it('lets the worktree repository root win over the cwd', () => {
    const binding = harness(nodejs).view.read().bind(
      'C:/Projects/NodeJs/AppJamatV3/.worktrees/feature',
      'C:/Projects/NodeJs/AppJamatV3',
    )
    expect(binding).toEqual({
      kind: 'project',
      categoryId: 'nodejs',
      projectName: 'AppJamatV3',
      projectPath: join('C:/Projects/NodeJs', 'AppJamatV3'),
    })
  })

  it('binds a directory outside every category as adHoc', () => {
    expect(harness(nodejs).view.read().bind('D:/scratch/thing'))
      .toEqual({ kind: 'adHoc', path: 'D:/scratch/thing' })
  })

  // Why `read()` exists at all. The store re-reads whenever the file's mtime moves, so a view that
  // asked it once per binding could compose one snapshot out of two different documents: its
  // category list would name roots that its own session bindings no longer agree with.
  it('answers one reading from one document, however the file changes underneath', () => {
    const { view, write } = harness(nodejs)
    const reading = view.read()
    expect(reading.bind('C:/Projects/NodeJs/AppJamatV3').kind).toBe('project')

    write(web)
    expect(reading.categories).toEqual([nodejs])
    expect(reading.bind('C:/Projects/NodeJs/AppJamatV3').kind).toBe('project')

    const fresh = view.read()
    expect(fresh.categories).toEqual([web])
    expect(fresh.bind('C:/Projects/NodeJs/AppJamatV3')).toEqual({
      kind: 'adHoc',
      path: 'C:/Projects/NodeJs/AppJamatV3',
    })
  })
})
