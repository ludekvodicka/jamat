import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ChangedPathHint } from '../terminalDetectorApi.types'
import { TerminalPathEvaluator } from './terminalPathEvaluator'

// What the probe actually reached for, which is the only way to prove it never left this machine.
const probes = vi.hoisted(() => ({
  paths: [] as string[],
  /** A path the stat never answers for, so the probe's own budget is the only thing that can end it. */
  hang: null as string | null,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    stat: async (path: string) => {
      probes.paths.push(path)
      if (probes.hang !== null && path === probes.hang) await new Promise(() => undefined)
      return actual.stat(path)
    },
  }
})

describe('lib-orchestrator/terminalDetector/resolve/terminalPathEvaluator', () => {
  const created: string[] = []
  const evaluator = new TerminalPathEvaluator()

  afterEach(() => {
    probes.paths.length = 0
    probes.hang = null
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function workspace(files: readonly string[]): string {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-path-evaluator-'))
    created.push(root)
    for (const file of files) {
      const full = join(root, file)
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, 'x', 'utf8')
    }
    return root
  }

  function context(cwd: string | null, hints: readonly ChangedPathHint[] = []) {
    return { cwd, agentId: null, changedPaths: () => Promise.resolve(hints) }
  }

  /**
   * A candidate is a string a foreign process printed into the terminal, and on Windows a stat of a
   * UNC path is an outbound SMB connect with the user's credentials to the host that text named. The
   * only UNC the probe answers is one the session itself works on, so the host is the user's own
   * rather than one chosen by the output.
   */
  it('never probes a UNC path when the session does not work on that share', async () => {
    const root = workspace(['src/report.md'])

    const resolved = await evaluator.evaluate(['\\\\detector-unreachable-host\\share\\notes.md'], context(root))

    expect(resolved).to.deep.equal([])
    expect(probes.paths).to.deep.equal([])
  })

  /**
   * Without a budget the only bound on a probe is the filesystem's, and a disconnected share or a
   * dead mount holds the menu open and fully disabled for as long as the network takes to give up.
   */
  it('gives up on a probe that never answers, rather than waiting on the filesystem', async () => {
    const root = workspace(['src/report.md'])
    const target = join(root, 'src', 'report.md')
    probes.hang = target

    const resolved = await evaluator.evaluate([target], context(root))

    // Answering at all is the point: without the budget this call never returns. What answers is the
    // tier below, so the probe gave up rather than the whole detection dying with it.
    expect(resolved.map((path) => path.via)).to.not.include('direct')
  })

  it('takes a path the token names outright', async () => {
    const root = workspace(['src/deep/report.md'])
    const target = join(root, 'src', 'deep', 'report.md')

    const resolved = await evaluator.evaluate([target], context(root))

    expect(resolved).to.have.length(1)
    expect(resolved[0]).to.include({ path: target, kind: 'file', via: 'direct' })
  })

  it('reads a directory as a directory', async () => {
    const root = workspace(['src/deep/report.md'])

    const resolved = await evaluator.evaluate([join(root, 'src')], context(root))

    expect(resolved[0]).to.include({ kind: 'directory', via: 'direct' })
  })

  it('resolves a relative token under the working directory', async () => {
    const root = workspace(['src/deep/report.md'])

    const resolved = await evaluator.evaluate(['src/deep/report.md'], context(root))

    expect(resolved[0]).to.include({ path: join(root, 'src', 'deep', 'report.md'), via: 'direct' })
  })

  it('carries the line reference of the token', async () => {
    const root = workspace(['a.md'])

    const resolved = await evaluator.evaluate([`${join(root, 'a.md')}:42:7`], context(root))

    expect(resolved[0]).to.include({ line: 42, column: 7 })
  })

  it('lets the change log answer a token no path names, ahead of walking the project', async () => {
    const root = workspace(['far/away/report.md'])
    const changed = join(root, 'far', 'away', 'report.md')

    const resolved = await evaluator.evaluate(['cut\\report.md'],
      context(root, [{ path: changed }]))

    expect(resolved).to.have.length(1)
    expect(resolved[0]).to.include({ path: changed, via: 'changed' })
  })

  it('prefers the longest suffix the change log matches', async () => {
    const root = workspace(['other/report.md', 'src/deep/report.md'])
    const hints: ChangedPathHint[] = [
      { path: join(root, 'other', 'report.md') },
      { path: join(root, 'src', 'deep', 'report.md') },
    ]

    const resolved = await evaluator.evaluate(['deep\\report.md'], context(root, hints))

    expect(resolved).to.have.length(1)
    expect(resolved[0].path).to.equal(join(root, 'src', 'deep', 'report.md'))
  })

  it('does not offer a change-log hit the agent deleted', async () => {
    const root = workspace(['a.md'])
    const gone = join(root, 'far', 'away', 'report.md')

    const resolved = await evaluator.evaluate(['cut\\report.md'],
      context(root, [{ path: gone }]))

    expect(resolved).to.deep.equal([])
  })

  it('falls through to the walk when every change-log hit is gone', async () => {
    const root = workspace(['src/deep/report.md'])
    const gone = join(root, 'far', 'away', 'report.md')

    const resolved = await evaluator.evaluate(['report.md'],
      context(root, [{ path: gone }]))

    expect(resolved).to.have.length(1)
    expect(resolved[0]).to.include({ path: join(root, 'src', 'deep', 'report.md'), via: 'search' })
  })

  it('walks the project only when the change log knows nothing', async () => {
    const root = workspace(['src/deep/report.md'])

    const resolved = await evaluator.evaluate(['report.md'], context(root))

    expect(resolved).to.have.length(1)
    expect(resolved[0]).to.include({ path: join(root, 'src', 'deep', 'report.md'), via: 'search' })
  })

  it('never walks when a direct hit already answered', async () => {
    const root = workspace(['report.md', 'src/deep/report.md'])
    let asked = 0

    const resolved = await evaluator.evaluate([join(root, 'report.md')], {
      cwd: root,
      agentId: null,
      changedPaths: () => { asked += 1; return Promise.resolve([]) },
    })

    expect(resolved[0].via).to.equal('direct')
    expect(asked).to.equal(0)
  })

  it('finds nothing for a token that names no file anywhere', async () => {
    const root = workspace(['a.md'])

    expect(await evaluator.evaluate(['nothing-like-this.md'], context(root))).to.deep.equal([])
  })

  it('finds nothing without a working directory and a relative token', async () => {
    expect(await evaluator.evaluate(['src/deep/report.md'], context(null))).to.deep.equal([])
  })
})
