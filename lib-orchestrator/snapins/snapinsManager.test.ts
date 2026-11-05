import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionsSnapshot } from '../sessionManager/sessionManagerApi.types'
import type { SnapinDefinition } from './shared/snapinContract'
import { SnapinStore } from './shared/snapinStore'
import { SnapinsManager } from './snapinsManager'
import type { SnapinsSettings } from './snapinsApi.types'
import { SnapinTestRig } from './shared/snapinTestFixtures'

describe('SnapinsManager scheduling views', () => {
  let rig: SnapinTestRig
  beforeEach(async () => { rig = await SnapinTestRig.create() })
  afterEach(async () => { await rig.close(); vi.restoreAllMocks() })

  it('keeps identically titled projects in separate groups', async () => {
    await rig.item('one'); await rig.item('two')
    await rig.list()
    const view = await rig.manager.view('test')
    if (!view.ok) throw new Error(view.detail)
    expect(view.value.sections.find((section) => section.kind === 'items')).toMatchObject({ groups: [
      { title: 'Project', items: [{ key: 'one' }] }, { title: 'Project', items: [{ key: 'two' }] },
    ] })
  })

  it('lists a held item without a project, refuses Solve and queued launch, then resolves its configured target', async () => {
    const item = await rig.item('waiting', 'wt')
    const directory = item.projectDirectory
    item.projectDirectory = ''
    item.group = 'Configuration'
    item.hold = 'Choose a project in Settings'
    item.selectable = false
    rig.items.get('test')!.push({ ...item, key: 'cwd-hold', group: 'Existing project', projectDirectory: process.cwd() })
    await rig.list()
    const view = await rig.manager.view('test')
    if (!view.ok) throw new Error(view.detail)
    expect(view.value.state).toBe('idle')
    expect(view.value.sections.find(section => section.kind === 'items')).toMatchObject({ groups: [
      { title: 'Configuration', items: [{ key: item.key, state: 'held', hold: item.hold, selectable: false }] },
      { title: 'Existing project', items: [{ key: 'cwd-hold', state: 'held', selectable: false }] },
    ] })
    expect(rig.report).not.toHaveBeenCalled()
    await rig.press('solveAll')
    await rig.press('solveSelected', [item.key])
    expect(rig.store().current.queue).toEqual([])
    expect(rig.store().current.attempts).toEqual([])
    expect(rig.definitions[0]!.launchSpec).not.toHaveBeenCalled()
    expect(rig.sessions.createSession).not.toHaveBeenCalled()

    await rig.store().update(doc => ({ ...doc, queue: [{ itemKey: item.key, addedAt: rig.now }] }))
    await rig.tick()
    expect(rig.store().current.queue).toEqual([{ itemKey: item.key, addedAt: rig.now }])
    expect(rig.store().current.attempts).toEqual([])
    expect(rig.definitions[0]!.launchSpec).not.toHaveBeenCalled()
    expect(rig.sessions.createSession).not.toHaveBeenCalled()

    const alias = join(rig.root, 'configured-alias')
    await symlink(directory, alias, 'junction')
    item.projectDirectory = alias
    delete item.hold
    item.selectable = true
    rig.now += 10_000
    await rig.list()
    expect(rig.sessions.createSession).toHaveBeenCalledOnce()
    expect(rig.definitions[0]!.launchSpec).toHaveBeenCalledOnce()
    expect(vi.mocked(rig.definitions[0]!.launchSpec).mock.calls[0]![2].projectDirectory).toBe(await realpath(directory))
    expect(rig.store().current.queue).toEqual([])
    expect(rig.store().current.attempts).toMatchObject([{ itemKey: item.key, projectDirectory: await realpath(directory) }])
    expect(rig.report).not.toHaveBeenCalled()
  })

  it.each([
    { hold: undefined, selectable: true },
    { hold: 'Choose a project', selectable: true },
    { hold: undefined, selectable: false },
  ])('refuses an empty project unless both held and nonselectable: %o', async flags => {
    const item = await rig.item('invalid', 'wt')
    Object.assign(item, flags, { projectDirectory: '' })
    await rig.list()
    const view = await rig.manager.view('test')
    if (!view.ok) throw new Error(view.detail)
    expect(view.value.state).toBe('unavailable')
    expect(view.value.sections.find(section => section.kind === 'items')).toMatchObject({ groups: [] })
    expect(rig.report).toHaveBeenCalledOnce()
    expect(rig.report).toHaveBeenCalledWith(expect.stringContaining('realpath'))
    await rig.press('solveAll')
    expect(rig.store().current.queue).toEqual([])
    expect(rig.sessions.createSession).not.toHaveBeenCalled()
  })

  it.each(['solveAll', 'solveSelected'])('keeps completed keys ineligible through %s and admits a new key', async action => {
    const first = await rig.item(`main:records.commit:${'a'.repeat(64)}`, 'wt', 'test', rig.root)
    await rig.list()
    await rig.press('solveSelected', [first.key])
    expect(rig.sessions.createSession).toHaveBeenCalledOnce()
    const session = rig.snapshot.sessions[0]!
    session.life = 'ended'
    session.worktreeView = { version: 1, phase: 'landed', outOfDate: 0, conflicts: 0, summary: '' }
    vi.mocked(rig.definitions[0]!.evidence).mockResolvedValueOnce({ published: true, detail: 'landed' })
    await rig.tick()
    expect(rig.store().current.attempts[0]?.phase).toBe('completed')

    rig.now += 30_000
    await rig.list()
    const view = await rig.manager.view('test')
    if (!view.ok) throw new Error(view.detail)
    expect(view.value.sections.find(section => section.kind === 'items')).toMatchObject({ groups: [
      { items: [{ key: first.key, state: 'done', selectable: false }] },
    ] })
    expect(await rig.press('restart', [first.key])).toMatchObject({ ok: false, code: 'invalid-items' })
    await rig.press(action, [first.key])
    expect(rig.sessions.createSession).toHaveBeenCalledOnce()
    expect(rig.store().current.queue).toEqual([])

    await rig.store().update(doc => ({ ...doc, queue: [{ itemKey: first.key, addedAt: rig.now }] }))
    await rig.tick()
    expect(rig.sessions.createSession).toHaveBeenCalledOnce()
    expect(rig.store().current.queue).toEqual([])

    const fresh = await rig.item(`main:records.commit:${'b'.repeat(64)}`, 'wt', 'test', rig.root)
    rig.now += 30_000
    await rig.list()
    const freshView = await rig.manager.view('test')
    if (!freshView.ok) throw new Error(freshView.detail)
    const rows = freshView.value.sections.flatMap(section => section.kind === 'items' ? section.groups.flatMap(group => group.items) : [])
    expect(rows.find(row => row.key === fresh.key)).toMatchObject({ state: 'ready', selectable: true })
    await rig.press(action, [fresh.key])
    expect(rig.sessions.createSession).toHaveBeenCalledTimes(2)
    expect(rig.store().current.attempts.map(attempt => attempt.itemKey)).toEqual([first.key, fresh.key])
  })

  it('opens the newest worker and returns distinct missing/broker refusals', async () => {
    await rig.item('one'); await rig.list()
    expect(await rig.press('openWorker', ['one'])).toMatchObject({ ok: false, code: 'no-session' })
    await rig.press('solveSelected', ['one'])
    expect(await rig.press('openWorker', ['one'])).toMatchObject({ ok: true })
    expect(rig.sessions.openTerminal).toHaveBeenCalledWith(rig.store().current.attempts[0]?.sessionId)
    vi.mocked(rig.sessions.openTerminal).mockResolvedValueOnce({ error: 'window gone' })
    expect(await rig.press('openWorker', ['one'])).toMatchObject({ ok: false, code: 'tab-unavailable', detail: 'window gone' })
  })

  it('waits for a fresh kind-settings listing while preserving the ten-second throttle', async () => {
    const item = await rig.item('one', 'wc')
    await rig.list()
    rig.settings.kinds.test = { modes: { [item.projectDirectory]: 'wt' } }
    item.mode = 'wt'
    await rig.press('solveSelected', ['one'])
    expect(rig.sessions.createSession).not.toHaveBeenCalled()
    expect(rig.definitions[0]!.list).toHaveBeenCalledOnce()
    rig.now += 10_000
    await rig.tick()
    expect(rig.store().current.attempts[0]?.mode).toBe('wt')
    expect(rig.sessions.createSession).toHaveBeenCalledOnce()
  })

  it('holds on a foreign junction alias and retries unavailable foreign directories', async () => {
    const item = await rig.item('one')
    const foreign = SnapinTestRig.session('foreign')
    const alias = join(rig.root, 'alias')
    await symlink(item.projectDirectory, alias, 'junction')
    foreign.directory = { mode: 'adHoc', path: alias }
    rig.snapshot.sessions.push(foreign)
    await rig.list(); await rig.press('solveSelected', ['one'])
    expect(rig.sessions.createSession).not.toHaveBeenCalled()
    expect(JSON.stringify(await rig.manager.view('test'))).toContain('session Worker works here')
    foreign.directory = { mode: 'adHoc', path: join(rig.root, 'unavailable') }
    await rig.tick()
    expect(rig.report).toHaveBeenCalled()
    expect(rig.manager['timer']).not.toBeNull()
    expect(rig.sessions.createSession).not.toHaveBeenCalled()
    await mkdir(foreign.directory.path)
    await rig.tick()
    expect(rig.sessions.createSession).toHaveBeenCalledOnce()
  })

  it.each([['release', 'restart'], ['restart', 'release']])('applies %s then %s without resurrecting a released lease', async (first, second) => {
    const item = await rig.item('one')
    await rig.attempt({ phase: 'ended', endedReason: 'ended-without-result', projectDirectory: item.projectDirectory })
    await rig.list()
    vi.mocked(rig.sessions.createSession).mockResolvedValue({ ok: false, code: 'invalid-spec', detail: 'x' })
    await Promise.all([rig.manager.press('test', `shared.${first}`, ['one']), rig.manager.press('test', `shared.${second}`, ['one'])])
    await rig.tick()
    expect(rig.store().current.attempts.some((a) => a.leaseHeld)).toBe(false)
    expect(rig.store().current.attempts[1]).toMatchObject({ endedReason: 'create-refused:invalid-spec' })
    expect(rig.store().current.attempts[1]?.leaseFrom).toBeUndefined()
  })

  it('names a live older lease holder and opens holder and newest separately', async () => {
    await rig.item('one')
    const a = await rig.attempt({ phase: 'ended', sessionId: 'holder' })
    await rig.attempt({ phase: 'completed', sessionId: 'latest', leaseHeld: false, resultsSettled: true })
    rig.snapshot.sessions.push(SnapinTestRig.session('holder', a.attemptId), SnapinTestRig.session('latest', undefined, 'ended'))
    await rig.tick()
    expect(await rig.press('release', ['one'])).toMatchObject({ ok: false, code: 'session-live', detail: expect.stringContaining(a.attemptId.slice(0, 8)) })
    await rig.press('openHolder', ['one']); await rig.press('openWorker', ['one'])
    expect(rig.sessions.openTerminal).toHaveBeenNthCalledWith(1, 'holder')
    expect(rig.sessions.openTerminal).toHaveBeenNthCalledWith(2, 'latest')
  })

  it('applies Release after an awaited settle and logs the stale command once', async () => {
    const a = await rig.attempt({ phase: 'review' })
    await rig.tick()
    let finish!: () => void
    vi.mocked(rig.definitions[0]!.evidence).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { finish = resolve })
      return { published: true, detail: 'published' }
    })
    rig.now += 30_000
    const ticking = rig.tick()
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    expect(await rig.manager.press('test', 'shared.release', [a.itemKey])).toMatchObject({ ok: true })
    finish(); await ticking
    expect(rig.store().current.attempts[0]).toMatchObject({ phase: 'completed', leaseHeld: false })
    expect((await rig.manager['kinds'].get('test')!.log.read()).filter((line) => line.text.includes('Release no longer applies'))).toHaveLength(1)
  })

  it('refuses live Release and allows it after the session ends', async () => {
    const a = await rig.attempt()
    const session = SnapinTestRig.session('worker', a.attemptId)
    rig.snapshot.sessions.push(session)
    await rig.tick()
    expect(await rig.press('release', ['one'])).toMatchObject({ ok: false, code: 'session-live' })
    session.life = 'ended'
    expect(await rig.press('release', ['one'])).toMatchObject({ ok: true })
    expect(rig.store().current.attempts[0]).toMatchObject({ phase: 'ended', endedReason: 'released', leaseHeld: false })
  })

  it('returns a refused replacement lease to its predecessor and reads that holder on the next Restart', async () => {
    const item = await rig.item('one')
    const a = await rig.attempt({ phase: 'ended', projectDirectory: item.projectDirectory })
    await rig.list()
    vi.mocked(rig.sessions.createSession).mockResolvedValue({ ok: false, code: 'invalid-spec', detail: 'x' })
    await rig.press('restart', ['one'])
    expect(rig.store().current.attempts[0]?.leaseHeld).toBe(true)
    await rig.press('restart', ['one'])
    expect(rig.store().current.attempts[2]?.leaseFrom).toBe(a.attemptId)
    expect(rig.store().current.attempts[0]?.leaseHeld).toBe(true)
    await rig.press('release', ['one'])
    expect(rig.store().current.attempts.some((attempt) => attempt.leaseHeld)).toBe(false)
  })

  it('keeps an older WC holder visible after a WT Restart completes and releases it explicitly', async () => {
    const item = await rig.item('one', 'wt')
    const a = await rig.attempt({ phase: 'ended', mode: 'wc', projectDirectory: item.projectDirectory })
    await rig.list(); await rig.press('restart', ['one'])
    expect(rig.store().current.attempts[1]).toMatchObject({ mode: 'wt', leaseHeld: false })
    expect(rig.store().current.attempts[1]?.leaseFrom).toBeUndefined()
    vi.mocked(rig.definitions[0]!.evidence).mockResolvedValue({ published: true, detail: 'published' })
    await rig.tick()
    expect(rig.store().current.attempts[1]?.phase).toBe('completed')
    expect(JSON.stringify(await rig.manager.view('test'))).toContain(`WC lease held by attempt ${a.attemptId.slice(0, 8)}`)
    await rig.press('release', ['one'])
    expect(rig.store().current.attempts[0]?.leaseHeld).toBe(false)
  })

  it('refuses Restart after the item disappears', async () => {
    await rig.attempt({ phase: 'ended' })
    await rig.tick()
    expect(await rig.press('restart', ['one'])).toMatchObject({ ok: false, code: 'invalid-items' })
  })

  it('reads fresh foreign-session facts after an awaited settle before WC admission', async () => {
    const item = await rig.item('next')
    const a = await rig.attempt({ itemKey: 'old', mode: 'wt', leaseHeld: false })
    rig.snapshot.sessions.push(SnapinTestRig.session('old', a.attemptId))
    await rig.tick()
    await rig.store().update((doc) => ({ ...doc, queue: [{ itemKey: 'next', addedAt: rig.now }] }))
    let finish!: () => void
    vi.mocked(rig.definitions[0]!.evidence).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { finish = resolve })
      return { published: false }
    })
    rig.now += 30_000
    const ticking = rig.tick()
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const foreign = SnapinTestRig.session('foreign')
    foreign.directory = { mode: 'adHoc', path: item.projectDirectory }
    rig.snapshot.sessions.push(foreign)
    finish(); await ticking
    expect(rig.sessions.createSession).not.toHaveBeenCalled()
    expect(JSON.stringify(await rig.manager.view('test'))).toContain('session Worker works here')
  })
})

