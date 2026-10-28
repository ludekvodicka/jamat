import { describe, expect, it } from 'vitest'

import type { SessionRecord, SvnActionConflictEntry, SvnActionConflictSet } from '../../sessionManager/worktreeSessionRecords'
import { SvnMergerLauncher } from './svnMergerLauncher'
import type { WorktreeLifecycle } from '../worktreeState'

const cliConst = 'node "C:/Users/ana/.claude/skills/appjamat-v3/scripts/jamat-v3.mjs"'

/** The testbed `diverged` scenario after Jamat's keep-both, as the person gets it. */
const engines: SvnActionConflictEntry = {
  path: '.aidocs/engines', kind: 'tree', shape: 'obstructed-dir', state: 'settled', options: ['keep-both', 'take-incoming', 'keep-mine'],
  rule: 'keep-both', by: 'jamat', settledWith: 'keep-both', saved: 'R:/results/a1/saved/.aidocs/engines',
  facts: { reason: 'unversioned', action: 'added', localKind: 'dir', incomingKind: 'dir', incomingRevision: 2,
    files: { local: 1, incoming: 1, same: 1, differing: 1 } },
}
const brief: SvnActionConflictEntry = {
  path: '.aidocs/engines/t1/brief.md', kind: 'diverged', shape: 'diverged', state: 'person', options: ['merged', 'take-incoming', 'keep-mine'],
  facts: { incomingRevision: 2 }, saved: 'R:/results/a1/saved/.aidocs/engines/t1/brief.md',
}
const catalog: SvnActionConflictEntry = {
  path: 'src/catalog.ts', kind: 'text', shape: 'text-overlap', state: 'person', options: ['merged', 'take-incoming', 'keep-mine'],
  facts: { incomingRevision: 2 },
}
const unsafe: SvnActionConflictEntry = {
  path: 'docs/přehled.md', kind: 'text', shape: 'name-unsafe', state: 'person', options: [], facts: { incomingRevision: 2, unsafe: true },
}
const set = (entries: SvnActionConflictEntry[]): SvnActionConflictSet => ({ readAt: 5, baseRevision: 1, revision: 2, entries, more: 0, waited: true })

