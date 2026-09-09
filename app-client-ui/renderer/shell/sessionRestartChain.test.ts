import { describe, expect, it } from 'vitest'

import type {
  SessionInfo,
  SessionsOpResult,
  SessionsSnapshot,
} from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { IpcResult } from '../../shared/appClientUiIpc'
import { SessionsFixtures } from '../sessions/fixtures/sessionsFixtures'
import { SessionRestartChain, type SessionRestartChainPorts } from './sessionRestartChain'

describe('app-client-ui/renderer/shell/sessionRestartChain', () => {
  /** A snapshot of exactly the sessions a test names, over the shape the fixture already builds. */
  function snapshotOf(
    sessions: readonly SessionInfo[],
    reconciled = true,
  ): SessionsSnapshot {
    return { ...SessionsFixtures.mixed(), sessions: [...sessions], reconciled }
  }

  function session(sessionId: string, overrides?: Partial<SessionInfo>): SessionInfo {
    const found = SessionsFixtures.mixed().sessions[0]
    if (found === undefined) throw new Error('the fixture holds no sessions')
    return { ...found, sessionId, life: 'lost', completed: undefined, ...overrides }
  }

  class World {
    snapshot: SessionsSnapshot
    readonly reopened: string[] = []
    readonly published: string[] = []
    readonly errors: string[] = []
    readonly openIds = new Set<string>()
    /** What each reopen answers, by session id; anything unnamed succeeds. */
    readonly answers = new Map<string, SessionsOpResult>()
    /** Runs while the reopen of that session is in flight, to change the world under the chain. */
    onReopen: ((sessionId: string) => void) | null = null
    private listener: (() => void) | null = null
    private clock = 0

    constructor(snapshot: SessionsSnapshot) {
      this.snapshot = snapshot
    }

    ports(): SessionRestartChainPorts {
      return {
        read: () => Promise.resolve({ ok: true as const, value: this.snapshot }),
        subscribe: (onChanged) => {
          this.listener = onChanged
          return () => { this.listener = null }
        },
        reopen: (sessionId) => {
          this.reopened.push(sessionId)
          this.onReopen?.(sessionId)
          const answer = this.answers.get(sessionId) ?? { ok: true as const, value: undefined }
          return Promise.resolve({ ok: true as const, value: answer } as IpcResult<SessionsOpResult>)
        },
        reportError: (message) => { this.errors.push(message) },
        openSessionIds: () => Promise.resolve([...this.openIds]),
        publishSessionRestarted: (sessionId) => {
          this.published.push(sessionId)
          return Promise.resolve()
        },
        now: () => this.clock,
      }
    }

    advance(milliseconds: number): void {
      this.clock += milliseconds
    }

    announce(): void {
      this.listener?.()
    }
  }

  /** Every step of the chain awaits a promise, so settling them is what lets it finish. */
  async function settle(): Promise<void> {
    for (let turn = 0; turn < 40; turn += 1) await Promise.resolve()
  }

  it('restarts every lost and unfinished session, strictly one at a time', async () => {
    const world = new World(snapshotOf([session('a'), session('b'), session('c')]))
    const inFlight: string[] = []
    world.onReopen = (sessionId) => inFlight.push(sessionId)

    new SessionRestartChain(world.ports()).start()
    await settle()

    expect(world.reopened).toEqual(['a', 'b', 'c'])
    // Each one was asked for only after the one before it had answered.
    expect(inFlight).toEqual(['a', 'b', 'c'])
  })

  it('stops the whole chain when the Host cannot be reached, and keeps going on anything else',
    async () => {
      const world = new World(snapshotOf([session('a'), session('b'), session('c')]))
      world.answers.set('a', { ok: false, code: 'invalid-spec', detail: 'nope' })
      world.answers.set('b', { ok: false, code: 'host-unreachable', detail: 'no descriptor' })

      new SessionRestartChain(world.ports()).start()
      await settle()

      expect(world.reopened).toEqual(['a', 'b'])
      expect(world.errors).toHaveLength(1)
      expect(world.errors[0]).toContain('invalid-spec')
    })

  it('waits for the first reconcile the Host answered', async () => {
    const world = new World(snapshotOf([session('a')], false))

    new SessionRestartChain(world.ports()).start()
    await settle()
    expect(world.reopened).toEqual([])

    world.snapshot = snapshotOf([session('a')], true)
    world.announce()
    await settle()
    expect(world.reopened).toEqual(['a'])
  })

  // A Host that falls over in the middle of an afternoon must not make the client start things by
  // itself; from there the button in the panel is the honest way back.
  it('disarms when no reconcile arrives inside its window', async () => {
    const world = new World(snapshotOf([session('a')], false))

    new SessionRestartChain(world.ports()).start()
    await settle()
    world.advance(31_000)
    world.announce()
    await settle()

    world.snapshot = snapshotOf([session('a')], true)
    world.announce()
    await settle()

    expect(world.reopened).toEqual([])
  })

  /**
   * Whether a session may run again is the library's answer, not this chain's: a half-done install,
   * a merge in flight and an installer belonging to another session all reach here as a record that
   * does not admit a restart. The chain adds only its own two axes and the plain-tab rule.
   */
  it('leaves alone what somebody else owns the next move of', async () => {
    const held: Partial<SessionInfo> = { admits: ['newBeside', 'fork'] }
    const world = new World(snapshotOf([
      session('finished', { completed: true }),
      session('running', { life: 'live' }),
      session('installing', {
        ...held,
        setup: { state: 'failed', setupSessionId: 's', commands: [] },
      }),
      session('merging', { ...held, merge: { phase: 'base-merging', startedAt: 1 } }),
      session('installer', { admits: [], setupFor: 'other' }),
      session('resolver', { admits: [], resolveFor: 'other' }),
      // A closed tab is an ended tab, so a plain tab with no panel is not revived.
      session('orphanTab', { presentation: 'tab' }),
      session('ordinary'),
    ]))

    new SessionRestartChain(world.ports()).start()
    await settle()

    expect(world.reopened).toEqual(['ordinary'])
  })

  // A codex session that never named its conversation is exactly this shape, and the chain used to
  // hand it to a reopen the library then refused.
  it('leaves alone a lost session the library says cannot be started again', async () => {
    const world = new World(snapshotOf([
      session('nameless', { admits: ['newBeside'] }),
      session('ordinary'),
    ]))

    new SessionRestartChain(world.ports()).start()
    await settle()

    expect(world.reopened).toEqual(['ordinary'])
  })

  it('restarts a plain tab whose panel is open, and tells it to attach again', async () => {
    const world = new World(snapshotOf([session('t', { presentation: 'tab' })]))
    const chain = new SessionRestartChain(world.ports())
    world.openIds.add('t')

    chain.start()
    await settle()

    expect(world.reopened).toEqual(['t'])
    expect(world.published).toEqual(['t'])
  })

  // A session that came back by itself, or was finished, while the queue was being worked through.
  it('re-checks each session against fresh truth immediately before restarting it', async () => {
    const world = new World(snapshotOf([session('a'), session('b')]))
    world.onReopen = (sessionId) => {
      if (sessionId !== 'a') return
      world.snapshot = snapshotOf([session('a', { life: 'live' }), session('b', { life: 'live' })])
    }

    new SessionRestartChain(world.ports()).start()
    await settle()

    expect(world.reopened).toEqual(['a'])
  })

  it('runs once and no more, whatever else is announced', async () => {
    const world = new World(snapshotOf([session('a')]))

    const chain = new SessionRestartChain(world.ports())
    chain.start()
    await settle()
    world.snapshot = snapshotOf([session('a')])
    world.announce()
    await settle()

    expect(world.reopened).toEqual(['a'])
  })

  it('restarts a session with no tab without anything to tell', async () => {
    const world = new World(snapshotOf([session('a')]))
    const chain = new SessionRestartChain(world.ports())

    chain.start()
    await settle()

    expect(world.reopened).toEqual(['a'])
    expect(world.published).toEqual(['a'])
  })
})
