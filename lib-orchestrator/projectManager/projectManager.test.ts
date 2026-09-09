import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type {
  ProviderAgentId,
  ProviderSessionSource,
} from './providers/providerContract.types'
import type {
  CatalogCategoryDto,
  ProviderSessionSummary,
} from './projectManagerApi.types'
import { ConfigStore } from '../configStore/configStore'
import { ProjectManager } from './projectManager'

describe('lib-orchestrator/projectManager/projectManager', () => {
  const created: string[] = []
  let previousStateRoot: string | undefined

  afterEach(() => {
    if (previousStateRoot === undefined) delete process.env.JAMAT_V3_LOCAL_STATE_DIR
    else process.env.JAMAT_V3_LOCAL_STATE_DIR = previousStateRoot
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  /**
   * A provider driver that answers from a table and counts what was asked of it. The facade's own
   * job is composition, and the two things that can only be seen from the inside - that an
   * alphabetical listing opens no store at all, and that every operation drops every cache - are
   * counts, not contents.
   */
  class FakeSource implements ProviderSessionSource {
    latestCalls = 0
    invalidations = 0
    lastLimit = -1

    constructor(
      readonly agentId: ProviderAgentId,
      private readonly activity: ReadonlyMap<string, number>,
      private readonly sessions: readonly ProviderSessionSummary[] = [],
    ) {}

    async listProjectSessions(
      _projectDir: string,
      options: { limit: number; signal?: AbortSignal },
    ): Promise<ProviderSessionSummary[]> {
      this.lastLimit = options.limit
      return this.sessions.slice(0, options.limit)
    }

    async latestActivity(projectDir: string): Promise<number | null> {
      this.latestCalls += 1
      return this.activity.get(projectDir) ?? null
    }

    invalidate(): void {
      this.invalidations += 1
    }
  }

  /** The same source, stopped inside `latestActivity` until the test lets it out. */
  class GatedSource extends FakeSource {
    private open = (): void => {}
    private reach = (): void => {}
    readonly gate = new Promise<void>((resolve) => { this.open = resolve })
    readonly entered = new Promise<void>((resolve) => { this.reach = resolve })

    override async latestActivity(projectDir: string): Promise<number | null> {
      this.reach()
      await this.gate
      return super.latestActivity(projectDir)
    }

    release(): void {
      this.open()
    }
  }

  /**
   * The facade's collaborators are private and its constructor takes only a configuration, so a test
   * that needs to count calls replaces them here. Nothing about the production surface bends for it.
   */
  interface ManagerInternals {
    claudeSource: ProviderSessionSource
    codexSource: ProviderSessionSource
    lifecycle: { sweep(): Promise<void> }
  }

  interface Harness {
    root: string
    projectsRoot: string
    messages: string[]
    manager: ProjectManager
  }

  function internalsOf(manager: ProjectManager): ManagerInternals {
    return manager as unknown as ManagerInternals
  }

  function harness(): Harness {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-manager-'))
    created.push(root)
    previousStateRoot = process.env.JAMAT_V3_LOCAL_STATE_DIR
    process.env.JAMAT_V3_LOCAL_STATE_DIR = join(root, 'state')
    const projectsRoot = join(root, 'projects')
    mkdirSync(projectsRoot, { recursive: true })
    const messages: string[] = []
    return {
      root,
      projectsRoot,
      messages,
      manager: new ProjectManager({
        // The composition layer owns the one writer; the facade is handed it, exactly as AppHub
        // hands the shell's.
        configStore: ConfigStore.load(join(root, 'config'), {
          snapshotsDirectory: join(root, 'config-snapshots'),
          report: (message) => { messages.push(message) },
        }),
        configIdentity: 'test-identity',
        channel: 'development',
        onError: (message) => { messages.push(message) },
        claudeHome: join(root, 'claude'),
        codexHome: join(root, 'codex'),
      }),
    }
  }

  function categoriesFor(path: string): CatalogCategoryDto[] {
    return [{ id: 'apps', label: 'Apps', path, _note: 'a key no build knows' }]
  }

  function summary(agentId: ProviderAgentId, lastActivity: number): ProviderSessionSummary {
    return {
      agentId,
      nativeSessionId: `${agentId}-${lastActivity}`,
      title: null,
      firstUserMessage: null,
      createdAt: lastActivity - 1000,
      lastActivity,
      active: false,
    }
  }

  function seedProjects(projectsRoot: string, names: readonly string[]): void {
    for (const name of names) mkdirSync(join(projectsRoot, name), { recursive: true })
  }

  it('refuses every operation on a category the catalog does not hold', async () => {
    const { manager } = harness()

    const listed = await manager.listProjects('nope')
    const sessions = await manager.listProjectSessions('nope', 'Foo')
    const createdProject = await manager.createProject('nope', 'Foo')
    const preview = await manager.previewDelete('nope', 'Foo')

    for (const result of [listed, sessions, createdProject, preview]) {
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.code).toBe('category-not-found')
    }
  })

  it('lists a category whose root cannot be read, and refuses to write into it', async () => {
    const { root, manager } = harness()
    const missing = join(root, 'not-mounted')
    expect((await manager.saveConfig(categoriesFor(missing))).ok).toBe(true)

    const categories = await manager.listCategories()
    const listed = await manager.listProjects('apps')
    const createdProject = await manager.createProject('apps', 'Foo')
    const renamed = await manager.renameProject('apps', 'Foo', 'Bar')

    expect(categories).toEqual([{ id: 'apps', label: 'Apps', path: missing, available: false }])
    expect(listed).toEqual({
      ok: true,
      value: {
        entries: [],
        projects: [],
        virtualFolders: [],
        truncated: false,
        available: false,
      },
    })
    expect(createdProject.ok).toBe(false)
    if (createdProject.ok) return
    expect(createdProject.code).toBe('category-unavailable')
    expect(renamed.ok).toBe(false)
    if (renamed.ok) return
    expect(renamed.code).toBe('category-unavailable')
  })

  it('saves the catalog through the config store it was handed', async () => {
    const { projectsRoot, manager, messages } = harness()

    const saved = await manager.saveConfig(categoriesFor(projectsRoot))
    const loaded = await manager.getConfig()

    expect(saved).toEqual({ ok: true, value: undefined })
    expect(loaded.ok && loaded.value[0]['_note']).toBe('a key no build knows')
    expect(await manager.listCategories())
      .toEqual([{ id: 'apps', label: 'Apps', path: projectsRoot, available: true }])
    expect(messages).toEqual([])
  })

  it('authorizes only a project the live catalog scanner still exposes', async () => {
    const { projectsRoot, manager } = harness()
    seedProjects(projectsRoot, ['Allowed'])
    const allowed = join(projectsRoot, 'Allowed')
    const foreign = join(projectsRoot, '..', 'Foreign')
    mkdirSync(foreign, { recursive: true })
    await manager.saveConfig(categoriesFor(projectsRoot))

    expect(await manager.authorizeProjectPath(allowed)).toBe(allowed)
    expect(await manager.authorizeProjectPath(foreign)).toBeNull()
    rmSync(allowed, { recursive: true, force: true })
    expect(await manager.authorizeProjectPath(allowed)).toBeNull()
  })

  /**
   * `entries` is what the launcher draws and `virtualFolders` is what it can move a project into.
   * They differ by exactly the empty folders, which is the state every folder is in the moment it is
   * created - and a move target list read off `entries` could therefore never reach a new one.
   */
  it('hands back every folder the category defines, including the ones nothing matched', async () => {
    const { projectsRoot, manager } = harness()
    await manager.saveConfig([{
      id: 'apps',
      label: 'Apps',
      path: projectsRoot,
      virtualFolders: [
        { prefix: 'house', title: 'House projects' },
        { prefix: 'temporary', title: 'Temporary projects' },
      ],
    }])
    seedProjects(projectsRoot, ['houseBazen', 'AppJamatV3'])

    const listed = await manager.listProjects('apps', { sort: 'alpha' })

    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.value.virtualFolders).toEqual([
      { prefix: 'house', title: 'House projects' },
      { prefix: 'temporary', title: 'Temporary projects' },
    ])
    // The empty one is offered as a target and is still not drawn as a row.
    expect(listed.value.entries.flatMap((entry) =>
      (entry.kind === 'virtualFolder' ? [entry.title] : []))).toEqual(['House projects'])
  })

  it('hands back an empty folder list for a category that defines none', async () => {
    const { projectsRoot, manager } = harness()
    await manager.saveConfig(categoriesFor(projectsRoot))
    seedProjects(projectsRoot, ['AppJamatV3'])

    const listed = await manager.listProjects('apps', { sort: 'alpha' })

    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.value.virtualFolders).toEqual([])
  })

  it('sorts alphabetically without asking either provider for anything', async () => {
    const { projectsRoot, manager } = harness()
    await manager.saveConfig(categoriesFor(projectsRoot))
    seedProjects(projectsRoot, ['gamma', 'Alpha', 'beta'])
    const claude = new FakeSource('claude', new Map())
    const codex = new FakeSource('codex', new Map())
    Object.assign(internalsOf(manager), { claudeSource: claude, codexSource: codex })

    const listed = await manager.listProjects('apps', { sort: 'alpha' })

    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.value.projects.map((project) => project.name)).toEqual(['Alpha', 'beta', 'gamma'])
    expect(listed.value.projects.every((project) => project.lastActivity === null)).toBe(true)
    expect(claude.latestCalls).toBe(0)
    expect(codex.latestCalls).toBe(0)
  })

  it('sorts by the newest activity across both providers and caches what it found', async () => {
    const { projectsRoot, manager } = harness()
    await manager.saveConfig(categoriesFor(projectsRoot))
    seedProjects(projectsRoot, ['Alpha', 'beta', 'gamma'])
    const claude = new FakeSource('claude', new Map([
      [join(projectsRoot, 'Alpha'), 100],
      [join(projectsRoot, 'beta'), 50],
    ]))
    const codex = new FakeSource('codex', new Map([
      [join(projectsRoot, 'Alpha'), 10],
      [join(projectsRoot, 'beta'), 500],
    ]))
    Object.assign(internalsOf(manager), { claudeSource: claude, codexSource: codex })

    const listed = await manager.listProjects('apps', { sort: 'recent' })
    const again = await manager.listProjects('apps', { sort: 'recent' })

    expect(listed.ok && again.ok).toBe(true)
    if (!listed.ok || !again.ok) return
    expect(listed.value.projects.map((project) => [project.name, project.lastActivity])).toEqual([
      ['beta', 500],
      ['Alpha', 100],
      ['gamma', null],
    ])
    expect(again.value.projects.map((project) => project.name)).toEqual(['beta', 'Alpha', 'gamma'])
    // Three projects, one round of questions: the second listing came out of the cache.
    expect(claude.latestCalls).toBe(3)
    expect(codex.latestCalls).toBe(3)
  })

  it('merges both providers newest first and passes the limit down to each of them', async () => {
    const { projectsRoot, manager } = harness()
    await manager.saveConfig(categoriesFor(projectsRoot))
    const claude = new FakeSource('claude', new Map(), [summary('claude', 300), summary('claude', 100)])
    const codex = new FakeSource('codex', new Map(), [summary('codex', 200)])
    Object.assign(internalsOf(manager), { claudeSource: claude, codexSource: codex })

    const sessions = await manager.listProjectSessions('apps', 'Alpha', { limit: 2 })

    expect(sessions.ok).toBe(true)
    if (!sessions.ok) return
    expect(sessions.value.merged.map((session) => session.lastActivity)).toEqual([300, 200])
    expect(sessions.value.claude.map((session) => session.lastActivity)).toEqual([300, 100])
    expect(sessions.value.codex.map((session) => session.lastActivity)).toEqual([200])
    expect([claude.lastLimit, codex.lastLimit]).toEqual([2, 2])
  })

  /**
   * The reading is asked for before the rename and arrives after it. Without a generation of its own
   * the cache takes it anyway, into the map the rename just emptied, where it survives until the next
   * lifecycle operation - the shape the scanner, the Codex index and the Claude memo all guard against.
   */
  it('throws away an activity reading that outlived the operation that asked for it', async () => {
    const { projectsRoot, manager } = harness()
    await manager.saveConfig(categoriesFor(projectsRoot))
    seedProjects(projectsRoot, ['Alpha'])
    const table = new Map([[join(projectsRoot, 'Alpha'), 100]])
    const claude = new GatedSource('claude', table)
    Object.assign(internalsOf(manager), {
      claudeSource: claude,
      codexSource: new FakeSource('codex', new Map()),
    })

    const listing = manager.listProjects('apps', { sort: 'recent' })
    await claude.entered
    expect((await manager.createProject('apps', 'Fresh')).ok).toBe(true)
    claude.release()
    expect((await listing).ok).toBe(true)

    table.set(join(projectsRoot, 'Alpha'), 900)
    const again = await manager.listProjects('apps', { sort: 'recent' })

    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.value.projects.find((project) => project.name === 'Alpha')?.lastActivity).toBe(900)
  })

  // Every other entry point validates the name; this one turned it straight into a path to read from.
  it('refuses a project name that walks out of the category', async () => {
    const { projectsRoot, manager } = harness()
    await manager.saveConfig(categoriesFor(projectsRoot))
    const claude = new FakeSource('claude', new Map(), [summary('claude', 300)])
    Object.assign(internalsOf(manager), {
      claudeSource: claude,
      codexSource: new FakeSource('codex', new Map()),
    })

    const result = await manager.listProjectSessions('apps', '../../Other')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('invalid-name')
    expect(claude.lastLimit).toBe(-1)
  })

  it('drops every cache after a create, a rename and a delete', async () => {
    const { projectsRoot, manager } = harness()
    await manager.saveConfig(categoriesFor(projectsRoot))
    const claude = new FakeSource('claude', new Map())
    const codex = new FakeSource('codex', new Map())
    Object.assign(internalsOf(manager), { claudeSource: claude, codexSource: codex })

    expect((await manager.createProject('apps', 'Fresh')).ok).toBe(true)
    expect(claude.invalidations).toBe(1)
    expect((await manager.renameProject('apps', 'Fresh', 'Renamed')).ok).toBe(true)
    expect(claude.invalidations).toBe(2)
    const preview = await manager.previewDelete('apps', 'Renamed')
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    expect((await manager.executeDelete(preview.value.token)).ok).toBe(true)

    expect(claude.invalidations).toBe(3)
    expect(codex.invalidations).toBe(3)
    expect(existsSync(join(projectsRoot, 'Renamed'))).toBe(false)
  })

  it('reports a sweep that failed instead of throwing out of start()', async () => {
    const { manager, messages } = harness()
    internalsOf(manager).lifecycle = {
      sweep: () => Promise.reject(new Error('the journals directory is a file')),
    }

    await manager.start()

    expect(messages).toEqual([
      'Startup sweep of unfinished project operations failed: the journals directory is a file',
    ])
  })
})
