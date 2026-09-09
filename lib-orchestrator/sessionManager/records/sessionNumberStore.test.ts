import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { SessionRecord } from './sessionRecord.types'
import { SessionNumberStore } from './sessionNumberStore'

describe('lib-orchestrator/sessionManager/records/sessionNumberStore', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  interface Harness {
    file: string
    projectPath: string
    reports: string[]
    load: () => Promise<SessionNumberStore>
    worktree: (name: string) => void
    counters: () => Record<string, number>
    /** Writes a stored count for this project. The key is the path, which only exists once the
     *  harness has made it, so it cannot be handed in as literal JSON. */
    seed: (counters: Record<string, number>) => void
  }

  function harness(initial?: unknown): Harness {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-session-numbers-'))
    created.push(root)
    const file = join(root, 'session-numbers.json')
    if (initial !== undefined)
      writeFileSync(file, typeof initial === 'string' ? initial : JSON.stringify(initial), 'utf8')
    const projectPath = join(root, 'repo')
    mkdirSync(projectPath, { recursive: true })
    const reports: string[] = []
    return {
      file,
      projectPath,
      reports,
      load: () => SessionNumberStore.load(file, { report: (message) => reports.push(message) }),
      worktree: (name) => mkdirSync(join(projectPath, '.worktrees', name), { recursive: true }),
      counters: () => JSON.parse(readFileSync(file, 'utf8')).counters,
      seed: (counters) =>
        writeFileSync(file, JSON.stringify({ schemaVersion: 1, savedAt: 0, counters }), 'utf8'),
    }
  }

  function record(title: string, projectPath: string): SessionRecord {
    return {
      sessionId: `session-${title}`,
      kind: 'shell',
      title,
      createdAt: 0,
      life: 'ended',
      directory: { mode: 'project', categoryId: 'work', projectName: 'AppJamatV3', projectPath },
      binding: null,
    } as SessionRecord
  }

  it('counts from one and keeps counting', async () => {
    const it_ = harness()
    const store = await it_.load()

    expect(await store.allocate(it_.projectPath, [])).toBe('001')
    expect(await store.allocate(it_.projectPath, [])).toBe('002')
    expect(await store.allocate(it_.projectPath, [])).toBe('003')
  })

  /*
   * The body reads the seed off the disk and only then writes, with an await in between, so two
   * allocations in flight over one project used to read the same seed and hand back the same token.
   * That token becomes a worktree directory name AND a branch name, so the collision is on disk
   * rather than merely alike. Nothing outside serialises them: `SessionManager.number()` is
   * deliberately off the operation queue and `promotePlain` takes one from on it.
   */
  it('hands two concurrent allocations two different numbers', async () => {
    const it_ = harness()
    const store = await it_.load()

    const both = await Promise.all([
      store.allocate(it_.projectPath, []),
      store.allocate(it_.projectPath, []),
    ])

    expect([...both].sort()).toEqual(['001', '002'])
    // And the high-water mark on disk is the second one, not the first written twice.
    expect(Object.values(it_.counters())).toEqual([2])
  })

  it('keeps counting after one allocation in a burst could not be written', async () => {
    const it_ = harness()
    const store = await it_.load()

    const many = await Promise.all(Array.from({ length: 5 }, () =>
      store.allocate(it_.projectPath, [])))

    expect([...many].sort()).toEqual(['001', '002', '003', '004', '005'])
  })

  it('looks without taking, so a card that is opened and abandoned costs nothing', async () => {
    const it_ = harness()
    const store = await it_.load()

    expect(await store.next(it_.projectPath, [])).toBe('001')
    expect(await store.next(it_.projectPath, [])).toBe('001')
    expect(await store.allocate(it_.projectPath, [])).toBe('001')
    expect(await store.next(it_.projectPath, [])).toBe('002')
  })

  /**
   * The point of the whole store: a number names a worktree directory and a branch, so handing the
   * same one out twice would collide on disk rather than merely read alike.
   */
  it('never hands a number back after the session that had it is gone', async () => {
    const it_ = harness()
    const store = await it_.load()
    await store.allocate(it_.projectPath, [])
    await store.allocate(it_.projectPath, [])

    // The session was removed: no record carries 002 any more, and no worktree does either.
    expect(await store.allocate(it_.projectPath, [])).toBe('003')
  })

  it('recovers the count from the worktrees when the counter file is gone', async () => {
    const it_ = harness()
    it_.worktree('044-some-feature')
    it_.worktree('012-older')
    const store = await it_.load()

    expect(await store.next(it_.projectPath, [])).toBe('045')
    expect(await store.allocate(it_.projectPath, [])).toBe('045')
  })

  /*
   * A catalog project pointing at a PACKAGE inside a repository, which is this very tree's layout.
   * `GitWorktreeManager.create` cuts into the repository ROOT, so the seed has to look there: it
   * used to look under the project itself, found nothing, and contributed 0 - silently, because the
   * counter file and the record titles usually cover for it.
   */
  it('counts the worktrees where git actually cuts them, not under the project', async () => {
    const it_ = harness()
    const repositoryRoot = join(it_.projectPath, '..')
    mkdirSync(join(repositoryRoot, '.worktrees', '071-elsewhere'), { recursive: true })
    const store = await SessionNumberStore.load(it_.file, {
      report: () => undefined,
      worktrees: {
        worktreesDirectoryOf: () => Promise.resolve(join(repositoryRoot, '.worktrees')),
      },
    })

    expect(await store.next(it_.projectPath, [])).toBe('072')
  })

  // Asked once for the life of the store: a repository root does not move under a running client.
  it('asks where the worktrees are once per project', async () => {
    const it_ = harness()
    let asked = 0
    const store = await SessionNumberStore.load(it_.file, {
      report: () => undefined,
      worktrees: {
        worktreesDirectoryOf: (projectPath: string) => {
          asked += 1
          return Promise.resolve(join(projectPath, '.worktrees'))
        },
      },
    })

    await store.next(it_.projectPath, [])
    await store.next(it_.projectPath, [])
    await store.allocate(it_.projectPath, [])

    expect(asked).toBe(1)
  })

  it('recovers the count from the record titles, which the token is the prefix of', async () => {
    const it_ = harness()
    const store = await it_.load()
    const records = [record('051 - foo', it_.projectPath), record('007 - bar', it_.projectPath)]

    expect(await store.allocate(it_.projectPath, records)).toBe('052')
  })

  it('recovers the allocated number from the right side of a fork title', async () => {
    const it_ = harness()
    const store = await it_.load()

    expect(await store.allocate(
      it_.projectPath,
      [record('014-015 - forked task', it_.projectPath)],
    )).toBe('016')
  })

  it('reads a bare number as a title, which is what a session with no name is called', async () => {
    const it_ = harness()
    const store = await it_.load()

    expect(await store.allocate(it_.projectPath, [record('077', it_.projectPath)])).toBe('078')
  })

  it('counts each project on its own', async () => {
    const it_ = harness()
    const store = await it_.load()
    const other = join(it_.projectPath, '..', 'other-repo')

    await store.allocate(it_.projectPath, [])
    await store.allocate(it_.projectPath, [])

    expect(await store.allocate(other, [])).toBe('001')
    // Another directory's records are not this one's evidence.
    expect(await store.next(other, [record('090 - elsewhere', it_.projectPath)])).toBe('002')
  })

  /**
   * The whole reason the key is the directory. Two catalog entries over one folder share its
   * `.worktrees/` and its branches, so they must share the count: keying on the catalog name would
   * hand them the same number, and the second worktree would then be refused as one that exists.
   */
  it('counts one directory once, however many catalog entries point at it', async () => {
    const it_ = harness()
    it_.worktree('031-taken')
    const store = await it_.load()

    expect(await store.allocate(it_.projectPath, [])).toBe('032')
    expect(await store.allocate(it_.projectPath, [])).toBe('033')
  })

  /**
   * And once more with the same directory written differently, which is the case the test above
   * cannot see because it passes one string twice. Windows hands the same folder out under several
   * spellings, and a counter keyed on the literal string gave each of them its own count: two
   * sessions with one number, one worktree folder and one branch.
   */
  it('counts one directory once, however it is spelled', async () => {
    const it_ = harness()
    const store = await it_.load()
    const other = `${it_.projectPath.replaceAll('\\', '/').toUpperCase()}/`

    expect(await store.allocate(it_.projectPath, [])).toBe('001')
    expect(await store.allocate(other, [])).toBe('002')
  })

  /**
   * Write-ahead: the file carries the number before the caller does, so a crash on the way to the
   * session that would have used it leaves a hole rather than a number two sessions both think is
   * theirs.
   */
  it('has written the new count before it answers', async () => {
    const it_ = harness()
    const store = await it_.load()

    expect(await store.allocate(it_.projectPath, [])).toBe('001')
    // Stored under the one spelling the lookup uses, which is what keeps two ways of writing the
    // same folder on one count.
    const key = it_.projectPath.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
    expect(it_.counters()).toEqual({ [key]: 1 })
    expect(await (await it_.load()).next(it_.projectPath, [])).toBe('002')
  })

  it('pads to three and grows past them rather than wrapping into a collision', async () => {
    const it_ = harness()
    it_.seed({ [it_.projectPath]: 8 })
    expect(await (await it_.load()).allocate(it_.projectPath, [])).toBe('009')

    const wide = harness()
    wide.seed({ [wide.projectPath]: 999 })
    expect(await (await wide.load()).allocate(wide.projectPath, [])).toBe('1000')
  })

  it('treats a missing file as a project nobody has numbered yet, and latches nothing', async () => {
    const it_ = harness()
    const store = await it_.load()

    expect(store.latched).toBe(false)
    expect(await store.next(it_.projectPath, [])).toBe('001')
    expect(it_.reports).toEqual([])
  })

  /** Incident 2026-06-11: a file that could not be READ is never written over. */
  it('refuses both answers once the file was unreadable, and says so once', async () => {
    const it_ = harness('{ not json')
    const store = await it_.load()

    expect(store.latched).toBe(true)
    expect(await store.next(it_.projectPath, [])).toBeNull()
    expect(await store.allocate(it_.projectPath, [])).toBeNull()
    expect(readFileSync(it_.file, 'utf8')).toBe('{ not json')
    expect(it_.reports.filter((line) => line.includes('for the rest of this session'))).toHaveLength(1)
  })

  it('latches on a schema it does not know rather than counting from zero over it', async () => {
    const it_ = harness({ schemaVersion: 2, counters: {} })
    const store = await it_.load()

    expect(store.latched).toBe(true)
    expect(await store.next(it_.projectPath, [])).toBeNull()
  })

  /**
   * One unusable counter is not a damaged file: the seed rebuilds that project's count from its
   * worktrees and titles, so dropping it costs nothing while latching would cost every project.
   */
  it('drops a counter it cannot read without latching the others', async () => {
    const it_ = harness()
    const other = join(it_.projectPath, '..', 'other-repo')
    it_.seed({ [it_.projectPath]: 'twelve' as unknown as number, [other]: 5 })
    const store = await it_.load()

    expect(store.latched).toBe(false)
    expect(await store.next(it_.projectPath, [])).toBe('001')
    expect(await store.next(other, [])).toBe('006')
  })
})
