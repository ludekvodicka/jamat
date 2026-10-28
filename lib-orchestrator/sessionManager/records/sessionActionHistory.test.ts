import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { SessionWorkflows } from '../lifecycle/sessionWorkflows'
import type { SessionRecord, SessionRecordSvnAction } from './sessionRecord.types'
import { SessionRecordsStore } from './sessionRecordsStore'
import { ScriptLogStore } from '../scripts/scriptLogStore'
import { AtomicJsonFile } from '../../shared/atomicJsonFile'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function record(): SessionRecord {
  return { sessionId: 'session', title: 'Work', kind: 'shell', directory: { mode: 'default' },
    life: 'live', binding: null, createdAt: 0 }
}

function action(actionId: string, startedAt: number, kind: SessionRecordSvnAction['kind'] = 'finish'): SessionRecordSvnAction {
  return { flowVersion: 1, actionId, kind, startedAt, stage: 'recording', stageAt: startedAt + 2,
    root: 'Q:/Work', checks: [], checkCursor: 0, rootCursor: 0, evidence: [],
    rounds: { incoming: 0, outOfDate: 0, lock: 0 }, requestedBy: 'window',
    passes: [{ stage: 'committing', runId: `log-${actionId}`, startedAt, endedAt: startedAt + 1, result: 'done' }] }
}

async function harness() {
  const root = mkdtempSync(join(tmpdir(), 'jamat-action-history-'))
  roots.push(root)
  const file = join(root, 'records.json')
  const reports: string[] = []
  const logs = new ScriptLogStore(join(root, 'logs'))
  const load = () => SessionRecordsStore.load(file, { snapshotsDirectory: join(root, 'snapshots'),
    removeSessionLogs: (id, keepIds) => logs.removeParent(id, keepIds), report: (message) => reports.push(message) })
  return { file, reports, logs, load, store: await load() }
}