describe('SnapinsManager', () => {
  let directory: string
  let manager: SnapinsManager
  let now: number
  let snapshot: SessionsSnapshot
  let definition: SnapinDefinition
  let settings: SnapinsSettings
  const changed = vi.fn()
  const report = vi.fn()
  const snapshotRead = vi.fn(() => snapshot)
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'snapins-manager-'))
    now = 100
    snapshot = { revision: 0, reconciled: true, sessions: [], categories: [], orphans: [],
      host: { presence: 'running', hostVersion: null, hostInstanceId: null, liveCount: 0, lastStartError: null } }
    definition = { kind: 'test', title: 'Test', colour: 'cyan', menuOrder: 1,
      settings: { fields: async () => [], validate: () => null },
      list: vi.fn<SnapinDefinition['list']>(async () => ({ ok: true, items: [] })), launchSpec: async () => ({ hold: 'not ready' }),
      evidence: async () => ({ published: false }), solveAllOrder: (items) => items,
      press: async () => ({ ok: false, code: 'unknown-action' }) }
    vi.clearAllMocks()
    settings = { limit: 4, agents: ['claude'], workerPrompts: {}, kinds: {} }
    manager = new SnapinsManager({ directory, definitions: [definition], now: () => now, onChanged: changed, report,
      settings: () => settings,
      ports: { sessions: { snapshot: snapshotRead, versioningMode: () => 'checkpoints', openTerminal: async () => 'missing-session',
        createSession: async () => { throw new Error('must not launch') }, worktreeResults: async () => ({ ok: true, value: { results: [] } }),
        acknowledgeWorktreeResult: async (actionId) => ({ ok: true, value: { actionId } }) },
        svn: { urlOf: async () => ({ ok: true, value: '' }), listAtHead: async () => ({ ok: true, value: [] }),
          changedNames: async () => ({ ok: true, value: [] }) }, projects: { projects: async () => [] } } })
  })
  afterEach(async () => {
    await manager.stop()
    vi.restoreAllMocks()
    await rm(directory, { recursive: true, force: true })
  })

  it('coalesces five wake calls during a tick into exactly one rerun', async () => {
    let release!: () => void
    vi.mocked(definition.list).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve })
      return { ok: true, items: [] }
    })
    await manager.press('test', 'shared.refresh')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    for (let i = 0; i < 5; i++) manager.wake()
    release()
    await vi.waitFor(() => expect(snapshotRead).toHaveBeenCalledTimes(2))
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('keeps the view revision and lists neither on a read nor on a wake', async () => {
    manager.wake()
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1))
    const first = await manager.view('test')
    expect(snapshotRead).toHaveBeenCalledTimes(1)
    manager.wake()
    await vi.waitFor(() => expect(snapshotRead).toHaveBeenCalledTimes(2))
    now += 60_000
    expect(await manager.view('test')).toEqual(first)
    manager.wake()
    await vi.waitFor(() => expect(snapshotRead).toHaveBeenCalledTimes(3))
    expect(changed).toHaveBeenCalledTimes(1)
    expect(definition.list).not.toHaveBeenCalled()
    await manager.press('test', 'shared.refresh')
    await vi.waitFor(() => expect(definition.list).toHaveBeenCalledOnce())
  })

  it('reports a rejected tick and accepts a subsequent wake', async () => {
    snapshotRead.mockImplementationOnce(() => { throw new Error('snapshot failed') })
    manager.wake()
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1))
    manager.wake()
    await vi.waitFor(() => expect(manager.list().kinds[0].state).toBe('unconfigured'))
    expect(report).toHaveBeenCalledTimes(1)
  })

  it('queues commands before reconcile and applies each as one write in arrival order', async () => {
    snapshot.reconciled = false
    const writes = vi.spyOn(SnapinStore.prototype, 'update')
    expect(await manager.press('test', 'shared.refresh')).toMatchObject({ ok: true })
    expect(await manager.press('test', 'shared.refresh')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(changed).toHaveBeenCalled())
    expect(writes).not.toHaveBeenCalled()
    snapshot.reconciled = true
    manager.wake()
    await vi.waitFor(() => expect(writes).toHaveBeenCalledTimes(2))
  })

  it('stops further writes in a kind after the first write refusal', async () => {
    snapshot.reconciled = false
    const writes = vi.spyOn(SnapinStore.prototype, 'update').mockResolvedValue(false)
    await manager.press('test', 'shared.refresh')
    await manager.press('test', 'shared.refresh')
    await vi.waitFor(() => expect(changed).toHaveBeenCalled())
    snapshot.reconciled = true
    manager.wake()
    await vi.waitFor(() => expect(writes).toHaveBeenCalledTimes(1))
    await manager.stop()
    expect(writes).toHaveBeenCalledTimes(1)
  })

  it('returns explicit refusals and prevents all wakes after stop', async () => {
    expect(await manager.view('gone')).toMatchObject({ ok: false, code: 'unknown-kind' })
    expect(await manager.press('test', 'gone')).toMatchObject({ ok: false, code: 'unknown-action' })
    await manager.stop()
    manager.wake()
    expect(snapshotRead).not.toHaveBeenCalled()
    expect(await manager.press('test', 'shared.refresh')).toMatchObject({ ok: false, code: 'stopping' })
  })

  it('offers configured agents only for nonblank templates containing the pass placeholder', async () => {
    manager.wake()
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce())
    settings.workerPrompts.claude = 'work {pass}'
    expect(manager.list().kinds[0].state).toBe('idle')
    settings.workerPrompts.claude = ' '
    expect(manager.list().kinds[0].state).toBe('unconfigured')
    settings.workerPrompts.claude = 'work without a pass'
    expect(manager.list().kinds[0].state).toBe('unconfigured')
  })

  it('keeps the last listing and queue on failure and clears unavailable on recovery', async () => {
    const item = { key: 'one', title: 'One', group: 'Project', mode: 'wt' as const, projectDirectory: directory,
      selectable: true, actions: [], payload: {} }
    vi.mocked(definition.list).mockResolvedValueOnce({ ok: true, items: [item] })
    const state = new SnapinStore(join(directory, 'test'), 'test', { now: () => now, report })
    await state.read()
    await state.update((doc) => ({ ...doc, queue: [{ itemKey: 'one', addedAt: now }] }))
    manager.wake()
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1))
    expect(definition.list).toHaveBeenCalledOnce()
    now += 10_000
    vi.mocked(definition.list).mockResolvedValueOnce({ ok: false, detail: 'source unavailable' })
    await manager.press('test', 'shared.refresh')
    await vi.waitFor(() => expect(manager.list().kinds[0].state).toBe('unavailable'))
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2))
    expect(await manager.view('test')).toMatchObject({ ok: true, value: { sections: [
      { kind: 'notice', text: 'source unavailable' }, { kind: 'items', groups: [{ items: [{ key: 'one' }] }] }, { kind: 'log' },
    ] } })
    const unchanged = new SnapinStore(join(directory, 'test'), 'test', { now: () => now, report })
    expect(await unchanged.read()).toMatchObject({ ok: true, document: { queue: [{ itemKey: 'one' }] } })
    now += 10_000
    vi.mocked(definition.list).mockResolvedValueOnce({ ok: true, items: [item] })
    await manager.press('test', 'shared.refresh')
    await vi.waitFor(() => expect(manager.list().kinds[0].state).toBe('unconfigured'))
  })

  it('waits for an in-flight tick on stop', async () => {
    let release!: () => void
    vi.mocked(definition.list).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve })
      return { ok: true, items: [] }
    })
    await manager.press('test', 'shared.refresh')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    let stopped = false
    const stopping = manager.stop().then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)
    release()
    await stopping
    expect(stopped).toBe(true)
  })
})
