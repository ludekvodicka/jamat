import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { SuffixWalk } from './suffixWalk'

describe('lib-orchestrator/terminalDetector/resolve/suffixWalk', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function workspace(files: readonly string[]): string {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-suffix-walk-'))
    created.push(root)
    for (const file of files) {
      const full = join(root, file)
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, 'x', 'utf8')
    }
    return root
  }

  /**
   * This is the last detection tier and it runs in the Electron main process. Read synchronously, it
   * held every window, every IPC answer and every terminal frame for the length of the walk; the
   * bounds cap how many entries are read, not how long that takes. The proof is that a macrotask
   * queued before the walk gets to run while it is walking.
   */
  it('yields to the event loop while it walks, rather than holding the process', async () => {
    const root = workspace(['a/one.md', 'b/two.md', 'c/deep/report.md'])
    let yielded = false
    setImmediate(() => { yielded = true })

    await SuffixWalk.find(root, 'report.md')

    expect(yielded).to.equal(true)
  })

  it('finds a file by its bare name', async () => {
    const root = workspace(['src/deep/report.md'])

    expect(await SuffixWalk.find(root, 'report.md')).to.deep.equal([join(root, 'src', 'deep', 'report.md')])
  })

  it('prefers the longest matching suffix', async () => {
    const root = workspace(['a/report.md', 'src/deep/report.md'])

    expect(await SuffixWalk.find(root, 'deep\\report.md')).to.deep.equal([join(root, 'src', 'deep', 'report.md')])
  })

  it('falls back to the bare filename when the leading segment does not match', async () => {
    const root = workspace(['src/deep/report.md'])

    expect(await SuffixWalk.find(root, 'cut\\report.md')).to.deep.equal([join(root, 'src', 'deep', 'report.md')])
  })

  it('resolves a truncated name through the ellipsis wildcard', async () => {
    const root = workspace(['plans/2026-07-10-001-refactor-plan.md'])

    expect(await SuffixWalk.find(root, '2026-07-10-001-…-plan.md'))
      .to.deep.equal([join(root, 'plans', '2026-07-10-001-refactor-plan.md')])
  })

  it('never walks into an ignored directory', async () => {
    const root = workspace(['node_modules/pkg/report.md', '.git/report.md'])

    expect(await SuffixWalk.find(root, 'report.md')).to.deep.equal([])
  })

  it('stops at the result limit', async () => {
    const root = workspace(Array.from({ length: 12 }, (_, index) => `d${index}/report.md`))

    expect(await SuffixWalk.find(root, 'report.md')).to.have.length(8)
  })

  it('returns nothing for a token with no segments', async () => {
    const root = workspace(['a.md'])

    expect(await SuffixWalk.find(root, '…')).to.deep.equal([])
  })

  it('stops descending at the depth ceiling', async () => {
    const root = workspace(['a/b/c/report.md'])

    expect(await SuffixWalk.find(root, 'report.md', 8, { depthMax: 2, entriesMax: 20_000 })).to.deep.equal([])
    expect(await SuffixWalk.find(root, 'report.md', 8, { depthMax: 3, entriesMax: 20_000 }))
      .to.deep.equal([join(root, 'a', 'b', 'c', 'report.md')])
  })

  it('stops reading at the entry ceiling', async () => {
    const root = workspace([...Array.from({ length: 20 }, (_, index) => `f${index}.txt`), 'zz/report.md'])

    expect(await SuffixWalk.find(root, 'report.md', 8, { depthMax: 12, entriesMax: 5 })).to.deep.equal([])
  })
})
