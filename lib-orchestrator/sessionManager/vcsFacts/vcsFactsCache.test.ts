import { describe, expect, it } from 'vitest'

import type {
  FileChangesVcsDetection,
  FileChangesVcsId,
  FileChangesVcsResult,
} from '../../fileChangesManager/fileChangesManagerApi.types'
import type { VcsStatusView } from '../../fileChangesManager/vcsStatusView'
import { VcsFactsCache } from './vcsFactsCache'

describe('lib-orchestrator/sessionManager/vcsFacts/vcsFactsCache', () => {
  /**
   * The view seam, scripted: what governs each directory and what each probe answers. It counts
   * both calls, because the point of the class under test is how OFTEN it asks.
   */
  class View {
    readonly detects: string[] = []
    readonly probes: string[] = []
    dirty_ = true
    probeFails = false

    constructor(private readonly governedBy: (cwd: string) => FileChangesVcsId | null) {}

    async detect(cwd: string): Promise<FileChangesVcsDetection | null> {
      this.detects.push(cwd)
      const id = this.governedBy(cwd)
      if (id === null) return null
      return { id, root: cwd, cwd, scopeRelativePath: '.', scopeUrl: null, repositoryPathPrefix: null }
    }

    async dirty(detection: FileChangesVcsDetection): Promise<FileChangesVcsResult<boolean>> {
      this.probes.push(detection.cwd)
      if (this.probeFails) return { ok: false, detail: 'probe failed' }
      return { ok: true, value: this.dirty_ }
    }
  }

  function cacheOf(view: View, start = 1_000): { cache: VcsFactsCache; travel(ms: number): void } {
    let clock = start
    const cache = new VcsFactsCache({
      view: view as unknown as VcsStatusView,
      preferredVcsOf: () => 'git',
      nowOf: () => clock,
    })
    return { cache, travel: (ms) => { clock += ms } }
  }

  const all = (...cwds: string[]): ReadonlySet<string> => new Set(cwds)

  /*
   * The whole saving rests on two sessions of one project producing ONE key: a probe is a child
   * process, and a child process is ~85 ms. `resolve()` unifies separators and nothing else, so
   * `q:\proj` and `Q:\Proj` bought two probes of one directory, and a `markStale` on one did not
   * reach the other.
   */
  it('reads one directory written two Windows ways as one directory', async () => {
    const view = new View(() => 'git')
    const { cache } = cacheOf(view)

    await cache.refresh(all('Q:/Project'))
    expect(view.probes.length).toEqual(1)

    // The same directory, spelled the other way and still inside its window: a second key would
    // have no entry at all and would probe at once.
    await cache.refresh(all('q:\\Project'))

    expect(view.probes.length).toEqual(1)
    expect(cache.factOf('Q:/PROJECT')).to.not.equal(null)

    // And the nudge reaches the entry however the caller spells the directory.
    cache.markStale('q:/project')
    await cache.refresh(all('Q:/Project'))
    expect(view.probes.length).toEqual(2)
  })

  /**
   * The nudge is answered once. It used to answer forever: the flag was re-read after the probe's
   * own await, off the entry the probe had not replaced yet, so the very flag that made this probe
   * run set itself again. `due()` then said true on every pass, and the caller's pass is the visible
   * poll - one child process every two seconds, for a directory nobody had touched since.
   */
  it('re-probes a nudged directory once, not on every pass after it', async () => {
    const view = new View(() => 'git')
    const { cache, travel } = cacheOf(view)
    await cache.refresh(all('/a'))
    expect(view.probes).toEqual(['/a'])

    cache.markStale('/a')
    travel(2_000)
    await cache.refresh(all('/a'))
    expect(view.probes).toEqual(['/a', '/a'])

    // Two more polls inside the git window: the nudge is spent, so nothing is asked again.
    travel(2_000)
    await cache.refresh(all('/a'))
    travel(2_000)
    await cache.refresh(all('/a'))

    expect(view.probes).toEqual(['/a', '/a'])
  })

  /**
   * A probe that fails fails for a reason that does not go away between two ticks - svn missing from
   * PATH, a share that dropped, a locked working copy. Retrying at once measured ten children in
   * twenty seconds for one directory; it waits out its own window like any other measurement.
   */
  it('waits out its window after a failed probe rather than retrying on the next pass', async () => {
    const view = new View(() => 'git')
    const { cache, travel } = cacheOf(view)
    await cache.refresh(all('/a'))
    view.probeFails = true
    travel(30_000)
    await cache.refresh(all('/a'))
    expect(view.probes).toEqual(['/a', '/a'])

    travel(2_000)
    await cache.refresh(all('/a'))
    travel(2_000)
    await cache.refresh(all('/a'))

    expect(view.probes).toEqual(['/a', '/a'])
  })

  /**
   * Keeping the last known answer through a blink is right; keeping it forever is not. A directory
   * measured CLEAN before its probes started failing would carry a clean mark while somebody works
   * in it - and that mark is what the Finish affordance reads before throwing a worktree away.
   */
  it('drops the fact it kept once the probes have failed long enough', async () => {
    const view = new View(() => 'git')
    const { cache, travel } = cacheOf(view)
    view.dirty_ = false
    await cache.refresh(all('/a'))
    expect(cache.factOf('/a')).toEqual({ vcsId: 'git', dirty: false })

    view.probeFails = true
    for (let attempt = 0; attempt < 3; attempt++) {
      travel(30_000)
      await cache.refresh(all('/a'))
      expect(cache.factOf('/a')).toEqual({ vcsId: 'git', dirty: false })
    }

    travel(30_000)
    await cache.refresh(all('/a'))

    expect(cache.factOf('/a')).to.equal(null)
  })

  it('probes each directory once and says nothing moved when nothing changed', async () => {
    const view = new View(() => 'git')
    const { cache } = cacheOf(view)

    expect(await cache.refresh(all('/a', '/b'))).toBe(true)
    expect(view.probes).toEqual(['/a', '/b'])
    expect(cache.factOf('/a')).toEqual({ vcsId: 'git', dirty: true })

    // Immediately again: both are younger than their window, so nothing is asked and nothing moved.
    expect(await cache.refresh(all('/a', '/b'))).toBe(false)
    expect(view.probes).toEqual(['/a', '/b'])
  })

  it('re-probes git after 30 s and svn only after 60 s', async () => {
    const view = new View((cwd) => cwd === '/git' ? 'git' : 'svn')
    const { cache, travel } = cacheOf(view)
    await cache.refresh(all('/git', '/svn'))

    travel(30_000)
    await cache.refresh(all('/git', '/svn'))
    expect(view.probes).toEqual(['/git', '/svn', '/git'])

    travel(30_000)
    await cache.refresh(all('/git', '/svn'))
    expect(view.probes).toEqual(['/git', '/svn', '/git', '/git', '/svn'])
  })

  it('re-probes a nudged directory regardless of its age', async () => {
    const view = new View(() => 'git')
    const { cache } = cacheOf(view)
    await cache.refresh(all('/a'))

    cache.markStale('/a')
    view.dirty_ = false
    expect(await cache.refresh(all('/a'))).toBe(true)
    expect(view.probes).toEqual(['/a', '/a'])
    expect(cache.factOf('/a')).toEqual({ vcsId: 'git', dirty: false })
  })

  it('keeps the last known fact when a probe fails', async () => {
    const view = new View(() => 'git')
    const { cache, travel } = cacheOf(view)
    await cache.refresh(all('/a'))

    view.probeFails = true
    travel(30_000)
    expect(await cache.refresh(all('/a'))).toBe(false)
    expect(cache.factOf('/a')).toEqual({ vcsId: 'git', dirty: true })
  })

  it('forgets a directory nobody stands in any more', async () => {
    const view = new View(() => 'git')
    const { cache } = cacheOf(view)
    await cache.refresh(all('/a', '/b'))

    expect(await cache.refresh(all('/a'))).toBe(true)
    expect(cache.factOf('/b')).toBeNull()
  })

  it('does not re-detect a directory it found no VCS in until the redetect window', async () => {
    const view = new View(() => null)
    const { cache, travel } = cacheOf(view)

    expect(await cache.refresh(all('/plain'))).toBe(false)
    expect(cache.factOf('/plain')).toBeNull()

    travel(300_000)
    await cache.refresh(all('/plain'))
    expect(view.detects).toEqual(['/plain'])

    travel(300_000)
    await cache.refresh(all('/plain'))
    expect(view.detects).toEqual(['/plain', '/plain'])
  })

  it('reuses a detection between probes and re-detects only past the redetect window', async () => {
    const view = new View(() => 'git')
    const { cache, travel } = cacheOf(view)
    await cache.refresh(all('/a'))

    travel(30_000)
    await cache.refresh(all('/a'))
    expect(view.detects).toEqual(['/a'])
    expect(view.probes).toEqual(['/a', '/a'])

    travel(600_000)
    await cache.refresh(all('/a'))
    expect(view.detects).toEqual(['/a', '/a'])
  })

  it('starts nothing while a pass is running', async () => {
    const view = new View(() => 'git')
    const { cache } = cacheOf(view)

    const first = cache.refresh(all('/a'))
    const second = cache.refresh(all('/a'))
    expect(await second).toBe(false)
    await first
    expect(view.probes).toEqual(['/a'])
  })

  it('reports a flip, so an unchanged measurement publishes nothing', async () => {
    const view = new View(() => 'git')
    const { cache, travel } = cacheOf(view)
    await cache.refresh(all('/a'))

    travel(30_000)
    expect(await cache.refresh(all('/a'))).toBe(false)

    view.dirty_ = false
    travel(30_000)
    expect(await cache.refresh(all('/a'))).toBe(true)
  })
})
