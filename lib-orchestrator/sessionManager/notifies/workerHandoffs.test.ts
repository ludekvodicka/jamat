import { describe, expect, it } from 'vitest'
import { finishTestRecords } from '../../worktrees/worktreeTesting'
import { WorkerHandoffs } from './workerHandoffs'

const call = (_record: unknown, args: readonly string[]) => WorkerHandoffs.lineOf('node', ['/custom/cli.mjs'], args, 'posix')

describe('WorkerHandoffs', () => {
  it('ignores a removed session during handoff and redelivery', async () => {
    const h = await finishTestRecords()
    const source = new WorkerHandoffs(() => h.records, call)
    await source.conflicts('removed')
    await source.redeliver('removed')
    expect(source.pending()).toEqual([])
  })

  it('persists one worker delivery for two conflicts, including saved paths and exact settlement calls', async () => {
    const h = await finishTestRecords({ syncConflictSet: { readAt: 5, baseRevision: 1, revision: 2, more: 0,
      entries: ['a', 'b'].map((path) => ({ path, kind: 'text', shape: 'text-overlap', state: 'agent', options: ['merged'], facts: {}, saved: `/saved/${path}` })) } })
    const source = new WorkerHandoffs(() => h.records, call)
    await source.conflicts('worker')
    await source.conflicts('worker')
    expect(source.pending()).toHaveLength(1)
    expect(source.pending()[0]).toMatchObject({ sessionId: 'worker' })
    expect(source.pending()[0].text).toContain('2 conflicts wait for the worker')
    expect(source.pending()[0].text).toContain("'sessions' 'resolve-conflict' '--self' '--path' 'b' '--option' 'merged'")
    expect(source.pending()[0].text).toContain('/saved/a')
    const reloaded = new WorkerHandoffs(() => null, call)
    expect(reloaded.pending()).toEqual([])
    const loaded = await h.reload()
    expect(new WorkerHandoffs(() => loaded, call).pending()).toEqual(source.pending())
  })

  it('retains permission-prompt refusals for the shared notifier retry and settles only the current id', async () => {
    const h = await finishTestRecords()
    const source = new WorkerHandoffs(() => h.records, call)
    await source.enqueue('worker', 'one', 'Repair')
    const id = source.pending()[0].id
    await source.note([id], 'attempted', 5)
    expect(source.pending()[0].attempts).toBe(1)
    await source.enqueue('worker', 'two', 'Repair next')
    await source.note([id], 'delivered', 7)
    expect(source.pending()).toHaveLength(1)
    await source.note([source.pending()[0].id], 'delivered', 8)
    expect(source.pending()).toEqual([])
  })

  it('quotes literal shell metacharacters and names the worker client executable', async () => {
    const path = "weird ' $(touch nope) `literal`.txt"
    const bash = WorkerHandoffs.lineOf('node', ['/custom/cli.mjs'], WorkerHandoffs.settlementArgsOf(path, 'merged'), 'posix')
    expect(bash).toContain("'weird '\\'' $(touch nope) `literal`.txt'")
    expect(bash).toContain("'node' '/custom/cli.mjs'")
    const codex = WorkerHandoffs.lineOf('node.exe', ['/custom/cli.mjs'], WorkerHandoffs.settlementArgsOf(path, 'merged'), 'powershell')
    expect(codex).toContain("& 'node.exe' '/custom/cli.mjs'")
    expect(codex).toContain("'weird '' $(touch nope) `literal`.txt'")
  })

  it('names the kind of a path that holds a text and a property conflict (UA1-J05-1)', () => {
    expect(WorkerHandoffs.lineOf('node', ['/cli.mjs'], WorkerHandoffs.settlementArgsOf('src/both.txt', 'merged', 'text'), 'posix'))
      .toBe("'node' '/cli.mjs' 'sessions' 'resolve-conflict' '--self' '--path' 'src/both.txt' '--kind' 'text' '--option' 'merged'")
  })

  it('redelivers a current conflict purpose but filters settlement and a later action', async () => {
    const h = await finishTestRecords({ syncConflictSet: { readAt: 5, baseRevision: 1, revision: 2, more: 0,
      entries: [{ path: 'a', kind: 'text', shape: 'unrecognized', state: 'agent', options: ['merged'], facts: {} }] } })
    const source = new WorkerHandoffs(() => h.records, call)
    await source.conflicts('worker')
    const first = source.pending()[0]
    await source.note([first.id], 'delivered', 10)
    await source.redeliver('worker')
    expect(h.records.get('worker')?.worktreeLifecycle?.handoff?.key).toBe('conflicts:finish:5')
    expect(source.pending()[0].id).not.toBe(first.id)
    await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, step: 'reviewing' } }))
    await source.redeliver('worker')
    expect(source.pending()).toEqual([])
    await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, step: 'worker-resolving', actionId: 'new' } }))
    expect(source.pending()).toEqual([])
  })

  it('ties a resume to its action, so an older resume never holds a later Finish (UA1-J13-1)', async () => {
    const h = await finishTestRecords()
    const source = new WorkerHandoffs(() => h.records, call)
    await source.redeliver('worker')
    const resume = h.records.get('worker')!.worktreeLifecycle!.handoff!
    expect(resume.key).toBe('resume:finish')
    expect(source.pending()).toMatchObject([{ id: resume.id }])
    await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, actionId: 'later' } }))
    expect(source.pending()).toEqual([])
    await source.redeliver('worker')
    expect(h.records.get('worker')?.worktreeLifecycle?.handoff?.key).toBe('resume:later')
    expect(source.pending()).toHaveLength(1)
  })

  // A worker cannot run a command the brief only names (UA1-J14-3): each handoff gives the exact line.
  it('gives the runnable command that reads the current step in a resume', async () => {
    const h = await finishTestRecords()
    const source = new WorkerHandoffs(() => h.records, call)
    await source.redeliver('worker')
    const text = source.pending()[0].text
    expect(text.split('\n')[0]).toBe('Continue the interrupted worktree task in this conversation.')
    expect(text).toContain("'node' '/custom/cli.mjs' 'sessions' 'worktree' '--self'")
  })

  it('gives the retained log and the runnable command that proposes again after failed checks', async () => {
    const h = await finishTestRecords({ phase: 'active', step: undefined, checks: { passed: false, at: 10, logPath: '/logs/full.log', overridden: false, configured: true } })
    const source = new WorkerHandoffs(() => h.records, call)
    await source.checksFailed('worker', 10, '/logs/full.log')
    const handoff = source.pending()[0]
    expect(h.records.get('worker')?.worktreeLifecycle?.handoff?.key).toBe('checks:10')
    expect(handoff.text.split('\n')[0]).toBe('Checks failed. Repair the worktree, then propose it again.')
    expect(handoff.text).toContain('/logs/full.log')
    expect(handoff.text).toContain("'node' '/custom/cli.mjs' 'commit' 'propose' '--self' '--message-file' MESSAGE_FILE")
  })

  it('still hands over a resume and a check failure when this client cannot name its CLI', async () => {
    const h = await finishTestRecords()
    const source = new WorkerHandoffs(() => h.records, () => { throw new Error('The packaged Jamat CLI is missing: X') })
    await source.redeliver('worker')
    expect(source.pending()[0].text).toContain('jamat-v3 sessions worktree --self (this client could not name its Jamat CLI: The packaged Jamat CLI is missing: X)')
  })

  it('names the runnable conflicts listing where a conflict brief points the worker to it', async () => {
    const h = await finishTestRecords({ syncConflictSet: { readAt: 5, baseRevision: 1, revision: 2, more: 3,
      entries: [{ path: 'a', kind: 'text', shape: 'text-overlap', state: 'agent', options: ['merged'], facts: {} }] } })
    const source = new WorkerHandoffs(() => h.records, call)
    await source.conflicts('worker')
    expect(source.pending()[0].text).toContain("'node' '/custom/cli.mjs' 'sessions' 'conflicts' '--self'")
    expect(source.pending()[0].text).not.toMatch(/(^|[^'])sessions conflicts --self/)
  })

  // The worker's launch allows these lines and nothing else, so every line a handoff gives must be one of them (UA1-J14R-2).
  it('gives only command lines its allowed forms cover', async () => {
    const allowed = WorkerHandoffs.linesOf((args) => call(null, args))
    expect(allowed).toEqual(["'node' '/custom/cli.mjs' 'sessions' 'worktree' '--self'", "'node' '/custom/cli.mjs' 'sessions' 'conflicts' '--self'",
      "'node' '/custom/cli.mjs' 'sessions' 'resolve-conflict' '--self'", "'node' '/custom/cli.mjs' 'commit' 'propose' '--self' '--message-file'"])
    const h = await finishTestRecords({ checks: { passed: false, at: 10, logPath: '/logs/full.log', overridden: false, configured: true },
      syncConflictSet: { readAt: 5, baseRevision: 1, revision: 2, more: 3,
        entries: [{ path: 'a b', kind: 'text', shape: 'text-overlap', state: 'agent', options: ['merged'], facts: {} }] } })
    const source = new WorkerHandoffs(() => h.records, call)
    const texts: string[] = []
    await source.conflicts('worker')
    texts.push(h.records.get('worker')!.worktreeLifecycle!.handoff!.text)
    await source.checksFailed('worker', 10, '/logs/full.log')
    texts.push(h.records.get('worker')!.worktreeLifecycle!.handoff!.text)
    await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, handoff: undefined } }))
    await source.redeliver('worker')
    texts.push(h.records.get('worker')!.worktreeLifecycle!.handoff!.text)
    const lines = texts.flatMap((text) => text.split('\n')).flatMap((line) => {
      const at = line.indexOf("'node' '/custom/cli.mjs'")
      return at < 0 ? [] : [line.slice(at)]
    })
    expect(lines.length).toBeGreaterThanOrEqual(4)
    for (const line of lines) expect(allowed.some((form) => line.startsWith(form))).toBe(true)
  })

  it('delivers the configured caller text while retaining the source reason across reload and retry', async () => {
    const h = await finishTestRecords()
    await h.records.update('worker', (record) => ({ ...record, worktree: { ...record.worktree!, caller: { notify: { sessionId: 'caller', text: 'Done' } } } }))
    const source = new WorkerHandoffs(() => h.records, call)
    await source.notifyCaller('worker', 'Worker resumed')
    expect(source.pending()).toMatchObject([{ sessionId: 'caller', text: 'Done' }])
    expect(h.records.get('worker')?.worktreeLifecycle?.workerNotice?.text).toBe('Worker resumed')
    const persisted = new WorkerHandoffs(() => null, call)
    expect(persisted.pending()).toEqual([])
    const loaded = await h.reload()
    expect(new WorkerHandoffs(() => loaded, call).pending()).toMatchObject([{ sessionId: 'caller', text: 'Done' }])
    expect(loaded.get('worker')?.worktreeLifecycle?.workerNotice?.text).toBe('Worker resumed')
    await source.note([source.pending()[0].id], 'attempted', 10)
    expect(source.pending()).toMatchObject([{ text: 'Done', attempts: 1 }])
    await source.note([source.pending()[0].id], 'delivered', 20)
    expect(source.pending()).toEqual([])
  })
})