describe('lib-orchestrator/sessionManager/lifecycle/svnMergerLauncher', () => {
  it('counts only fresh idle worker time but bounds the merger by wall time without settlement', () => {
    let state: WorktreeLifecycle = { version: 0, actionId: 'a', phase: 'finishing', step: 'worker-resolving', outOfDate: 0, journal: [],
      facts: { worker: { liveness: 'alive', resumeFailures: 0 } }, syncConflictSet: set([brief, catalog]) }
    state.conflictProgress = SvnMergerLauncher.fallback(state, false, 0).progress
    let next = SvnMergerLauncher.fallback(state, false, 20 * 60_000)
    expect(next.action).toBe('wait')
    expect(next.progress.milliseconds).toBe(0)
    state = { ...state, conflictProgress: next.progress, wait: { kind: 'worker-lost', at: 0, reason: 'lost' } }
    next = SvnMergerLauncher.fallback(state, false, 20 * 60_000)
    expect(next.action).toBe('merger')
    state.conflictProgress = next.progress
    next = SvnMergerLauncher.fallback(state, false, 40 * 60_000)
    expect(next.action).toBe('person')
    state.syncConflictSet = { ...set([{ ...brief, state: 'settled' }, catalog]), readAt: 6 }
    expect(SvnMergerLauncher.fallback(state, false, 40 * 60_000)).toMatchObject({ action: 'wait', progress: { owner: 'merger', milliseconds: 0 } })
  })

  it('starts the merger after twenty accumulated fresh idle minutes', () => {
    const state: WorktreeLifecycle = { version: 0, actionId: 'a', phase: 'finishing', step: 'worker-resolving', outOfDate: 0, journal: [],
      facts: { worker: { liveness: 'alive', resumeFailures: 0 } }, syncConflictSet: set([brief]) }
    for (let at = 0; at < 20 * 60_000; at += 5000) {
      const next = SvnMergerLauncher.fallback(state, true, at)
      expect(next.action).toBe('wait')
      state.conflictProgress = next.progress
    }
    expect(SvnMergerLauncher.fallback(state, true, 20 * 60_000).action).toBe('merger')
  })

  it('resets the timer and merger owner for a new action or conflict generation', () => {
    const state: WorktreeLifecycle = { version: 0, actionId: 'a', phase: 'finishing', step: 'worker-resolving', outOfDate: 0, journal: [],
      facts: { worker: { liveness: 'alive', resumeFailures: 0 } }, syncConflictSet: set([brief]),
      wait: { kind: 'worker-lost', at: 0, reason: 'lost' } }
    state.conflictProgress = SvnMergerLauncher.fallback(state, true, 0).progress
    state.wait = undefined
    expect(SvnMergerLauncher.fallback({ ...state, actionId: 'b' }, true, 20 * 60_000)).toMatchObject({ action: 'wait', progress: { owner: 'worker', milliseconds: 0 } })
    expect(SvnMergerLauncher.fallback({ ...state, syncConflictSet: { ...state.syncConflictSet!, revision: 3 } }, true, 20 * 60_000))
      .toMatchObject({ action: 'wait', progress: { owner: 'worker', milliseconds: 0 } })
  })
  it('names both copies of a diverged file and the exact call per path, with what Jamat did and saved', () => {
    const text = SvnMergerLauncher.briefOf({
      title: '014 - trail', root: 'Q:/work/.worktrees/014', set: set([engines, brief, catalog]),
      log: [{ revision: 2, author: 'ana', message: 'Add the t1 trail\nwith its brief' }], cli: cliConst,
    })
    expect(text).toContain('`.aidocs/engines` (tree): Your session added this folder with 1 file; r2 added it with 1 file. 1 file with the same name differs. '
      + "Jamat's rule settled with keep both; what it replaced or moved aside is saved at `R:/results/a1/saved/.aidocs/engines`.")
    expect(text).toContain('Left: brief.md exists on both sides: r2\'s in the working copy, yours at `R:/results/a1/saved/.aidocs/engines/t1/brief.md`. '
      + 'Merge yours into the working-copy file, then settle it as merged.')
    expect(text).toContain(`  ${cliConst} sessions resolve-conflict --self --path .aidocs/engines/t1/brief.md --option merged`)
    expect(text).toContain(`  ${cliConst} sessions resolve-conflict --self --path src/catalog.ts --option merged`)
    expect(text).toContain(`  ${cliConst} sessions resolve-conflict --self --path src/catalog.ts --option take-incoming`)
    // Keep mine drops incoming work: the person's alone.
    expect(text).not.toContain('--option keep-mine')
    expect(text).toContain('  > Add the t1 trail')
    expect(text).toContain('- r2 by ana:')
    expect(text).toContain('Never run svn or svnadmin')
  })

  it('lists a name svn cannot take for the person, with the fix outside Jamat and no call', () => {
    const text = SvnMergerLauncher.briefOf({ title: 't', root: 'Q:/w', set: set([catalog, unsafe]), log: [], cli: cliConst })
    expect(text).toContain('## Left for the person')
    expect(text).toMatch(/- `docs\/přehled\.md` \(text\): svn cannot take this name .* It is fixed outside Jamat, in an SVN client; no call settles it here\./)
    expect(text).not.toContain('--path docs/přehled.md')
    expect(text).not.toContain("--path 'docs/přehled.md'")
    expect(SvnMergerLauncher.forAgent(unsafe)).toBe(false)
    expect(SvnMergerLauncher.forAgent(catalog)).toBe(true)
    expect(SvnMergerLauncher.forAgent({ ...catalog, state: 'settled' })).toBe(false)
  })

  it('quotes a path with a space or a quote for the shell, and leaves a plain one alone', () => {
    expect(SvnMergerLauncher.callOf('jamat', 'src/a b.ts', 'merged')).toBe("jamat sessions resolve-conflict --self --path 'src/a b.ts' --option merged")
    expect(SvnMergerLauncher.callOf('jamat', "it's.ts", 'merged')).toBe("jamat sessions resolve-conflict --self --path 'it'\\''s.ts' --option merged")
    expect(SvnMergerLauncher.callOf('jamat', 'src/x.ts', 'keep-both')).toBe('jamat sessions resolve-conflict --self --path src/x.ts --option keep-both')
  })

  it('names the kind in the call of a path that holds a text and a property conflict (UA1-J05-1)', () => {
    const text: SvnActionConflictEntry = { ...catalog, path: 'src/both.txt' }
    const property: SvnActionConflictEntry = { ...catalog, path: 'src/both.txt', kind: 'property', shape: 'property-value', facts: { incomingRevision: 2, properties: ['jamat:test'] } }
    const brief = SvnMergerLauncher.briefOf({ title: 't', root: 'W:/tree', set: set([text, property, catalog]), log: [], cli: 'jamat' })
    expect(brief).toContain('jamat sessions resolve-conflict --self --path src/both.txt --kind text --option merged')
    expect(brief).toContain('jamat sessions resolve-conflict --self --path src/both.txt --kind property --option take-incoming')
    expect(brief).toContain('jamat sessions resolve-conflict --self --path src/catalog.ts --option merged')
  })

  it('forks the worker\'s Claude conversation that ran in the worktree, interactive with the merger\'s rights', () => {
    const parent = {
      sessionId: 'p', title: 't', agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'n1' }, transcriptCwd: 'Q:/work/.worktrees/014',
    } as SessionRecord
    expect(SvnMergerLauncher.specOf(parent, { root: 'Q:/work/.worktrees/014', briefFile: 'L:/b.md' })).toEqual({
      kind: 'agent', directory: { mode: 'adHoc', path: 'Q:/work/.worktrees/014' }, title: 'Merge conflicts 014',
      agent: { agentId: 'claude', mode: 'fork', forkParentId: 'n1', initialPrompt: SvnMergerLauncher.promptOf('L:/b.md') },
    })
    expect(SvnMergerLauncher.specOf({ ...parent, agent: undefined }, { root: 'Q:/work/.worktrees/014', briefFile: 'L:/b.md' }).agent?.mode).toBe('new')
    expect(SvnMergerLauncher.marksOf('p', 'm1')).toEqual({
      sessionId: 'm1', permission: 'merger', scriptOf: { sessionId: 'p', phase: 'after', scriptId: 'svn-merge', name: 'merger' },
    })
    expect(SvnMergerLauncher.promptOf('L:/b.md')).not.toContain('\n')
  })
})
