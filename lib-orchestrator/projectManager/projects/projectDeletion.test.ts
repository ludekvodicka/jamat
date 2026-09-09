import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RuntimeCategory } from '../catalog/catalog.types'
import { ClaudeHistoryMigrator } from '../providers/claude/claudeHistoryMigrator'
import { ClaudeProjectsLocator } from '../providers/claude/claudeProjectsLocator'
import { CodexHistoryMigrator } from '../providers/codex/codexHistoryMigrator'
import { CodexRolloutIndex } from '../providers/codex/codexRolloutIndex'
import type { LeftoverEntry, RelocationLeftoversWriter } from '../providers/providerContract.types'
import { PathCompare } from '../../shared/pathCompare'
import type { DeletionIo } from './projectDeletion'
import { ProjectDeletion } from './projectDeletion'
import { ProjectLifecycle } from './projectLifecycle'
import { ProjectOperationGuard } from './projectOperationGuard'
import { RelocationLeftovers } from './relocationLeftovers'

describe('lib-orchestrator/projectManager/projects/projectDeletion', () => {
  const created: string[] = []
  const sessionIndexConst = '{"id":"1111","name":"a name of another session"}\n'

  afterEach(() => {
    vi.useRealTimers()
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  interface Harness {
    categoryRoot: string
    claudeHome: string
    codexHome: string
    sessionIndexFile: string
    locator: ClaudeProjectsLocator
    messages: string[]
    records: LeftoverEntry[]
    guard: ProjectOperationGuard
    invalidations: () => number
    category: RuntimeCategory
    deletion: ProjectDeletion
  }

  function failing(code: string): NodeJS.ErrnoException {
    const error: NodeJS.ErrnoException = new Error(`simulated ${code}`)
    error.code = code
    return error
  }

  function harness(io?: Partial<DeletionIo>): Harness {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-deletion-'))
    created.push(root)
    const categoryRoot = join(root, 'apps')
    const claudeHome = join(root, 'claude')
    const codexHome = join(root, 'codex')
    mkdirSync(categoryRoot, { recursive: true })
    mkdirSync(join(claudeHome, 'projects'), { recursive: true })
    mkdirSync(codexHome, { recursive: true })
    const sessionIndexFile = join(codexHome, 'session_index.jsonl')
    writeFileSync(sessionIndexFile, sessionIndexConst, 'utf8')
    const messages: string[] = []
    const report = (message: string): void => { messages.push(message) }
    const records: LeftoverEntry[] = []
    const leftovers: RelocationLeftoversWriter = {
      record: (entry) => { records.push(entry); return true },
    }
    let invalidations = 0
    const locator = new ClaudeProjectsLocator(claudeHome)
    const guard = new ProjectOperationGuard()
    return {
      categoryRoot,
      claudeHome,
      codexHome,
      sessionIndexFile,
      locator,
      messages,
      records,
      guard,
      invalidations: () => invalidations,
      category: {
        id: 'apps',
        label: 'Apps',
        path: categoryRoot,
        comparablePath: PathCompare.comparable(categoryRoot),
        hiddenFolders: new Set(),
        flattenFolders: new Set(),
        virtualFolders: [],
        afterCreate: null,
      },
      deletion: new ProjectDeletion({
        claudeHome,
        codexHome,
        locator,
        migrators: [
          new ClaudeHistoryMigrator({ claudeHome, locator, report }),
          new CodexHistoryMigrator({ index: new CodexRolloutIndex(codexHome, report), report }),
        ],
        leftovers,
        guard,
        invalidateAll: () => { invalidations += 1 },
        report,
        io: { remove: (path) => rm(path, { recursive: true, force: true }), ...io },
      }),
    }
  }

  function seedProject(categoryRoot: string, name: string): string {
    const path = join(categoryRoot, name)
    mkdirSync(join(path, 'source'), { recursive: true })
    writeFileSync(join(path, 'readme.md'), 'a project', 'utf8')
    writeFileSync(join(path, 'source', 'main.ts'), 'export {}', 'utf8')
    return path
  }

  function seedClaudeStore(claudeHome: string, projectPath: string, names: string[]): string {
    const directory = join(
      claudeHome,
      'projects',
      ClaudeProjectsLocator.encodeProjectDir(projectPath),
    )
    mkdirSync(directory, { recursive: true })
    for (const name of names)
      writeFileSync(join(directory, name), `${JSON.stringify({ cwd: projectPath })}\n`, 'utf8')
    return directory
  }

  function seedCodexRollout(codexHome: string, projectPath: string, id: string): string {
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
      `rollout-${year}-${month}-${day}T08-00-00-${id}.jsonl`,
    )
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify({ payload: { cwd: projectPath } })}\n`, 'utf8')
    return file
  }

  /**
   * Eviction is the whole point of the test below, and only the map can tell it apart from the
   * expiry check in `execute`: both answer `preview-expired`, one from an entry it found and one
   * from an entry that is no longer there.
   */
  function pendingTokens(deletion: ProjectDeletion): string[] {
    return [...(deletion as unknown as { pending: Map<string, unknown> }).pending.keys()]
  }

  const idAConst = '11111111-1111-4111-8111-111111111111'
  const idBConst = '22222222-2222-4222-8222-222222222222'

  it('lists everything the delete would remove, before anything is removed', async () => {
    const { categoryRoot, claudeHome, codexHome, category, deletion } = harness()
    const projectPath = seedProject(categoryRoot, 'Foo')
    const store = seedClaudeStore(claudeHome, projectPath, ['a.jsonl', 'b.jsonl'])
    const rollout = seedCodexRollout(codexHome, projectPath, idAConst)
    seedCodexRollout(codexHome, join(categoryRoot, 'Other'), idBConst)

    const result = await deletion.preview(category, 'Foo')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.projectPath).toBe(projectPath)
    expect(result.value.projectFileCount).toBe(2)
    expect(result.value.claude).toEqual({
      encodedDirectory: store,
      transcriptFiles: [join(store, 'a.jsonl'), join(store, 'b.jsonl')],
    })
    expect(result.value.codex.rolloutFiles).toEqual([rollout])
    expect(result.value.expiresAt).toBeGreaterThan(Date.now())
    expect(existsSync(projectPath)).toBe(true)
    expect(existsSync(store)).toBe(true)
  })

  it('previews a project that never ran an agent', async () => {
    const { categoryRoot, category, deletion } = harness()
    seedProject(categoryRoot, 'Foo')

    const result = await deletion.preview(category, 'Foo')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.claude).toEqual({ encodedDirectory: null, transcriptFiles: [] })
    expect(result.value.codex.rolloutFiles).toEqual([])
  })

  // The guard between a name that walks out of the category and a recursive delete elsewhere.
  it('refuses a path that resolves outside the category root', async () => {
    const { categoryRoot, category, deletion } = harness()
    seedProject(dirname(categoryRoot), 'Outside')
    seedProject(categoryRoot, 'Foo')

    const result = await deletion.preview(category, '../Outside')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('not-contained')
    expect(existsSync(join(dirname(categoryRoot), 'Outside'))).toBe(true)
  })

  // A name that stays inside the root lexically can still be a link to somewhere else entirely, and
  // this is the one operation that cannot be taken back.
  it('refuses a project directory that is a link out of the category', async () => {
    const { categoryRoot, category, deletion } = harness()
    const outside = seedProject(dirname(categoryRoot), 'Outside')
    symlinkSync(outside, join(categoryRoot, 'Linked'), 'junction')

    const result = await deletion.preview(category, 'Linked')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('not-contained')
    expect(existsSync(join(outside, 'readme.md'))).toBe(true)
  })

  it('refuses the category root itself', async () => {
    const { category, deletion } = harness()

    const result = await deletion.preview(category, '.')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('not-contained')
  })

  it('refuses a project that is not there', async () => {
    const { category, deletion } = harness()

    const result = await deletion.preview(category, 'Missing')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('project-not-found')
  })

  it('deletes the project and both histories, and leaves session_index.jsonl untouched', async () => {
    const { categoryRoot, claudeHome, codexHome, sessionIndexFile, category, deletion, invalidations } = harness()
    const projectPath = seedProject(categoryRoot, 'Foo')
    const store = seedClaudeStore(claudeHome, projectPath, ['a.jsonl'])
    const rollout = seedCodexRollout(codexHome, projectPath, idAConst)
    const foreign = seedCodexRollout(codexHome, join(categoryRoot, 'Other'), idBConst)
    const indexBefore = readFileSync(sessionIndexFile)

    const preview = await deletion.preview(category, 'Foo')
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    const result = await deletion.execute(preview.value.token)

    // Everything the preview named: the project, the one transcript, its store directory, the rollout.
    expect(result).toEqual({ ok: true, value: { deletedPaths: 4, leftoverCount: 0 } })
    expect(existsSync(projectPath)).toBe(false)
    expect(existsSync(store)).toBe(false)
    expect(existsSync(rollout)).toBe(false)
    expect(existsSync(foreign)).toBe(true)
    // A shared append-only file of another application: an orphaned name in it is harmless.
    expect(readFileSync(sessionIndexFile).equals(indexBefore)).toBe(true)
    expect(invalidations()).toBe(1)
  })

  it('spends the token, so the same preview cannot delete twice', async () => {
    const { categoryRoot, category, deletion } = harness()
    seedProject(categoryRoot, 'Foo')

    const preview = await deletion.preview(category, 'Foo')
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    expect((await deletion.execute(preview.value.token)).ok).toBe(true)

    const again = await deletion.execute(preview.value.token)
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.code).toBe('preview-expired')
  })

  it('refuses a token it never issued', async () => {
    const { deletion } = harness()

    const result = await deletion.execute('11111111-1111-4111-8111-111111111111')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('preview-expired')
  })

  it('refuses a token whose preview has expired', async () => {
    const { categoryRoot, category, deletion } = harness()
    const projectPath = seedProject(categoryRoot, 'Foo')

    const preview = await deletion.preview(category, 'Foo')
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    vi.useFakeTimers()
    vi.setSystemTime(preview.value.expiresAt + 1)
    const result = await deletion.execute(preview.value.token)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('preview-expired')
    expect(existsSync(projectPath)).toBe(true)
  })

  // Cancelling a preview is the ordinary outcome, so an abandoned one must not be held for the
  // lifetime of the process along with everything it enumerated.
  it('drops an expired preview nobody confirmed when the next preview is taken', async () => {
    const { categoryRoot, claudeHome, category, deletion } = harness()
    const projectPath = seedProject(categoryRoot, 'Foo')
    seedClaudeStore(claudeHome, projectPath, ['a.jsonl', 'b.jsonl'])
    seedProject(categoryRoot, 'Bar')

    const abandoned = await deletion.preview(category, 'Foo')
    expect(abandoned.ok).toBe(true)
    if (!abandoned.ok) return
    expect(pendingTokens(deletion)).toEqual([abandoned.value.token])
    vi.useFakeTimers()
    vi.setSystemTime(abandoned.value.expiresAt + 1)
    const fresh = await deletion.preview(category, 'Bar')

    expect(fresh.ok).toBe(true)
    if (!fresh.ok) return
    expect(pendingTokens(deletion)).toEqual([fresh.value.token])
    // The token contract is untouched: the fresh preview still deletes what it named.
    expect((await deletion.execute(fresh.value.token)).ok).toBe(true)
  })

  // What the user agreed to delete is a set of paths; a set that moved is a different question.
  it('refuses to delete a set that changed since the preview', async () => {
    const { categoryRoot, claudeHome, category, deletion } = harness()
    const projectPath = seedProject(categoryRoot, 'Foo')
    const store = seedClaudeStore(claudeHome, projectPath, ['a.jsonl'])

    const preview = await deletion.preview(category, 'Foo')
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    seedClaudeStore(claudeHome, projectPath, ['b.jsonl'])
    const result = await deletion.execute(preview.value.token)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('stale-preview')
    expect(existsSync(projectPath)).toBe(true)
    expect(existsSync(join(store, 'a.jsonl'))).toBe(true)
    // The stale token is spent as well: the only way on is a fresh preview.
    const again = await deletion.execute(preview.value.token)
    if (!again.ok) expect(again.code).toBe('preview-expired')
  })

  it('registers a locked file as a leftover and deletes the rest', async () => {
    const { categoryRoot, claudeHome, codexHome, category, deletion, records } = harness({
      remove: async (path) => {
        if (path.endsWith('.jsonl')) throw failing('EBUSY')
        await rm(path, { recursive: true, force: true })
      },
    })
    const projectPath = seedProject(categoryRoot, 'Foo')
    const store = seedClaudeStore(claudeHome, projectPath, ['a.jsonl'])
    const rollout = seedCodexRollout(codexHome, projectPath, idAConst)

    const preview = await deletion.preview(category, 'Foo')
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    const result = await deletion.execute(preview.value.token)

    // The two `.jsonl` paths are held open; the project and the store directory still go.
    expect(result).toEqual({ ok: true, value: { deletedPaths: 2, leftoverCount: 2 } })
    expect(existsSync(projectPath)).toBe(false)
    expect(existsSync(store)).toBe(false)
    expect(existsSync(rollout)).toBe(true)
    expect(records.map((record) => record.kind)).toEqual(['delete', 'delete'])
    expect(records.map((record) => record.path)).toEqual([join(store, 'a.jsonl'), rollout])
  })

  /**
   * Every path the preview named is removed by name. They all sit inside the store directory today,
   * so removing that directory covers them - which is exactly what makes it a trap: the day one does
   * not, the preview promises a file the delete never touches.
   */
  it('removes each transcript the preview named, not only the directory holding them', async () => {
    const removed: string[] = []
    const { categoryRoot, claudeHome, category, deletion } = harness({
      remove: async (path) => {
        removed.push(path)
        await rm(path, { recursive: true, force: true })
      },
    })
    const projectPath = seedProject(categoryRoot, 'Foo')
    const store = seedClaudeStore(claudeHome, projectPath, ['a.jsonl', 'b.jsonl'])

    const preview = await deletion.preview(category, 'Foo')
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    await deletion.execute(preview.value.token)

    for (const named of [preview.value.projectPath, ...preview.value.claude.transcriptFiles])
      expect(removed, named).toContain(named)
    expect(removed.indexOf(join(store, 'a.jsonl'))).toBeLessThan(removed.indexOf(store))
  })

  /**
   * The two subsystems change the same directories from two IPC calls. With a guard each, a delete
   * removes the project while the rename beside it is still carrying that project's history.
   */
  it('refuses a delete while a relocation of the same project is running', async () => {
    const { categoryRoot, claudeHome, category, deletion, guard, messages } = harness()
    const projectPath = seedProject(categoryRoot, 'Foo')
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const lifecycle = new ProjectLifecycle({
      journalsDirectory: join(claudeHome, '..', 'state', 'project-relocations'),
      leftovers: new RelocationLeftovers(
        join(claudeHome, '..', 'state', 'leftovers.json'),
        (message) => messages.push(message),
      ),
      migrators: [],
      guard,
      invalidateAll: () => {},
      forgetRewritten: () => {},
      report: (message) => messages.push(message),
      io: {
        readFile: async () => '',
        writeFile: async () => {},
        rename: async (oldPath, newPath) => {
          await gate
          await rename(oldPath, newPath)
        },
        unlink: async () => {},
        remove: async () => {},
      },
    })

    const preview = await deletion.preview(category, 'Foo')
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    const relocating = lifecycle.relocate(category, 'Foo', 'Bar', 'rename')
    const deleted = await deletion.execute(preview.value.token)
    release()

    expect(deleted.ok).toBe(false)
    if (!deleted.ok) expect(deleted.code).toBe('relocation-in-progress')
    expect((await relocating).ok).toBe(true)
    expect(existsSync(projectPath)).toBe(false)
    expect(existsSync(join(categoryRoot, 'Bar'))).toBe(true)
  })

  it('reports a failure that is not a lock and finishes the rest of the delete', async () => {
    const { categoryRoot, claudeHome, category, deletion, messages, records } = harness({
      remove: async (path) => {
        if (path.endsWith('.jsonl') || path.includes('projects')) throw failing('EACCES')
        await rm(path, { recursive: true, force: true })
      },
    })
    const projectPath = seedProject(categoryRoot, 'Foo')
    seedClaudeStore(claudeHome, projectPath, ['a.jsonl'])

    const preview = await deletion.preview(category, 'Foo')
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    const result = await deletion.execute(preview.value.token)

    expect(result).toEqual({ ok: true, value: { deletedPaths: 1, leftoverCount: 0 } })
    expect(existsSync(projectPath)).toBe(false)
    expect(records).toEqual([])
    expect(messages.some((message) => message.includes('EACCES'))).toBe(true)
  })
})
