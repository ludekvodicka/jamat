import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PassLauncher } from './passLauncher'
import { SnapinTestRig } from './snapinTestFixtures'
import { TickGuard } from './tickGuard'

describe('pass launch', () => {
  let rig: SnapinTestRig
  beforeEach(async () => { rig = await SnapinTestRig.create(['test', 'other']) })
  afterEach(async () => { await rig.close(); vi.restoreAllMocks() })

  it('writes identity, brief and pending attempt before the single create and replaces every placeholder', async () => {
    await rig.item('r900', 'wt')
    const order: string[] = []
    const update = rig.store().update.bind(rig.store())
    vi.spyOn(rig.store(), 'update').mockImplementation(async (change) => {
      const current = rig.store().current
      const next = change(current)
      if (next.attempts.length > rig.store().current.attempts.length) {
        const attempt = next.attempts.at(-1)!
        expect(JSON.parse(await readFile(`${rig.pass(attempt)}/brief.json`, 'utf8')).attemptId).toBe(attempt.attemptId)
        order.push('brief-before-pending')
      }
      return update(() => next)
    })
    const launch = rig.definitions[0]!.launchSpec
    vi.mocked(rig.definitions[0]!.launchSpec).mockImplementation(async (...args) => {
      expect(args[3]).toMatch(/^[a-f\d-]{36}$/)
      order.push('spec')
      return { directory: { mode: 'adHoc', path: rig.root }, title: 'Todo', number: 'r900',
        worktreeSlug: args[3].slice(0, 8), work: { kind: 'fixture' } }
    })
    vi.mocked(rig.sessions.createSession).mockImplementation(async (spec, origin) => {
      const attempt = rig.store().current.attempts[0]!
      const brief = JSON.parse(await readFile(`${rig.pass(attempt)}/brief.json`, 'utf8'))
      expect(brief.attemptId).toBe(origin.callerOperationId)
      expect(spec.worktree).toMatchObject({ tag: attempt.attemptId, slug: attempt.attemptId.slice(0, 8) })
      expect(attempt.phase).toBe('pending')
      order.push('create')
      return { ok: true, value: { sessionId: 'worker', tabTitle: 'Todo' } }
    })
    await rig.list(); await rig.press('solveSelected', ['r900'])
    expect(order).toEqual(['spec', 'brief-before-pending', 'create'])
    expect(launch).toHaveBeenCalledOnce()
    expect(rig.presentation.assign).toHaveBeenCalledWith('worker', 'automation')
    expect(PassLauncher.prompt('a {pass} b {pass}', 'C:\\a b')).toBe('a "C:\\a b" b "C:\\a b"')
  })

  it('never creates again after rejection and adopts by callerOperationId on the next tick', async () => {
    await rig.item('one')
    vi.mocked(rig.sessions.createSession).mockRejectedValueOnce(new Error('transport gone'))
    await rig.list(); await rig.press('solveSelected', ['one'])
    const attempt = rig.store().current.attempts[0]!
    expect(attempt.createUndecided).toBe(true)
    rig.snapshot.sessions.push(SnapinTestRig.session('found', attempt.attemptId))
    await rig.tick()
    expect(rig.store().current.attempts[0]).toMatchObject({ sessionId: 'found' })
    expect(rig.presentation.assign).toHaveBeenCalledWith('found', 'automation')
    expect(rig.presentation.setNote).toHaveBeenCalledWith('found', 'Starting')
    expect(rig.store().current.attempts[0]?.createUndecided).toBeUndefined()
    expect(rig.sessions.createSession).toHaveBeenCalledOnce()
  })

  it('captures the granted prompt before a concurrent settings save removes it', async () => {
    await rig.item('one')
    const original = rig.definitions[0]!.launchSpec
    vi.mocked(rig.definitions[0]!.launchSpec).mockImplementationOnce(async (_ctx, _values, item, id) => {
      delete rig.settings.workerPrompts.claude
      return { directory: { mode: 'adHoc', path: item.projectDirectory }, title: item.title, number: item.key,
        worktreeSlug: id.slice(0, 8), work: { kind: 'fixture' } }
    })
    await rig.list(); await rig.press('solveSelected', ['one'])
    expect(original).toHaveBeenCalledOnce()
    expect(rig.sessions.createSession).toHaveBeenCalledOnce()
    expect(vi.mocked(rig.sessions.createSession).mock.calls[0]?.[0].agent?.initialPrompt).toContain('Work "')
    expect(rig.store().current.attempts[0]?.createUndecided).toBeUndefined()
  })

  it('does not create after stop during an awaited launch specification', async () => {
    await rig.item('one')
    let finish!: () => void
    vi.mocked(rig.definitions[0]!.launchSpec).mockImplementationOnce(async (_ctx, _values, item) => {
      await new Promise<void>((resolve) => { finish = resolve })
      return { directory: { mode: 'adHoc', path: item.projectDirectory }, title: item.title, number: item.key, work: { kind: 'fixture' } }
    })
    await rig.list()
    const pressing = rig.press('solveSelected', ['one'])
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const stopping = rig.manager.stop()
    finish(); await pressing; await stopping
    expect(rig.sessions.createSession).not.toHaveBeenCalled()
    expect(rig.store().current.attempts).toEqual([])
  })

  it('binds a recorded refusal and releases an ordinary refusal lease', async () => {
    await rig.item('one'); await rig.item('two')
    vi.mocked(rig.sessions.createSession).mockResolvedValueOnce({ ok: false, code: 'host-unreachable', detail: 'replay', recordedSessionId: 'recorded' })
      .mockResolvedValueOnce({ ok: false, code: 'invalid-spec', detail: 'bad' })
    await rig.list(); await rig.press('solveAll')
    expect(rig.store().current.attempts[0]).toMatchObject({ sessionId: 'recorded', phase: 'pending' })
    expect(rig.store().current.attempts[1]).toMatchObject({ phase: 'ended', endedReason: 'create-refused:invalid-spec', leaseHeld: false })
  })

  it('requeues a setup agreement at the head and approves the exact hash', async () => {
    await rig.item('one', 'wt')
    vi.mocked(rig.sessions.createSession).mockResolvedValueOnce({ ok: false, code: 'setup-not-acknowledged', detail: 'approval', setup: { hash: 'hash', commands: ['setup'] } })
    await rig.list(); await rig.press('solveSelected', ['one'])
    expect(rig.store().current.queue[0]?.setupAgreement).toEqual({ hash: 'hash', commands: ['setup'] })
    const view = await rig.manager.view('test')
    expect(JSON.stringify(view)).toContain('Worktree commands need approval')
    await rig.press('approveSetup', ['one'])
    expect(vi.mocked(rig.sessions.createSession).mock.calls[1]?.[0].acknowledgeSetup).toBe('hash')
  })

  it('dequeues an item its source refuses at launch and keeps it held until the next listing', async () => {
    await rig.item('one')
    vi.mocked(rig.definitions[0]!.launchSpec).mockResolvedValueOnce({ hold: 'not committed' })
    await rig.list(); await rig.press('solveSelected', ['one'])
    expect(rig.store().current.queue).toEqual([])
    expect(JSON.stringify(await rig.manager.view('test'))).toContain('not committed')
    rig.now += 60_000; await rig.tick(); await rig.press('solveSelected', ['one'])
    expect(rig.definitions[0]!.launchSpec).toHaveBeenCalledOnce()
    expect(rig.sessions.createSession).not.toHaveBeenCalled()
    await rig.list(); await rig.press('solveSelected', ['one'])
    expect(rig.definitions[0]!.launchSpec).toHaveBeenCalledTimes(2)
    expect(rig.sessions.createSession).toHaveBeenCalledOnce()
  })

  it('coalesces simultaneous triggers with one slot', async () => {
    rig.settings.limit = 1; await rig.item('one'); await rig.item('two')
    await rig.list()
    await Promise.all([rig.manager.press('test', 'shared.solveSelected', ['one']), rig.manager.press('test', 'shared.solveSelected', ['two'])])
    await rig.tick()
    expect(rig.sessions.createSession).toHaveBeenCalledOnce()
    expect(rig.store().current.queue).toHaveLength(1)
  })

  it('aborts later grants only for the kind whose pending write failed', async () => {
    await rig.item('one'); await rig.item('two'); await rig.item('three', 'wc', 'other')
    await rig.tick()
    await rig.store().update((doc) => ({ ...doc, queue: ['one', 'two'].map((itemKey) => ({ itemKey, addedAt: rig.now })) }))
    await rig.store('other').update((doc) => ({ ...doc, queue: [{ itemKey: 'three', addedAt: rig.now }] }))
    vi.spyOn(rig.store(), 'update').mockResolvedValueOnce(false)
    await rig.tick()
    expect(rig.sessions.createSession).toHaveBeenCalledOnce()
    expect(rig.store('other').current.attempts).toHaveLength(1)
    expect(rig.store().current.attempts).toHaveLength(0)
  })

  it('keeps an answer after a binding write refusal and binds it before the next command', async () => {
    const item = await rig.item('one')
    await rig.tick()
    const store = rig.store()
    const update = store.update.bind(store)
    const writes = vi.spyOn(store, 'update').mockImplementationOnce(update).mockResolvedValueOnce(false)
    const launcher = rig.manager['kinds'].get('test')!.launcher!
    await launcher.launch({ kind: 'test', item, entry: { itemKey: item.key, addedAt: rig.now }, agentId: 'claude' }, new TickGuard(new Map([['test', store]])))
    expect(launcher.hasUnbound).toBe(true)
    expect(store.current.attempts[0]?.sessionId).toBeUndefined()
    writes.mockImplementation(update)
    await rig.press('pause')
    expect(store.current.attempts[0]?.sessionId).toBeDefined()
    expect(launcher.hasUnbound).toBe(false)
    expect(rig.sessions.createSession).toHaveBeenCalledOnce()
  })
})
