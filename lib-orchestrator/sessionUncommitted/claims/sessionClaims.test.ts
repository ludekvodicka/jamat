import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { SvnPathFacts, SvnPathState } from '../../svn/svnPathStates'
import { SessionClaims } from './sessionClaims'

describe('lib-orchestrator/sessionUncommitted/claims/sessionClaims', () => {
  let root: string
  let cwd: string
  const minute = 60_000
  const t0 = Date.parse('2026-11-26T08:00:00.000Z')

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'jamat-claims-'))
    cwd = join(root, 'project')
    mkdirSync(join(cwd, 'app'), { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function file(relative: string, modifiedAt: number): string {
    const path = join(cwd, relative)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, 'x')
    utimesSync(path, new Date(modifiedAt), new Date(modifiedAt))
    return path
  }

  const facts = (path: string, state: SvnPathState, changedAtMs: number | null = null) =>
    new Map<string, SvnPathFacts>([[path, { state, changedAtMs }]])
  const dirty: SvnPathState = { kind: 'dirty', reason: 'modified' }
  const clean: SvnPathState = { kind: 'clean' }

  it('claims a confirmed edit and the old path of a move, resolving a relative path against the session directory', () => {
    const claims = new SessionClaims({ cwd, root })
    claims.addMutations([
      { path: 'app/a.ts', previousPath: null, createdAt: t0 },
      { path: join(cwd, 'b.ts'), previousPath: join(cwd, 'old.ts'), createdAt: t0 + 1 },
    ])
    expect(claims.all().map((claim) => [claim.path, claim.source])).toEqual([
      [join(cwd, 'app', 'a.ts'), 'tool'], [join(cwd, 'b.ts'), 'tool'], [join(cwd, 'old.ts'), 'tool'],
    ])
  })

  it('takes no claim from a read whose file somebody else changed 10 minutes later', () => {
    file('app/a.ts', t0 + 10 * minute)
    const claims = new SessionClaims({ cwd, root })
    claims.addShellRuns([{ command: 'cat app/a.ts', startedAt: t0, endedAt: t0 + 1_000 }])
    expect(claims.all()).toEqual([])
    expect(claims.shellRuns()).toHaveLength(1)
  })

  it('takes a shell claim for a file written while the naming command ran', () => {
    const path = file('app/a.ts', t0 + 500)
    const claims = new SessionClaims({ cwd, root })
    claims.addShellRuns([{ command: 'sed -i s/x/y/ app/a.ts', startedAt: t0, endedAt: t0 + 1_000 }])
    expect(claims.all()).toEqual([{ path, source: 'shell', lastWriteAt: t0 + 500, settledAt: null }])
  })

  it('takes a status claim only for the session whose run names the directory of the written file', () => {
    const path = file('gen/out.ts', t0 + 500)
    const builder = new SessionClaims({ cwd, root })
    const other = new SessionClaims({ cwd, root })
    builder.addShellRuns([{ command: 'node build.mjs gen/', startedAt: t0, endedAt: t0 + 1_000 }])
    other.addShellRuns([{ command: 'node build.mjs', startedAt: t0, endedAt: t0 + 1_000 }])
    expect(builder.all()).toEqual([])
    const entries = [{ absolutePath: path, nodeKind: 'file' as const }]
    const mtimes = new Map([[path, t0 + 500]])
    builder.observeStatus(root, entries, mtimes)
    other.observeStatus(root, entries, mtimes)
    expect(builder.all()).toEqual([{ path, source: 'status', lastWriteAt: t0 + 500, settledAt: null }])
    expect(other.all()).toEqual([])
  })

  it('ends a claim on a commit a minute after the last write, renews it on a later edit, keeps it on an older commit', () => {
    const path = join(cwd, 'a.ts')
    const claims = new SessionClaims({ cwd, root })
    claims.addMutations([{ path, previousPath: null, createdAt: t0 }])
    expect(claims.settle(facts(path, dirty, t0 - minute), t0 + 2 * minute).map((claim) => claim.path)).toEqual([path])
    expect(claims.settle(facts(path, dirty, t0 + minute), t0 + 2 * minute)).toEqual([])
    expect(claims.open()).toEqual([])
    claims.addMutations([{ path, previousPath: null, createdAt: t0 }])
    expect(claims.open()).toEqual([])
    claims.addMutations([{ path, previousPath: null, createdAt: t0 + 3 * minute }])
    expect(claims.settle(facts(path, dirty, t0 + minute), t0 + 4 * minute).map((claim) => claim.lastWriteAt)).toEqual([t0 + 3 * minute])
  })

  it('keeps a claim whose commit lies within the clock slack of the last write', () => {
    const path = join(cwd, 'a.ts')
    const claims = new SessionClaims({ cwd, root })
    claims.addMutations([{ path, previousPath: null, createdAt: t0 }])
    expect(claims.settle(facts(path, dirty, t0 + 1_000), t0 + minute)).toHaveLength(1)
  })

  it('ends a claim seen clean after the last write and keeps it ended when another session dirties the file', () => {
    const path = join(cwd, 'a.ts')
    const claims = new SessionClaims({ cwd, root })
    claims.addMutations([{ path, previousPath: null, createdAt: t0 }])
    expect(claims.settle(facts(path, clean), t0 - 1)).toEqual([])
    expect(claims.open()).toHaveLength(1)
    expect(claims.settle(facts(path, clean), t0 + minute)).toEqual([])
    expect(claims.open()).toEqual([])
    expect(claims.settle(facts(path, dirty), t0 + 2 * minute)).toEqual([])
  })

  it('changes nothing on an unknown, outside or missing fact', () => {
    const path = join(cwd, 'a.ts')
    const claims = new SessionClaims({ cwd, root })
    claims.addMutations([{ path, previousPath: null, createdAt: t0 }])
    expect(claims.settle(facts(path, { kind: 'unknown', detail: 'busy' }), t0 + minute)).toEqual([])
    expect(claims.settle(facts(path, { kind: 'outside' }), t0 + minute)).toEqual([])
    expect(claims.settle(new Map(), t0 + minute)).toEqual([])
    expect(claims.open()).toHaveLength(1)
  })

  it('keeps each shell run once and only the newest 2,000', () => {
    const claims = new SessionClaims({ cwd, root })
    const runs = Array.from({ length: 2_100 }, (_, index) => ({ command: 'true', startedAt: index, endedAt: index + 1 }))
    claims.addShellRuns(runs)
    claims.addShellRuns(runs.slice(-10))
    expect(claims.shellRuns()).toHaveLength(SessionClaims.maxShellRunsConst)
    expect(claims.shellRuns()[0]!.startedAt).toBe(100)
  })
})
