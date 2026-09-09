import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ClaudeProjectsLocator } from './claudeProjectsLocator'

// The self-heal rule is about how many times the store is listed, which nothing else can observe.
const passes = vi.hoisted(() => ({
  readdir: 0,
  /** Parks the next walk once it holds its listing: the only point a test can act mid-build. */
  pause: null as { entered: () => void, held: Promise<void> } | null,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readdir: async (path: string) => {
      passes.readdir += 1
      const pause = passes.pause
      passes.pause = null
      const names = await actual.readdir(path)
      if (pause) {
        pause.entered()
        await pause.held
      }
      return names
    },
  }
})

describe('lib-orchestrator/projectManager/providers/claude/claudeProjectsLocator', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
    passes.readdir = 0
    passes.pause = null
  })

  function claudeHome(...storeDirectories: string[]): string {
    const home = mkdtempSync(join(tmpdir(), 'jamat-v3-claude-locator-'))
    created.push(home)
    mkdirSync(join(home, 'projects'), { recursive: true })
    for (const name of storeDirectories) mkdirSync(join(home, 'projects', name))
    return home
  }

  // C1: this table IS the contract. A narrower replacement once hid the history of every project
  // whose path held a '_', a space or a '.', so every one of those characters has a row here.
  it.each([
    ['Q:\\foo bar', 'Q--foo-bar'],
    ['C:\\Projects_Node.Js', 'C--Projects-Node-Js'],
    ['C:/Projects/NodeJs/AppJamatV3', 'C--Projects-NodeJs-AppJamatV3'],
    ['/home/dev/proj-1', '-home-dev-proj-1'],
    ['C:\\Web\\Café', 'C--Web-Caf-'],
    ['plain', 'plain'],
  ])('encodes %s as %s', (folderPath, encoded) => {
    expect(ClaudeProjectsLocator.encodeProjectDir(folderPath)).toBe(encoded)
  })

  it('resolves case-insensitively in one pass over the store', async () => {
    const home = claudeHome('c--projects-alpha')
    const locator = new ClaudeProjectsLocator(home)

    expect(await locator.resolveProjectDir('C:/Projects/Alpha'))
      .toBe(join(home, 'projects', 'c--projects-alpha'))
    expect(passes.readdir).toBe(1)
  })

  it('answers a second hit from the map it already built', async () => {
    const home = claudeHome('C--Projects-Alpha')
    const locator = new ClaudeProjectsLocator(home)

    await locator.resolveProjectDir('C:/Projects/Alpha')
    await locator.resolveProjectDir('C:/Projects/Alpha')
    expect(passes.readdir).toBe(1)
  })

  it('rescans once for a store directory created after the map was built', async () => {
    const home = claudeHome('C--Projects-Alpha')
    const locator = new ClaudeProjectsLocator(home)
    await locator.resolveProjectDir('C:/Projects/Alpha')
    mkdirSync(join(home, 'projects', 'C--Projects-Beta'))
    passes.readdir = 0

    expect(await locator.resolveProjectDir('C:/Projects/Beta'))
      .toBe(join(home, 'projects', 'C--Projects-Beta'))
    expect(passes.readdir).toBe(1)
  })

  it('stops after that one rescan when the project has no store at all', async () => {
    const home = claudeHome('C--Projects-Alpha')
    const locator = new ClaudeProjectsLocator(home)

    expect(await locator.resolveProjectDir('C:/Projects/Missing')).toBeNull()
    expect(passes.readdir).toBe(2)
  })

  function pauseNextWalk(): { entered: Promise<void>, release: () => void } {
    let enter = (): void => {}
    let release = (): void => {}
    const entered = new Promise<void>((resolve) => { enter = resolve })
    const held = new Promise<void>((resolve) => { release = resolve })
    passes.pause = { entered: enter, held }
    return { entered, release }
  }

  it('rebuilds the map after invalidate', async () => {
    const home = claudeHome('C--Projects-Alpha')
    const locator = new ClaudeProjectsLocator(home)
    await locator.resolveProjectDir('C:/Projects/Alpha')
    passes.readdir = 0

    locator.invalidate()
    expect(await locator.resolveProjectDir('C:/Projects/Alpha'))
      .toBe(join(home, 'projects', 'C--Projects-Alpha'))
    expect(passes.readdir).toBe(1)
  })

  /**
   * What the history migrator does: rename the store directory, then invalidate. The listing the
   * walk in flight is holding was taken before that rename, and a stale HIT never self-heals - the
   * miss path is the only one that rescans.
   */
  it('drops a walk an invalidate overtook instead of installing its map', async () => {
    const home = claudeHome('C--Projects-Alpha')
    const locator = new ClaudeProjectsLocator(home)
    const walk = pauseNextWalk()

    const inFlight = locator.resolveProjectDir('C:/Projects/Alpha')
    await walk.entered
    rmSync(join(home, 'projects', 'C--Projects-Alpha'), { recursive: true, force: true })
    locator.invalidate()
    walk.release()

    expect(await inFlight).toBeNull()

    passes.readdir = 0
    expect(await locator.resolveProjectDir('C:/Projects/Alpha')).toBeNull()
    expect(passes.readdir).toBe(1)
  })

  /**
   * What a listing sorted by activity does: resolve every project of a root at once. Most of them
   * have no Claude history, and when each miss dropped the shared map the rescans multiplied by the
   * number of misses - 40 listings of one directory for 28 projects.
   */
  it('lists the store twice for a whole root of misses, not once per miss', async () => {
    const home = claudeHome('C--Projects-Alpha')
    const locator = new ClaudeProjectsLocator(home)

    const resolved = await Promise.all(
      Array.from({ length: 30 }, (_unused, index) =>
        locator.resolveProjectDir(`C:/Projects/Missing${index}`)),
    )

    expect(resolved.every((answer) => answer === null)).toBe(true)
    expect(passes.readdir).toBe(2)
  })

  it('still answers the hits when they arrive alongside a crowd of misses', async () => {
    const home = claudeHome('C--Projects-Alpha')
    const locator = new ClaudeProjectsLocator(home)

    const [alpha, ...misses] = await Promise.all([
      locator.resolveProjectDir('C:/Projects/Alpha'),
      ...Array.from({ length: 10 }, (_unused, index) =>
        locator.resolveProjectDir(`C:/Projects/Missing${index}`)),
    ])

    expect(alpha).toBe(join(home, 'projects', 'C--Projects-Alpha'))
    expect(misses.every((answer) => answer === null)).toBe(true)
  })

  it('builds the map once when several callers ask for it at the same time', async () => {
    const home = claudeHome('C--Projects-Alpha')
    const locator = new ClaudeProjectsLocator(home)

    await Promise.all(Array.from({ length: 5 }, () =>
      locator.resolveProjectDir('C:/Projects/Alpha')))

    expect(passes.readdir).toBe(1)
  })

  it('resolves to null when the store has no projects directory', async () => {
    const home = mkdtempSync(join(tmpdir(), 'jamat-v3-claude-locator-'))
    created.push(home)
    const locator = new ClaudeProjectsLocator(home)

    expect(await locator.resolveProjectDir('C:/Projects/Alpha')).toBeNull()
  })
})
