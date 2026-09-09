import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { RuntimeCategory } from '../catalog/catalog.types'
import type { ClaudeStoreIo } from '../providers/claude/claudeHistoryMigrator'
import { ClaudeHistoryMigrator } from '../providers/claude/claudeHistoryMigrator'
import { ClaudeProjectsLocator } from '../providers/claude/claudeProjectsLocator'
import { CodexHistoryMigrator } from '../providers/codex/codexHistoryMigrator'
import { CodexRolloutIndex } from '../providers/codex/codexRolloutIndex'
import type {
  ProviderHistoryMigrator,
  RelocationJournalDocument,
} from '../providers/providerContract.types'
import { PathCompare } from '../../shared/pathCompare'
import type { AfterCreateHook } from '../projectManagerApi.types'
import type { LifecycleIo } from './projectLifecycle'
import { ProjectLifecycle } from './projectLifecycle'
import { ProjectOperationGuard } from './projectOperationGuard'
import { RelocationLeftovers } from './relocationLeftovers'

describe('lib-orchestrator/projectManager/projects/projectLifecycle', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  interface Harness {
    categoryRoot: string
    claudeHome: string
    codexHome: string
    journalsDirectory: string
    leftovers: RelocationLeftovers
    messages: string[]
    invalidations: () => number
    /** Every history file the sweep announced as rewritten, as `<provider> <path>`. */
    forgotten: string[]
    category: RuntimeCategory
    lifecycle: ProjectLifecycle
  }

  interface HarnessOptions {
    io?: Partial<LifecycleIo>
    claudeIo?: Partial<ClaudeStoreIo>
    category?: Partial<RuntimeCategory>
    migrators?: readonly ProviderHistoryMigrator[]
  }

  function diskIo(): LifecycleIo {
    return {
      readFile: (file) => readFile(file, 'utf8'),
      writeFile: (file, content) => writeFile(file, content, 'utf8'),
      rename: (oldPath, newPath) => rename(oldPath, newPath),
      unlink: (file) => unlink(file),
      remove: (path) => rm(path, { recursive: true, force: true }),
    }
  }

  function claudeDiskIo(): ClaudeStoreIo {
    return {
      ...diskIo(),
      readdir: (directory) => readdir(directory),
      mkdir: async (directory) => { await mkdir(directory, { recursive: true }) },
      removeDirectory: (directory) => rmdir(directory),
    }
  }

  function failing(code: string): NodeJS.ErrnoException {
    const error: NodeJS.ErrnoException = new Error(`simulated ${code}`)
    error.code = code
    return error
  }

  function harness(options?: HarnessOptions): Harness {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-lifecycle-'))
    created.push(root)
    const categoryRoot = join(root, 'apps')
    const claudeHome = join(root, 'claude')
    const codexHome = join(root, 'codex')
    const journalsDirectory = join(root, 'state', 'project-relocations')
    mkdirSync(categoryRoot, { recursive: true })
    mkdirSync(join(claudeHome, 'projects'), { recursive: true })
    mkdirSync(codexHome, { recursive: true })
    const messages: string[] = []
    const report = (message: string): void => { messages.push(message) }
    const forgotten: string[] = []
    let invalidations = 0
    const locator = new ClaudeProjectsLocator(claudeHome)
    const leftovers = new RelocationLeftovers(join(root, 'state', 'leftovers.json'), report)
    const lifecycle = new ProjectLifecycle({
      journalsDirectory,
      leftovers,
      migrators: options?.migrators ?? [
        new ClaudeHistoryMigrator({
          claudeHome,
          locator,
          report,
          io: { ...claudeDiskIo(), ...options?.claudeIo },
        }),
        new CodexHistoryMigrator({ index: new CodexRolloutIndex(codexHome, report), report }),
      ],
      guard: new ProjectOperationGuard(),
      invalidateAll: () => { invalidations += 1 },
      forgetRewritten: (provider, file) => { forgotten.push(`${provider} ${file}`) },
      report,
      io: { ...diskIo(), ...options?.io },
    })
    return {
      categoryRoot,
      claudeHome,
      codexHome,
      journalsDirectory,
      leftovers,
      messages,
      invalidations: () => invalidations,
      forgotten,
      category: {
        id: 'apps',
        label: 'Apps',
        path: categoryRoot,
        comparablePath: PathCompare.comparable(categoryRoot),
        hiddenFolders: new Set(),
        flattenFolders: new Set(),
        virtualFolders: [{ prefix: 'temporary', title: 'Temporary' }],
        afterCreate: null,
        ...options?.category,
      },
      lifecycle,
    }
  }

  function seedProject(categoryRoot: string, name: string): string {
    const path = join(categoryRoot, name)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'readme.md'), 'a project', 'utf8')
    return path
  }

  /** All three shapes a project path takes inside a Claude transcript. */
  function transcriptFor(projectPath: string): string {
    return `${JSON.stringify({
      cwd: projectPath,
      forward: projectPath.replace(/\\/g, '/'),
      store: ClaudeProjectsLocator.encodeProjectDir(projectPath),
    })}\n`
  }

  function seedClaudeStore(claudeHome: string, projectPath: string, names: string[]): string {
    const directory = join(
      claudeHome,
      'projects',
      ClaudeProjectsLocator.encodeProjectDir(projectPath),
    )
    mkdirSync(directory, { recursive: true })
    for (const name of names) writeFileSync(join(directory, name), transcriptFor(projectPath), 'utf8')
    return directory
  }

  function seedCodexRollout(codexHome: string, projectPath: string): string {
    const now = new Date()
    const year = String(now.getFullYear())
    const month = String(now.getMonth() + 1).padStart(2, '0')
    const day = String(now.getDate()).padStart(2, '0')
    const file = join(
      codexHome,
      'sessions',
      year,
      month,
      day,
      `rollout-${year}-${month}-${day}T09-30-00-44444444-4444-4444-8444-444444444444.jsonl`,
    )
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify({ payload: { cwd: projectPath } })}\n`, 'utf8')
    return file
  }

  it('renames the folder, the store directory and every path inside the transcripts', async () => {
    const { categoryRoot, claudeHome, codexHome, category, lifecycle, journalsDirectory, invalidations } = harness()
    const oldPath = seedProject(categoryRoot, 'Foo')
    const newPath = join(categoryRoot, 'Bar')
    seedClaudeStore(claudeHome, oldPath, ['a.jsonl'])
    const rollout = seedCodexRollout(codexHome, oldPath)

    const result = await lifecycle.relocate(category, 'Foo', 'Bar', 'rename')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.providers).toEqual({ claude: 'done', codex: 'done' })
    expect(result.value.leftoverCount).toBe(0)
    expect(existsSync(oldPath)).toBe(false)
    expect(existsSync(join(newPath, 'readme.md'))).toBe(true)
    const store = join(claudeHome, 'projects', ClaudeProjectsLocator.encodeProjectDir(newPath))
    expect(readFileSync(join(store, 'a.jsonl'), 'utf8')).toBe(transcriptFor(newPath))
    expect(readFileSync(rollout, 'utf8')).toContain(JSON.stringify(newPath).slice(1, -1))
    // The journal only exists while the operation does.
    expect(existsSync(journalsDirectory) ? readdirSync(journalsDirectory) : []).toEqual([])
    expect(invalidations()).toBe(1)
  })

  it('refuses a target that already exists, before anything is written', async () => {
    const { categoryRoot, category, lifecycle, journalsDirectory } = harness()
    seedProject(categoryRoot, 'Foo')
    seedProject(categoryRoot, 'Bar')

    const result = await lifecycle.relocate(category, 'Foo', 'Bar', 'rename')

    expect(result).toEqual({
      ok: false,
      code: 'target-exists',
      detail: `${join(categoryRoot, 'Bar')} already exists`,
    })
    expect(existsSync(join(categoryRoot, 'Foo'))).toBe(true)
    expect(existsSync(journalsDirectory)).toBe(false)
  })

  it('refuses a project that is not there and a name that is not a name', async () => {
    const { categoryRoot, category, lifecycle } = harness()
    seedProject(categoryRoot, 'Foo')

    const missing = await lifecycle.relocate(category, 'Nope', 'Bar', 'rename')
    const named = await lifecycle.relocate(category, 'Foo', '../Escaped', 'rename')

    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.code).toBe('project-not-found')
    expect(named.ok).toBe(false)
    if (!named.ok) expect(named.code).toBe('invalid-name')
    expect(existsSync(join(categoryRoot, 'Foo'))).toBe(true)
  })

  it('refuses to merge two Claude histories, and moves nothing', async () => {
    const { categoryRoot, claudeHome, category, lifecycle } = harness()
    const oldPath = seedProject(categoryRoot, 'Foo')
    seedClaudeStore(claudeHome, oldPath, ['a.jsonl'])
    seedClaudeStore(claudeHome, join(categoryRoot, 'Bar'), ['b.jsonl'])

    const result = await lifecycle.relocate(category, 'Foo', 'Bar', 'rename')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('claude-store-conflict')
    expect(existsSync(oldPath)).toBe(true)
  })

  // Codex's preflight cannot fail today, which is exactly why the code was hard-wired to the other
  // provider: the moment one does, the caller is told the wrong store refused it.
  it('names the provider whose store refused the move', async () => {
    const codexRefuses: ProviderHistoryMigrator = {
      agentId: 'codex',
      preflight: async () => ({ ok: false, conflict: 'a rollout of this project is open' }),
      relocate: async () => 'done',
      enumerateProjectFiles: async () => [],
    }
    const { categoryRoot, category, lifecycle } = harness({ migrators: [codexRefuses] })
    seedProject(categoryRoot, 'Foo')

    const result = await lifecycle.relocate(category, 'Foo', 'Bar', 'rename')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('codex-store-conflict')
      expect(result.detail).toBe('a rollout of this project is open')
    }
  })

  it('lets one relocation of a project run at a time', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { categoryRoot, category, lifecycle } = harness({
      io: {
        rename: async (oldPath, newPath) => {
          await gate
          await rename(oldPath, newPath)
        },
      },
    })
    seedProject(categoryRoot, 'Foo')

    const first = lifecycle.relocate(category, 'Foo', 'Bar', 'rename')
    const second = await lifecycle.relocate(category, 'Foo', 'Baz', 'rename')
    release()

    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.code).toBe('relocation-in-progress')
    expect((await first).ok).toBe(true)
  })

  // A project directory is a working copy. Copying it to work around a lock is worse than refusing.
  it('refuses a locked project folder with an explanation, and leaves no journal behind', async () => {
    const { categoryRoot, claudeHome, category, lifecycle, journalsDirectory } = harness({
      io: { rename: async () => { throw failing('EBUSY') } },
    })
    const oldPath = seedProject(categoryRoot, 'Foo')
    const store = seedClaudeStore(claudeHome, oldPath, ['a.jsonl'])

    const result = await lifecycle.relocate(category, 'Foo', 'Bar', 'rename')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('locked')
      expect(result.detail).toMatch(/close the editor or the agent/)
    }
    expect(existsSync(oldPath)).toBe(true)
    expect(existsSync(join(categoryRoot, 'Bar'))).toBe(false)
    expect(readFileSync(join(store, 'a.jsonl'), 'utf8')).toBe(transcriptFor(oldPath))
    expect(readdirSync(journalsDirectory)).toEqual([])
  })

  it('finishes a rename whose transcript was locked, and registers the leftover', async () => {
    const { categoryRoot, claudeHome, category, lifecycle, leftovers, journalsDirectory } = harness({
      claudeIo: {
        rename: async (oldPath, newPath) => {
          if (oldPath.endsWith('.tmp')) throw failing('EBUSY')
          await rename(oldPath, newPath)
        },
      },
    })
    const oldPath = seedProject(categoryRoot, 'Foo')
    seedClaudeStore(claudeHome, oldPath, ['a.jsonl'])

    const result = await lifecycle.relocate(category, 'Foo', 'Bar', 'rename')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.providers.claude).toBe('done-with-leftovers')
    expect(result.value.leftoverCount).toBe(1)
    expect(existsSync(join(categoryRoot, 'Bar'))).toBe(true)
    expect(leftovers.entries()).toHaveLength(1)
    const leftover = leftovers.entries()[0]
    expect(leftover.kind).toBe('rewrite')
    expect(leftover.kind === 'rewrite' && leftover.provider).toBe('claude')
    expect(leftover.operationId).toBe(result.value.operationId)
    // The operation itself finished, so its journal is gone; the leftover outlives it.
    expect(readdirSync(journalsDirectory)).toEqual([])
  })

  // The folder moved and the history did not: the journal is the only thing that knows that, so it
  // stays until a sweep finishes the job.
  it('keeps the journal when a provider could not finish', async () => {
    const { categoryRoot, claudeHome, category, lifecycle, journalsDirectory, messages } = harness({
      claudeIo: { rename: async () => { throw failing('EIO') } },
    })
    const oldPath = seedProject(categoryRoot, 'Foo')
    seedClaudeStore(claudeHome, oldPath, ['a.jsonl'])

    const result = await lifecycle.relocate(category, 'Foo', 'Bar', 'rename')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.providers.claude).toBe('failed')
    expect(existsSync(join(categoryRoot, 'Bar'))).toBe(true)
    const journals = readdirSync(journalsDirectory)
    expect(journals).toEqual([`${result.value.operationId}.json`])
    expect(JSON.parse(readFileSync(join(journalsDirectory, journals[0]), 'utf8')))
      .toMatchObject({ directoryRenamed: true, oldPath, newPath: join(categoryRoot, 'Bar') })
    expect(messages.some((message) => message.includes('EIO'))).toBe(true)
  })

  it('archives into Archived/ and takes the history with it', async () => {
    const { categoryRoot, claudeHome, category, lifecycle } = harness()
    const oldPath = seedProject(categoryRoot, 'Foo')
    seedClaudeStore(claudeHome, oldPath, ['a.jsonl'])

    const result = await lifecycle.archiveProject(category, 'Foo')

    const archived = join(categoryRoot, 'Archived', 'Foo')
    expect(result.ok).toBe(true)
    expect(existsSync(join(archived, 'readme.md'))).toBe(true)
    // V1 archived the folder and left the encoded directory naming a path that no longer existed.
    const store = join(claudeHome, 'projects', ClaudeProjectsLocator.encodeProjectDir(archived))
    expect(readFileSync(join(store, 'a.jsonl'), 'utf8')).toBe(transcriptFor(archived))
  })

  it('moves a project in and out of a virtual folder through the same core', async () => {
    const { categoryRoot, claudeHome, category, lifecycle } = harness()
    const oldPath = seedProject(categoryRoot, 'Foo')
    seedClaudeStore(claudeHome, oldPath, ['a.jsonl'])

    expect((await lifecycle.moveProjectPrefix(category, 'Foo', 'temporary')).ok).toBe(true)
    const inside = join(categoryRoot, 'temporaryFoo')
    expect(existsSync(inside)).toBe(true)
    expect(existsSync(join(
      claudeHome,
      'projects',
      ClaudeProjectsLocator.encodeProjectDir(inside),
    ))).toBe(true)

    expect((await lifecycle.moveProjectPrefix(category, 'temporaryFoo', null)).ok).toBe(true)
    expect(existsSync(join(categoryRoot, 'Foo'))).toBe(true)
  })

  /**
   * `applyPrefix` computes a name for whatever prefix it is handed, and the channel above this takes
   * whatever a caller sends. Without the check the project lands in a folder no config names, which
   * nothing can then enter or leave.
   */
  it('refuses a prefix the category does not define, and moves nothing', async () => {
    const { categoryRoot, category, lifecycle, journalsDirectory } = harness()
    seedProject(categoryRoot, 'Foo')

    const moved = await lifecycle.moveProjectPrefix(category, 'Foo', 'invented')

    expect(moved.ok).toBe(false)
    if (moved.ok) return
    expect(moved.code).toBe('unknown-virtual-folder')
    expect(existsSync(join(categoryRoot, 'Foo'))).toBe(true)
    expect(existsSync(join(categoryRoot, 'inventedFoo'))).toBe(false)
    expect(existsSync(journalsDirectory)).toBe(false)
  })

  /**
   * The move that computes its own name back. Without the short circuit `relocate` looks for the
   * target, finds the project's own directory there and refuses `target-exists` - which is what
   * choosing the folder a project is already in used to do.
   */
  it('does nothing, and says so, when the project is already where it was sent', async () => {
    const { categoryRoot, category, lifecycle, journalsDirectory } = harness()
    seedProject(categoryRoot, 'temporaryFoo')
    seedProject(categoryRoot, 'Loose')

    const intoTheSameFolder = await lifecycle.moveProjectPrefix(category, 'temporaryFoo', 'temporary')
    const outOfNoFolder = await lifecycle.moveProjectPrefix(category, 'Loose', null)

    for (const moved of [intoTheSameFolder, outOfNoFolder]) {
      expect(moved.ok).toBe(true)
      if (!moved.ok) return
      expect(moved.value.directoryRenamed).toBe(false)
      // No journal was written, so there is no id to report.
      expect(moved.value.operationId).toBe(null)
      expect(moved.value.leftoverCount).toBe(0)
    }
    for (const name of ['temporaryFoo', 'Loose'])
      expect(readFileSync(join(categoryRoot, name, 'readme.md'), 'utf8')).toBe('a project')
    expect(existsSync(journalsDirectory)).toBe(false)
  })

  /**
   * The short circuit answers before `relocate`, which is where every other refusal is made, so
   * without its own existence check it reports a finished relocation - two provider migrations
   * included - for a project that is not on disk.
   */
  it('refuses a move of a project that is not there instead of calling it already done', async () => {
    const { categoryRoot, category, lifecycle, journalsDirectory } = harness()

    const moved = await lifecycle.moveProjectPrefix(category, 'Gone', null)

    expect(moved.ok).toBe(false)
    if (moved.ok) return
    expect(moved.code).toBe('project-not-found')
    expect(moved.detail).toBe(`${join(categoryRoot, 'Gone')} is not a directory`)
    expect(existsSync(journalsDirectory)).toBe(false)
  })

  it('refuses to move a project that sits inside a flattened container', async () => {
    const { categoryRoot, category, lifecycle, journalsDirectory } = harness({
      category: { flattenFolders: new Set(['group']) },
    })
    seedProject(join(categoryRoot, 'group'), 'Foo')

    const moved = await lifecycle.moveProjectPrefix(category, 'group/Foo', 'temporary')

    expect(moved.ok).toBe(false)
    if (moved.ok) return
    expect(moved.code).toBe('invalid-name')
    expect(existsSync(join(categoryRoot, 'group', 'Foo'))).toBe(true)
    expect(existsSync(journalsDirectory)).toBe(false)
  })

  it('finishes an interrupted operation from its journal and removes it', async () => {
    const { categoryRoot, claudeHome, lifecycle, journalsDirectory } = harness()
    // The state a crash leaves: the folder is already at its new name, the store is not.
    const oldPath = join(categoryRoot, 'Foo')
    const newPath = seedProject(categoryRoot, 'Bar')
    const store = seedClaudeStore(claudeHome, oldPath, ['a.jsonl', 'b.jsonl'])
    writeFileSync(join(store, 'b.jsonl'), transcriptFor(newPath), 'utf8')
    const document: RelocationJournalDocument = {
      schemaVersion: 1,
      operationId: 'crashed-1',
      kind: 'rename',
      oldPath,
      newPath,
      directoryRenamed: true,
      steps: [{ provider: 'claude', file: join(store, 'b.jsonl'), state: 'done' }],
    }
    mkdirSync(journalsDirectory, { recursive: true })
    writeFileSync(join(journalsDirectory, 'crashed-1.json'), JSON.stringify(document), 'utf8')

    await lifecycle.sweep()

    const moved = join(claudeHome, 'projects', ClaudeProjectsLocator.encodeProjectDir(newPath))
    expect(existsSync(store)).toBe(false)
    expect(readFileSync(join(moved, 'a.jsonl'), 'utf8')).toBe(transcriptFor(newPath))
    expect(readFileSync(join(moved, 'b.jsonl'), 'utf8')).toBe(transcriptFor(newPath))
    expect(readdirSync(journalsDirectory)).toEqual([])
  })

  it('throws away the journal of an operation that never reached its first effect', async () => {
    const { categoryRoot, claudeHome, lifecycle, journalsDirectory } = harness()
    const oldPath = seedProject(categoryRoot, 'Foo')
    const store = seedClaudeStore(claudeHome, oldPath, ['a.jsonl'])
    const document: RelocationJournalDocument = {
      schemaVersion: 1,
      operationId: 'crashed-2',
      kind: 'rename',
      oldPath,
      newPath: join(categoryRoot, 'Bar'),
      directoryRenamed: false,
      steps: [],
    }
    mkdirSync(journalsDirectory, { recursive: true })
    writeFileSync(join(journalsDirectory, 'crashed-2.json'), JSON.stringify(document), 'utf8')

    await lifecycle.sweep()

    expect(readdirSync(journalsDirectory)).toEqual([])
    // The source is still where it was, so the history has to stay named after it.
    expect(readFileSync(join(store, 'a.jsonl'), 'utf8')).toBe(transcriptFor(oldPath))
  })

  /**
   * The flag is written after the rename it describes. A crash in between leaves a journal claiming
   * nothing happened over a directory that already moved, and believing it would leave both histories
   * naming the old path with no record left that they do.
   */
  it('finishes a migration whose journal never recorded the rename that happened', async () => {
    const { categoryRoot, claudeHome, lifecycle, journalsDirectory } = harness()
    const oldPath = join(categoryRoot, 'Foo')
    const newPath = seedProject(categoryRoot, 'Bar')
    const store = seedClaudeStore(claudeHome, oldPath, ['a.jsonl'])
    const document: RelocationJournalDocument = {
      schemaVersion: 1,
      operationId: 'crashed-3',
      kind: 'rename',
      oldPath,
      newPath,
      directoryRenamed: false,
      steps: [],
    }
    mkdirSync(journalsDirectory, { recursive: true })
    writeFileSync(join(journalsDirectory, 'crashed-3.json'), JSON.stringify(document), 'utf8')

    await lifecycle.sweep()

    const moved = join(claudeHome, 'projects', ClaudeProjectsLocator.encodeProjectDir(newPath))
    expect(existsSync(store)).toBe(false)
    expect(readFileSync(join(moved, 'a.jsonl'), 'utf8')).toBe(transcriptFor(newPath))
    expect(readdirSync(journalsDirectory)).toEqual([])
  })

  it('cleans up the leftovers it can and keeps the ones still locked', async () => {
    const { categoryRoot, claudeHome, lifecycle, leftovers } = harness({
      io: {
        rename: async (oldPath, newPath) => {
          if (oldPath.includes('locked')) throw failing('EBUSY')
          await rename(oldPath, newPath)
        },
      },
    })
    const oldPath = join(categoryRoot, 'Foo')
    const newPath = join(categoryRoot, 'Bar')
    const store = seedClaudeStore(claudeHome, newPath, ['pending.jsonl', 'locked.jsonl'])
    writeFileSync(join(store, 'pending.jsonl'), transcriptFor(oldPath), 'utf8')
    writeFileSync(join(store, 'locked.jsonl'), transcriptFor(oldPath), 'utf8')
    const stale = join(store, 'stale-copy.jsonl')
    writeFileSync(stale, 'an old copy', 'utf8')
    for (const [kind, path] of [
      ['delete', stale],
      ['rewrite', join(store, 'pending.jsonl')],
      ['rewrite', join(store, 'locked.jsonl')],
    ] as const)
      leftovers.record({
        kind,
        provider: 'claude',
        path,
        operationId: 'op-9',
        oldPath,
        newPath,
        recordedAt: Date.now(),
      })

    await lifecycle.sweep()

    expect(existsSync(stale)).toBe(false)
    expect(readFileSync(join(store, 'pending.jsonl'), 'utf8')).toBe(transcriptFor(newPath))
    expect(readFileSync(join(store, 'locked.jsonl'), 'utf8')).toBe(transcriptFor(oldPath))
    expect(leftovers.entries().map((entry) => entry.path)).toEqual([join(store, 'locked.jsonl')])
  })

  it('drops a leftover whose file is gone instead of retrying it forever', async () => {
    const { categoryRoot, claudeHome, lifecycle, leftovers } = harness()
    leftovers.record({
      kind: 'rewrite',
      provider: 'claude',
      path: join(claudeHome, 'projects', 'gone', 'a.jsonl'),
      operationId: 'op-10',
      oldPath: join(categoryRoot, 'Foo'),
      newPath: join(categoryRoot, 'Bar'),
      recordedAt: Date.now(),
    })

    await lifecycle.sweep()

    expect(leftovers.entries()).toEqual([])
  })

  /**
   * The sweep is the second writer of a provider's history files: a relocation left one locked, and
   * this rewrites it at a later start, one file at a time and with no migrator to announce through.
   * Whatever indexes those files by the directory their header records has to hear which one moved,
   * or it goes on answering with the path this just replaced.
   */
  it('names the history file it rewrote in the sweep, and not the one it left as it was', async () => {
    const { categoryRoot, codexHome, lifecycle, leftovers, forgotten } = harness()
    const oldPath = join(categoryRoot, 'Foo')
    const newPath = join(categoryRoot, 'Bar')
    const stale = seedCodexRollout(codexHome, oldPath)
    // Already carrying the new path: the rewrite reports it unchanged and writes nothing, so there
    // is nothing about it for an index to forget.
    const current = join(dirname(stale), 'rollout-already-moved.jsonl')
    writeFileSync(current, `${JSON.stringify({ payload: { cwd: newPath } })}\n`, 'utf8')
    for (const path of [stale, current])
      leftovers.record({
        kind: 'rewrite',
        provider: 'codex',
        path,
        operationId: 'op-11',
        oldPath,
        newPath,
        recordedAt: Date.now(),
      })

    await lifecycle.sweep()

    expect(forgotten).toEqual([`codex ${stale}`])
    expect(readFileSync(stale, 'utf8')).toContain(JSON.stringify(newPath).slice(1, -1))
    expect(leftovers.entries()).toEqual([])
  })

  it('creates a project directory and runs the hook inside it', async () => {
    const hook: AfterCreateHook = {
      command: process.execPath,
      args: ['-e', 'require("fs").writeFileSync(process.argv[1], "{name}")', '{dir}/hook.txt'],
    }
    const { categoryRoot, category, lifecycle, invalidations } = harness({
      category: { afterCreate: hook },
    })

    const result = await lifecycle.createProject(category, 'Fresh')

    expect(result).toEqual({
      ok: true,
      value: { name: 'Fresh', path: join(categoryRoot, 'Fresh'), lastActivity: null },
    })
    expect(readFileSync(join(categoryRoot, 'Fresh', 'hook.txt'), 'utf8')).toBe('Fresh')
    expect(invalidations()).toBe(1)
  })

  it('creates into a virtual folder by name', async () => {
    const { categoryRoot, category, lifecycle } = harness()

    const result = await lifecycle.createProject(category, 'Fresh', { virtualFolderPrefix: 'temporary' })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.name).toBe('temporaryFresh')
    expect(existsSync(join(categoryRoot, 'temporaryFresh'))).toBe(true)
  })

  /**
   * The other half of the same rule: the launcher passes the folder the cursor stands in, and at the
   * root of a category that defines folders it stands in none. A prefix must not be inferred from
   * the folders merely existing.
   */
  it('creates in the root of a category that defines folders, without any prefix', async () => {
    const { categoryRoot, category, lifecycle } = harness()

    const result = await lifecycle.createProject(category, 'Fresh')

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.name).toBe('Fresh')
    expect(existsSync(join(categoryRoot, 'Fresh'))).toBe(true)
    expect(existsSync(join(categoryRoot, 'temporaryFresh'))).toBe(false)
  })

  /**
   * The same guard the move carries, on the other entry point that hands a prefix to `applyPrefix`.
   * A create is where it bites hardest: the directory would be made under a prefix no config names,
   * so the project lands somewhere the launcher can neither enter nor list it out of.
   */
  it('refuses a create under a prefix the category does not define, and makes nothing', async () => {
    const { categoryRoot, category, lifecycle } = harness()

    const result = await lifecycle.createProject(category, 'Fresh', { virtualFolderPrefix: 'invented' })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('unknown-virtual-folder')
    expect(readdirSync(categoryRoot)).toEqual([])
  })

  it('refuses a name that is a path, and creates nothing', async () => {
    const { categoryRoot, category, lifecycle } = harness()

    const result = await lifecycle.createProject(category, '../Escaped')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('invalid-name')
    expect(readdirSync(categoryRoot)).toEqual([])
    expect(existsSync(join(dirname(categoryRoot), 'Escaped'))).toBe(false)
  })

  it('reports a failing hook and keeps the project that was created', async () => {
    const { categoryRoot, category, lifecycle, messages } = harness({
      category: { afterCreate: { command: process.execPath, args: ['-e', 'process.exit(3)'] } },
    })

    const result = await lifecycle.createProject(category, 'Fresh')

    expect(result.ok).toBe(true)
    expect(existsSync(join(categoryRoot, 'Fresh'))).toBe(true)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatch(/afterCreate hook .* failed/)
  })

  it('does not run the hook over a directory that already holds work', async () => {
    const hook: AfterCreateHook = {
      command: process.execPath,
      args: ['-e', 'require("fs").writeFileSync(process.argv[1], "ran")', '{dir}/hook.txt'],
    }
    const { categoryRoot, category, lifecycle } = harness({ category: { afterCreate: hook } })
    seedProject(categoryRoot, 'Existing')

    const result = await lifecycle.createProject(category, 'Existing')

    expect(result.ok).toBe(true)
    expect(existsSync(join(categoryRoot, 'Existing', 'hook.txt'))).toBe(false)
    expect(existsSync(join(categoryRoot, 'Existing', 'readme.md'))).toBe(true)
  })
})