describe('durable session actions', () => {
  async function withHistory() {
    const h = await harness()
    await h.store.put({ ...record(), svnAction: action('old', 1), scriptRuns: [{ runId: 'requested', phase: 'inner',
      scriptId: 'requested', name: 'run', title: 'Tests', commands: [], startedAt: 1, endedAt: 2,
      outcome: 'succeeded', log: { state: 'saved', bytes: 5, truncated: false } }] })
    await h.logs.write('session', 'requested', 'hello')
    await h.store.update('session', (current) => ({ ...current, svnAction: undefined }))
    return h
  }

  it('clears completed history while retaining logs during an active commit and running scripts', async () => {
    const h = await withHistory()
    await h.store.update('session', (current) => ({ ...current,
      svnAction: { ...action('active', 3), stage: 'committing', runId: 'active-run' } }))
    await h.store.put({ ...record(), sessionId: 'active-run', life: 'ended',
      scriptOf: { sessionId: 'session', phase: 'after', scriptId: 'svn', name: 'commit' } })
    await h.store.put({ ...record(), sessionId: 'requested', life: 'ended',
      scriptOf: { sessionId: 'session', phase: 'inner', scriptId: 'requested', name: 'run' } })
    await h.store.put({ ...record(), sessionId: 'running',
      scriptOf: { sessionId: 'session', phase: 'inner', scriptId: 'requested', name: 'run' } })
    await h.logs.write('session', 'active-run', 'svn: E155011: out of date')
    await h.logs.write('session', 'running', 'still running')
    expect(await h.store.clearActions('session')).toBe(true)
    expect(h.store.get('session')?.actionHistory).toBeUndefined()
    expect(h.store.get('session')?.scriptRuns).toBeUndefined()
    expect(h.store.get('session')?.svnAction).toMatchObject({ stage: 'committing', runId: 'active-run' })
    expect(h.store.get('requested')?.scriptOf?.historyExpired).toBe(true)
    expect(h.store.get('active-run')?.scriptOf?.historyExpired).toBeUndefined()
    expect(h.store.get('running')?.scriptOf?.historyExpired).toBeUndefined()
    expect(existsSync(h.logs.pathOf('session', 'requested'))).toBe(true)
    expect(existsSync(h.logs.pathOf('session', 'active-run'))).toBe(true)
    expect(existsSync(h.logs.pathOf('session', 'running'))).toBe(true)
    const restarted = await h.load()
    await restarted.update('session', (current) => ({ ...current, title: 'Renamed' }))
    expect(SessionWorkflows.sectionsOf(restarted.get('session')!, (id) => restarted.get(id)).map((section) => section.workflowId)).toEqual(['active'])
  })

  it('keeps Finish cleared while its main-copy update still waits and later completes', async () => {
    const h = await harness()
    await h.store.put({ ...record(), svnAction: { ...action('finished', 1), stage: 'main-update', stageAt: 4 },
      worktreeOutcome: { result: 'nothing', revisions: [], main: 'none', worktree: 'removed', lines: ['Nothing to commit'], at: 4 } })
    expect(SessionWorkflows.sectionsOf(h.store.get('session')!, () => null).map((section) => section.workflowId))
      .toEqual(['finished', 'finished:update-main'])
    expect(await h.store.clearActions('session')).toBe(true)
    await h.store.update('session', (current) => ({ ...current, title: 'Renamed' }))
    const restarted = await h.load()
    expect(SessionWorkflows.sectionsOf(restarted.get('session')!, () => null).map((section) => section.workflowId)).toEqual(['finished:update-main'])
    await restarted.update('session', (current) => ({ ...current, svnAction: undefined }))
    expect(SessionWorkflows.sectionsOf(restarted.get('session')!, () => null).map((section) => section.workflowId)).toEqual(['finished:update-main'])
    expect(await restarted.clearActions('session')).toBe(true)
    const cleared = (await h.load()).get('session')!
    expect(SessionWorkflows.sectionsOf(cleared, () => null)).toEqual([])
    expect(cleared.worktreeOutcome?.at).toBe(4)
  })

  it.each(['starting', 'ended'] as const)('keeps actionable setup logs in the %s state while clearing other history', async (life) => {
    const h = await withHistory()
    await h.store.put({ ...record(), sessionId: 'running',
      scriptOf: { sessionId: 'session', phase: 'inner', scriptId: 'requested', name: 'run' } })
    await h.store.update('session', (current) => ({ ...current, life,
      pendingSetup: { setupSessionId: 'setup-current' },
      scriptRuns: [...current.scriptRuns!, { runId: 'setup-earlier', phase: 'before', scriptId: 'setup', name: 'setup', title: 'Setup',
        commands: [], startedAt: 1, endedAt: 2, outcome: 'failed', log: { state: 'saved', bytes: 5, truncated: false } }] }))
    await h.store.put({ ...record(), sessionId: 'setup-current', life: 'ended',
      scriptOf: { sessionId: 'session', phase: 'before', scriptId: 'setup', name: 'setup' } })
    await h.logs.write('session', 'setup-earlier', 'earlier failure')
    await h.logs.write('session', 'setup-current', 'setup finished')
    expect(await h.store.clearActions('session')).toBe(true)
    const parent = h.store.get('session')!
    expect(parent.scriptRuns?.map((run) => run.runId)).toEqual(['setup-earlier'])
    expect(parent.pendingSetup?.setupSessionId).toBe('setup-current')
    expect(SessionWorkflows.sectionsOf(parent, (id) => h.store.get(id)).map((section) => section.workflowId)).toEqual(['setup:session'])
    expect(h.store.get('setup-current')?.scriptOf?.historyExpired).toBeUndefined()
    expect(existsSync(h.logs.pathOf('session', 'setup-earlier'))).toBe(true)
    expect(existsSync(h.logs.pathOf('session', 'setup-current'))).toBe(true)
    expect(existsSync(h.logs.pathOf('session', 'requested'))).toBe(false)
  })

  it('keeps the history and logs when a Clear write fails', async () => {
    const h = await withHistory()
    const write = vi.spyOn(AtomicJsonFile, 'writeAsync').mockRejectedValueOnce(new Error('disk full'))
    try { expect(await h.store.clearActions('session')).toBe(false) }
    finally { write.mockRestore() }
    expect(h.store.get('session')?.actionHistory).toHaveLength(1)
    expect(h.store.get('session')?.clearedWorkflowIds).toBeUndefined()
    expect(existsSync(h.logs.pathOf('session', 'requested'))).toBe(true)
  })

  it.each(['ended', 'lost'] as const)('clears history and logs in the %s write, then starts a new empty life', async (life) => {
    const h = await withHistory()
    const write = vi.spyOn(AtomicJsonFile, 'writeAsync')
    try {
      await h.store.update('session', (current) => ({ ...current, life }))
      expect(write).toHaveBeenCalledTimes(1)
    } finally { write.mockRestore() }
    const saved = JSON.parse(readFileSync(h.file, 'utf8')).records[0]
    expect(saved.life).toBe(life)
    expect(saved.actionHistory).toBeUndefined()
    expect(saved.scriptRuns).toBeUndefined()
    expect(existsSync(h.logs.pathOf('session', 'requested'))).toBe(false)
    const restarted = await h.load()
    await restarted.update('session', (current) => ({ ...current, life: 'starting' }))
    expect(SessionWorkflows.sectionsOf(restarted.get('session')!, () => null)).toEqual([])
    await restarted.update('session', (current) => ({ ...current, life: 'live', svnAction: action('new', 10) }))
    await restarted.update('session', (current) => ({ ...current, svnAction: undefined }))
    expect(restarted.get('session')?.actionHistory?.map((entry) => entry.key)).toEqual(['new'])
  })

  it('keeps ended-session evidence while UPDATE waits across reload, and deletes it when UPDATE closes', async () => {
    const h = await withHistory()
    await h.store.update('session', (current) => ({ ...current, life: 'ended',
      svnAction: { ...action('finish', 10), stage: 'main-update' } }))
    const restarted = await h.load()
    expect(restarted.get('session')?.actionHistory).toHaveLength(1)
    expect(await h.logs.read('session', 'requested', 100)).toMatchObject({ text: 'hello' })
    await restarted.update('session', (current) => ({ ...current, svnAction: undefined }))
    expect(restarted.get('session')?.actionHistory).toBeUndefined()
    expect(restarted.get('session')?.scriptRuns).toBeUndefined()
    expect(existsSync(h.logs.pathOf('session', 'requested'))).toBe(false)
  })

  it('keeps history and logs when the ending cannot be written', async () => {
    const h = await withHistory()
    const write = vi.spyOn(AtomicJsonFile, 'writeAsync').mockRejectedValueOnce(new Error('disk full'))
    try {
      expect(await h.store.update('session', (current) => ({ ...current, life: 'ended' }))).toBe(false)
    } finally { write.mockRestore() }
    expect(h.store.get('session')?.life).toBe('live')
    expect(h.store.get('session')?.actionHistory).toHaveLength(1)
    expect(existsSync(h.logs.pathOf('session', 'requested'))).toBe(true)
    await h.store.update('session', (current) => ({ ...current, life: 'ended' }))
    expect(existsSync(h.logs.pathOf('session', 'requested'))).toBe(false)
  })

  it('resets only a confirmed reopen, including replay after an app restart, and retains running old logs until their exit', async () => {
    const h = await withHistory()
    await h.store.put({ ...record(), sessionId: 'running', scriptOf: { sessionId: 'session', phase: 'inner', scriptId: 'requested', name: 'run' } })
    await h.logs.write('session', 'running', 'still running')
    const original = h.store.get('session')!
    await h.store.put({ ...original, life: 'starting', pendingOperationKind: 'reopen', pendingOperationId: 'attempt' })
    await h.store.put(original)
    expect(h.store.get('session')?.actionHistory).toHaveLength(1)
    expect(existsSync(h.logs.pathOf('session', 'requested'))).toBe(true)
    await h.store.put({ ...original, life: 'starting', pendingOperationKind: 'reopen', pendingOperationId: 'retry' })
    const restarted = await h.load()
    await restarted.put({ ...restarted.get('session')!, life: 'live', pendingOperationKind: undefined, pendingOperationId: undefined }, { newLifetime: true })
    expect(restarted.get('session')?.actionHistory).toBeUndefined()
    expect(restarted.get('session')?.scriptRuns).toBeUndefined()
    expect(restarted.get('running')?.scriptOf?.historyExpired).toBe(true)
    expect(existsSync(h.logs.pathOf('session', 'requested'))).toBe(false)
    expect(existsSync(h.logs.pathOf('session', 'running'))).toBe(true)
    await restarted.update('running', (current) => ({ ...current, life: 'ended' }))
    expect(existsSync(h.logs.pathOf('session', 'running'))).toBe(false)
  })

  it.each([1, 25])('keeps all %s logs of an SVN action still waiting across a reopen, beyond display limits', async (count) => {
    const h = await withHistory()
    const requested = h.store.get('session')!.scriptRuns![0]
    const passes = Array.from({ length: count }, (_, index) => ({ stage: 'committing' as const, runId: `waiting-${index}`,
      startedAt: 10 + index, endedAt: 11 + index, result: 'done' as const }))
    await h.store.update('session', (current) => ({ ...current, svnAction: { ...action('waiting', 10), stage: 'changes', passes },
      scriptRuns: [...current.scriptRuns!, ...passes.map((pass) => ({ ...requested, ...pass, phase: 'after' as const, scriptId: 'svn' as const }))] }))
    for (const pass of passes) await h.logs.write('session', pass.runId, 'commit output')
    await h.logs.writeBrief('session', 'waiting', 'conflicts')
    await h.store.update('session', (current) => ({ ...current, life: 'starting', pendingOperationKind: 'reopen', pendingOperationId: 'retry' }))
    await h.store.put({ ...h.store.get('session')!, life: 'live', pendingOperationKind: undefined, pendingOperationId: undefined }, { newLifetime: true })
    expect(h.store.get('session')?.actionHistory).toBeUndefined()
    expect(h.store.get('session')?.scriptRuns?.map((run) => run.runId)).toEqual(passes.map((pass) => pass.runId))
    expect(existsSync(h.logs.pathOf('session', 'requested'))).toBe(true)
    for (const pass of passes) expect(existsSync(h.logs.pathOf('session', pass.runId))).toBe(true)
    expect(existsSync(h.logs.briefPathOf('session', 'waiting'))).toBe(true)
  })

  it('defers cleanup for a requested run, then clears both records atomically when its runtime ends', async () => {
    const h = await withHistory()
    await h.store.put({ ...record(), sessionId: 'running', scriptOf: { sessionId: 'session', phase: 'inner', scriptId: 'requested', name: 'run' } })
    await h.store.update('session', (current) => ({ ...current, life: 'ended' }))
    expect(h.store.get('session')?.scriptRuns).toHaveLength(1)
    expect(existsSync(h.logs.pathOf('session', 'requested'))).toBe(true)
    await h.store.update('running', (current) => ({ ...current, life: 'ended' }))
    expect(h.store.get('session')?.scriptRuns).toBeUndefined()
    expect(existsSync(h.logs.pathOf('session', 'requested'))).toBe(false)
  })

  it('removes logs with a removed session and migrates already-ended records from the previous build', async () => {
    const h = await withHistory()
    const legacy = JSON.parse(readFileSync(h.file, 'utf8'))
    await h.store.remove('session')
    expect(existsSync(h.logs.pathOf('session', 'requested'))).toBe(false)
    legacy.records[0].life = 'ended'
    writeFileSync(h.file, JSON.stringify(legacy))
    await h.logs.write('session', 'requested', 'old output')
    const restarted = await h.load()
    expect(restarted.get('session')?.actionHistory).toBeUndefined()
    expect(restarted.get('session')?.scriptRuns).toBeUndefined()
    expect(JSON.parse(readFileSync(h.file, 'utf8')).records[0].scriptRuns).toBeUndefined()
    expect(existsSync(h.logs.pathOf('session', 'requested'))).toBe(false)
  })

  it('appends Finish, Discard and UPDATE, preserves saved-log references, and reloads live history without a count cap', async () => {
    const h = await harness()
    await h.store.put(record())
    for (let index = 1; index <= 15; index++) {
      const kind = index === 2 ? 'discard' : index === 3 ? 'update-main' : 'finish'
      await h.store.update('session', (current) => ({ ...current, svnAction: action(`a${index}`, index * 10, kind) }))
      await h.store.update('session', (current) => ({ ...current, svnAction: undefined }))
    }
    const before = SessionWorkflows.sectionsOf(h.store.get('session')!, () => null)
    expect(before).toHaveLength(15)
    expect(before.slice(0, 3).map((section) => section.kind)).toEqual(['finish', 'discard', 'update-main'])
    expect(before.every((section) => !section.open && section.actions.length === 0)).toBe(true)
    expect(before[0]?.rounds.flatMap((round) => round.steps).some((step) => step.body?.kind === 'log' && step.body.runId === 'log-a1')).toBe(true)
    const restarted = await h.load()
    expect(restarted.get('session')?.life).toBe('live')
    expect(SessionWorkflows.sectionsOf(restarted.get('session')!, () => null)).toEqual(before)
    expect(JSON.parse(readFileSync(h.file, 'utf8')).schemaVersion).toBe(1)
    expect(h.reports).toEqual([])
    await restarted.remove('session')
    expect((await h.load()).get('session')).toBeNull()
  })

  it('separates the finished SVN action from its main-copy wait with no duplicate outcome or old passes', async () => {
    const h = await harness()
    await h.store.put({ ...record(), svnAction: action('finish', 10) })
    await h.store.update('session', (current) => ({ ...current,
      worktreeOutcome: { result: 'nothing', revisions: [], main: 'none', worktree: 'removed', lines: ['Nothing to commit'], at: 20 },
      svnAction: { ...current.svnAction!, stage: 'main-update', stageAt: 20 } }))
    const waiting = SessionWorkflows.sectionsOf(h.store.get('session')!, () => null)
    expect(waiting.map((section) => [section.workflowId, section.kind, section.open])).toEqual([
      ['finish', 'finish', false], ['finish:update-main', 'update-main', true],
    ])
    expect(waiting[1]?.startedAt).toBe(20)
    expect(waiting[1]?.rounds.flatMap((round) => round.steps).some((step) => step.body?.kind === 'log')).toBe(false)
    await h.store.update('session', (current) => ({ ...current, svnAction: { ...current.svnAction!, kind: 'update-main', stage: 'recording',
      passes: [...current.svnAction!.passes!, { stage: 'main-update', startedAt: 20, endedAt: 21, result: 'waited' },
        { stage: 'updating', runId: 'update-log', startedAt: 21, endedAt: 22, result: 'done' }] } }))
    await h.store.update('session', (current) => ({ ...current, svnAction: undefined, completed: true }))
    const ended = SessionWorkflows.sectionsOf((await h.load()).get('session')!, () => null)
    expect(ended).toHaveLength(2)
    expect(ended[1]?.rounds.flatMap((round) => round.steps).some((step) => step.body?.kind === 'log' && step.body.runId === 'update-log')).toBe(true)
  })

  it('retains Git Finish when Keep clears it, then records a new Finish and a separate Discard', async () => {
    const h = await harness()
    await h.store.put({ ...record(), worktreeMerge: { phase: 'base-merging', startedAt: 10, changes: true } })
    await h.store.update('session', (current) => ({ ...current, worktreeMerge: undefined }))
    await h.store.update('session', (current) => ({ ...current, worktreeMerge: { phase: 'base-merging', startedAt: 20 } }))
    await h.store.update('session', (current) => ({ ...current, worktreeMerge: { phase: 'tearing-down', startedAt: 30, discard: true, endedAt: 40,
      runs: [{ phase: 'tearing-down', runId: 'discard-log', startedAt: 30, endedAt: 40 }] } }))
    const sections = SessionWorkflows.sectionsOf((await h.load()).get('session')!, () => null)
    expect(sections.map((section) => section.kind)).toEqual(['git-finish', 'git-finish', 'discard'])
    expect(new Set(sections.map((section) => section.workflowId)).size).toBe(3)
    expect(sections.every((section) => !section.open)).toBe(true)
  })

  it('derives the Finish of a legacy main-update and persists it when the update ends', async () => {
    const h = await harness()
    writeFileSync(h.file, JSON.stringify({ schemaVersion: 1, records: [{ ...record(),
      svnAction: { ...action('legacy', 10), stage: 'main-update', stageAt: 20 } }] }))
    const restored = await h.load()
    expect(SessionWorkflows.sectionsOf(restored.get('session')!, () => null).map((section) => section.kind))
      .toEqual(['finish', 'update-main'])
    await restored.update('session', (current) => ({ ...current, svnAction: undefined }))
    expect(SessionWorkflows.sectionsOf((await h.load()).get('session')!, () => null).map((section) => section.kind))
      .toEqual(['finish', 'update-main'])
  })

  it('derives legacy setup and requested runs, includes live runs once, and leaves a plain legacy session empty', async () => {
    const h = await harness()
    writeFileSync(h.file, JSON.stringify({ schemaVersion: 1, records: [record()] }))
    const legacy = (await h.load()).get('session')!
    expect(SessionWorkflows.sectionsOf(legacy, () => null)).toEqual([])
    legacy.scriptRuns = [{ runId: 'setup', phase: 'before', scriptId: 'setup', name: 'setup', title: 'Setup', startedAt: 1, endedAt: 2,
      commands: [], outcome: 'succeeded', log: { state: 'saved', bytes: 12, truncated: false } },
    { runId: 'requested', phase: 'inner', scriptId: 'requested', name: 'run', title: 'Tests', startedAt: 3, endedAt: 4,
      commands: [], outcome: 'succeeded', log: { state: 'saved', bytes: 20, truncated: false } }]
    expect(SessionWorkflows.sectionsOf(legacy, () => null).map((section) => section.kind)).toEqual(['before', 'script'])
    const running = SessionWorkflows.sectionsOf(record(), () => null, undefined, [{ runId: 'run', phase: 'inner', scriptId: 'requested', name: 'run',
      title: 'Tests', summary: 'Running tests', startedAt: 50, state: 'running', commands: [], row: true, log: 'none' }])
    expect(running).toMatchObject([{ kind: 'script', open: true, startedAt: 50,
      rounds: [{ steps: [{ body: { kind: 'log', runId: 'run' } }] }] }])
  })

  // UA1-J10-10: the card said only "Action ended" after Stop checks and return to work.
  it('says a Finish that went back to work ended so, naming stopped checks', async () => {
    const h = await harness()
    const execution = { root: 'Q:/Work', checks: [], checkCursor: 0, rootCursor: 0, evidence: [], requestedBy: 'window' as const, startedAt: 3 }
    const finishing = (actionId: string, step: 'checking' | 'syncing') => ({ version: 1, actionId, phase: 'finishing' as const, step,
      outOfDate: 0, journal: [], execution, facts: { worker: { liveness: 'alive' as const, resumeFailures: 0 } } })
    const back = (current: SessionRecord): SessionRecord => ({ ...current, worktreeLifecycle: { ...current.worktreeLifecycle!,
      phase: 'active', step: undefined, execution: undefined } })
    await h.store.put({ ...record(), worktreeLifecycle: finishing('checks', 'checking') })
    await h.store.update('session', back)
    await h.store.update('session', (current) => ({ ...current, worktreeLifecycle: finishing('sync', 'syncing') }))
    await h.store.update('session', back)

    const restored = (await h.load()).get('session')!
    expect(SessionWorkflows.sectionsOf(restored, () => null).map((section) => [section.workflowId, section.summary])).toEqual([
      ['checks', 'Checks stopped. The session went back to work.'],
      ['sync', 'Finish stopped. The session went back to work.'],
    ])
  })

  it('drops a damaged history entry without losing the session or its readable entries', async () => {
    const h = await harness()
    await h.store.put({ ...record(), svnAction: action('first', 1) })
    await h.store.update('session', (current) => ({ ...current, svnAction: undefined }))
    const document = JSON.parse(readFileSync(h.file, 'utf8'))
    document.records[0].actionHistory.push({ key: 'bad', startedAt: 5, endedAt: 6, source: { svnAction: { kind: 'future' } } })
    writeFileSync(h.file, JSON.stringify(document))
    const restored = (await h.load()).get('session')!
    expect(restored.actionHistory).toHaveLength(1)
    expect(SessionWorkflows.sectionsOf(restored, () => null)).toHaveLength(1)
    expect(h.reports).toEqual([expect.stringContaining('1 damaged action history')])
  })
})
