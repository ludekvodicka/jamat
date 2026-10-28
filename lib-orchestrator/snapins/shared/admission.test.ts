import { describe, expect, it } from 'vitest'
import { admit, type AdmissionInput, type KindAdmission } from './admission'
import type { AttemptRecord, SnapinItem } from './snapinContract'

const item = (key: string, directory = `Q:/Projects/${key}`, mode: 'wc' | 'wt' = 'wc'): SnapinItem => ({
  key, projectDirectory: directory, mode, title: key, group: key, selectable: true, actions: [], payload: {},
})
const queued = (value: SnapinItem) => ({ item: value, entry: { itemKey: value.key, addedAt: 0 } })
const attempt = (key: string, phase: AttemptRecord['phase'], life: KindAdmission['attempts'][number]['life'] = 'live') => ({
  record: { attemptId: key, itemKey: key, title: key, group: key, mode: 'wc', projectDirectory: `Q:/Projects/${key}`,
    agentId: 'claude', phase, createdAt: 0, appliedThrough: 0, leaseHeld: false } as AttemptRecord, life, setupRunning: false,
})
const kind = (): KindAdmission => ({ kind: 'test', listingAvailable: true, paused: false, queue: [], attempts: [] })
const input = (k = kind()): AdmissionInput => ({ limit: 8, agents: ['claude'], kinds: [k], foreign: [] })

describe('admission', () => {
  it('counts working but not review and counts waiting only with a live session', () => {
    const k = kind(); k.queue = [queued(item('next'))]
    k.attempts = [attempt('a', 'working'), attempt('b', 'review')]
    expect(admit({ ...input(k), limit: 2 }).grants).toHaveLength(1)
    k.attempts = [attempt('a', 'waiting', 'live')]
    expect(admit({ ...input(k), limit: 1 }).grants).toHaveLength(0)
    k.attempts[0]!.life = 'ended'
    expect(admit({ ...input(k), limit: 1 }).grants).toHaveLength(1)
  })
  it('holds an item already in review', () => {
    const k = kind(); k.queue = [queued(item('a'))]; k.attempts = [attempt('a', 'review')]
    expect(admit(input(k)).holds).toEqual([{ itemKey: 'a', hold: 'already running' }])
  })
  it('conflicts parent and child working copies but permits separate projects', () => {
    const k = kind(); k.queue = [queued(item('a', 'Q:/Projects/A')), queued(item('sub', 'Q:/Projects/A/sub'))]
    expect(admit(input(k)).holds[0]?.hold).toBe('working copy busy')
    k.queue[1] = queued(item('b', 'Q:/Projects/B'))
    expect(admit(input(k)).grants).toHaveLength(2)
  })
  it('inherits its own ended lease, holds other items and keeps a lease when mode changes to WT', () => {
    const k = kind(); const prior = attempt('a', 'ended', 'ended'); prior.record.leaseHeld = true
    k.attempts = [prior]; k.queue = [{ ...queued(item('a')), entry: { itemKey: 'a', addedAt: 0, inheritsLeaseFrom: 'a' } }, queued(item('b', prior.record.projectDirectory))]
    expect(admit(input(k)).grants).toHaveLength(1)
    expect(admit(input(k)).holds[0]?.hold).toBe('working copy busy')
    k.queue[0]!.item!.mode = 'wt'
    expect(admit(input(k)).grants[0]?.entry.inheritsLeaseFrom).toBeUndefined()
    expect(admit(input(k)).holds[0]?.hold).toBe('working copy busy')
  })
  it('skips unavailable or paused kinds, drops vanished items and requires setup agreement', () => {
    const a = kind(); a.listingAvailable = false; a.queue = [queued(item('a'))]
    const b = kind(); b.kind = 'b'; b.queue = [queued(item('b'))]
    expect(admit({ ...input(), kinds: [a, b] }).grants.map((g) => g.kind)).toEqual(['b'])
    b.paused = true
    expect(admit({ ...input(), kinds: [a, b] }).grants).toEqual([])
    b.paused = false; b.queue = [{ entry: { itemKey: 'gone', addedAt: 0 }, item: null },
      { ...queued(item('b')), entry: { itemKey: 'b', addedAt: 0, setupAgreement: { hash: 'h', commands: ['setup'] } } }]
    expect(admit(input(b))).toMatchObject({ dropped: ['gone'], holds: [{ itemKey: 'b', hold: 'Worktree commands need approval' }] })
  })
  it('allows three worktree setups and holds the fourth', () => {
    const k = kind(); k.queue = ['a', 'b', 'c', 'd'].map((key) => queued(item(key, 'Q:/A', 'wt')))
    expect(admit(input(k))).toMatchObject({ grants: [{}, {}, {}], holds: [{ itemKey: 'd', hold: 'setup cap' }] })
  })
  it('holds foreign sessions by title until Start anyway', () => {
    const k = kind(); k.queue = [queued(item('a'))]
    const value = { ...input(k), foreign: [{ title: 'Manual work', directory: 'Q:/Projects' }] }
    expect(admit(value).holds[0]?.hold).toBe('session Manual work works here')
    k.queue[0]!.entry.startAnyway = true
    expect(admit(value).grants).toHaveLength(1)
  })
  it('balances counted attempts after every grant with configured-order ties', () => {
    const k = kind(); k.attempts = [attempt('old1', 'working'), attempt('old2', 'working')]
    k.queue = ['a', 'b', 'c'].map((key) => queued(item(key)))
    expect(admit({ ...input(k), limit: 5, agents: ['claude', 'codex'] }).grants.map((g) => g.agentId)).toEqual(['codex', 'codex', 'claude'])
  })
})
